import {
  type ChildProcessWithoutNullStreams,
  execFileSync,
  spawn,
} from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexSupervisor } from "../../src/codex/supervisor.js";
import { CodexGenerationChangedError } from "../../src/codex/transport.js";
import { startFakeResponsesServer } from "../integration/fake-responses-server.js";

async function until(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<number> {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!predicate()) throw new Error("Recovery condition timed out");
  return Date.now() - started;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startProxyChild(dataDir: string, codexBin: string) {
  const dataPort = await availablePort();
  const adminPort = await availablePort();
  const child = spawn(process.execPath, [resolve("dist/main.js")], {
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      DATA_PORT: String(dataPort),
      ADMIN_PORT: String(adminPort),
      CODEX_BIN: codexBin,
      BIFROST_PROXY_TOKEN: "b".repeat(32),
      METRICS_TOKEN: "m".repeat(32),
      TURN_TIMEOUT_MS: "30000",
      TOOL_TIMEOUT_MS: "30000",
      RESPONSE_TTL_MS: "60000",
      FAKE_CODEX_AUTOCOMPLETE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childError = "";
  child.stdout.resume();
  child.stderr.on("data", (chunk: Buffer) => {
    childError += chunk.toString();
  });
  const origin = `http://127.0.0.1:${dataPort}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Proxy child exited during startup (${child.exitCode}): ${childError.slice(-500)}`,
      );
    }
    try {
      if ((await fetch(`${origin}/readyz`)).ok) break;
    } catch {
      // Child is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!(await fetch(`${origin}/readyz`).catch(() => undefined))?.ok) {
    child.kill("SIGKILL");
    throw new Error("Proxy child did not become ready");
  }
  return {
    origin,
    async close() {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("close", resolve)),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await new Promise((resolve) => child.once("close", resolve));
      }
    },
  };
}

async function postResponse(origin: string, body: unknown): Promise<Response> {
  return fetch(`${origin}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${"b".repeat(32)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export async function runRecoveryContract() {
  const directory = mkdtempSync(join(tmpdir(), "proxy-recovery-"));
  const codexHome = join(directory, "codex-home");
  const cwd = join(directory, "work");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const fake = await startFakeResponsesServer();
  writeFileSync(
    join(codexHome, "config.toml"),
    `model_provider = "fixture"\napproval_policy = "never"\nsandbox_mode = "read-only"\n\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "${fake.baseURL}"\nwire_api = "responses"\nrequires_openai_auth = false\n`,
    { mode: 0o600 },
  );
  let child: ChildProcessWithoutNullStreams | undefined;
  const supervisor = new CodexSupervisor({
    config: {
      codexBin: resolve("node_modules/.bin/codex"),
      codexHome,
    },
    random: () => 0,
    childFactory(command, args, options) {
      child = spawn(command, args, options);
      return child;
    },
  });
  try {
    const host = await supervisor.start();
    const first = await host.threadStart({
      model: "gpt-5.4",
      modelProvider: "fixture",
      cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const events = host.events()[Symbol.asyncIterator]();
    await host.turnStart({
      threadId: first.thread.id,
      input: [{ type: "text", text: "ordinary fixture", text_elements: [] }],
    });
    for (;;) {
      const event = await events.next();
      if (event.done) throw new Error("Event stream ended before completion");
      if (event.value.method === "turn/completed") break;
    }

    const active = await host.threadStart({
      model: "gpt-5.4",
      modelProvider: "fixture",
      cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    await host.turnStart({
      threadId: active.thread.id,
      input: [{ type: "text", text: "pending fixture", text_elements: [] }],
    });
    await fake.waitForRequests(2);
    let streamedDeltaBeforeCrash = false;
    for (;;) {
      const event = await events.next();
      if (event.done) throw new Error("Event stream ended before active delta");
      if (
        event.value.method === "item/agentMessage/delta" &&
        event.value.params.delta === "stream-before-crash"
      ) {
        streamedDeltaBeforeCrash = true;
        break;
      }
    }
    const activeFailure = (async () => {
      try {
        for (;;) await events.next();
      } catch (error) {
        return error instanceof CodexGenerationChangedError;
      }
    })();
    child?.kill("SIGKILL");
    const readinessRemoved = await until(() => !supervisor.ready(), 1_000).then(
      () => true,
    );
    const activeRequestFailed = await activeFailure;
    const recoveredWithinMs = await until(() => supervisor.ready(), 35_000);
    const resumed = await host.threadResume({ threadId: first.thread.id });

    const toolThread = await host.threadStart({
      model: "gpt-5.4",
      modelProvider: "fixture",
      cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      dynamicTools: [
        {
          type: "function",
          name: "fixture_tool",
          description: "Fixture",
          inputSchema: { type: "object" },
        },
      ],
    });
    const pendingTool = host.toolCalls()[Symbol.asyncIterator]().next();
    await host.turnStart({
      threadId: toolThread.thread.id,
      input: [{ type: "text", text: "tool fixture", text_elements: [] }],
    });
    const call = await pendingTool;
    if (call.done) throw new Error("Tool stream ended before fixture call");
    child?.kill("SIGKILL");
    await until(() => !supervisor.ready(), 1_000);
    let toolContinuationCode = "";
    try {
      call.value.respond({
        success: true,
        contentItems: [{ type: "inputText", text: "late output" }],
      });
    } catch (error) {
      if (error instanceof CodexGenerationChangedError) {
        toolContinuationCode = "proxy_continuation_lost";
      }
    }

    const data = join(directory, "data");
    const copied = join(directory, "copied-data");
    mkdirSync(data, { mode: 0o700 });
    const codexData = join(data, "codex");
    mkdirSync(codexData, { mode: 0o700 });
    const authPath = join(codexData, "auth.json");
    writeFileSync(authPath, "opaque credential fixture", { mode: 0o600 });
    const credentialSize = statSync(authPath).size;
    const codexLauncher = join(directory, "fake-codex");
    writeFileSync(
      codexLauncher,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolve("test/fixtures/fake-app-server.mjs"))} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(codexLauncher, 0o700);
    execFileSync("bun", ["run", "build"], { stdio: "ignore" });
    const tools = [
      {
        type: "function",
        name: "fixture_tool",
        description: "Fixture tool",
        parameters: { type: "object", properties: {} },
      },
    ];
    const firstProxy = await startProxyChild(data, codexLauncher);
    const storedResponse = await postResponse(firstProxy.origin, {
      model: "gpt-5.2-codex",
      input: "persist this response",
      store: true,
    });
    const storedBody = (await storedResponse.json()) as {
      id?: string;
      output_text?: string;
    };
    if (!storedResponse.ok || !storedBody.id) {
      throw new Error(
        `First proxy stored response failed (${storedResponse.status})`,
      );
    }
    const toolResponse = await postResponse(firstProxy.origin, {
      model: "gpt-5.2-codex",
      input: "call a tool",
      store: true,
      tools,
    });
    const toolBody = (await toolResponse.json()) as {
      id?: string;
      output?: Array<{ type?: string; call_id?: string }>;
    };
    const toolCall = toolBody.output?.find(
      (item) => item.type === "function_call",
    );
    if (!toolResponse.ok || !toolBody.id || !toolCall?.call_id) {
      throw new Error(
        `First proxy tool response failed (${toolResponse.status})`,
      );
    }
    await firstProxy.close();
    cpSync(data, copied, { recursive: true, preserveTimestamps: true });
    const secondProxy = await startProxyChild(copied, codexLauncher);
    const resumedResponse = await postResponse(secondProxy.origin, {
      model: "gpt-5.2-codex",
      input: "resume after process restart",
      previous_response_id: storedBody.id,
      store: true,
    });
    const resumedBody = (await resumedResponse.json()) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    const lostResponse = await postResponse(secondProxy.origin, {
      model: "gpt-5.2-codex",
      previous_response_id: toolBody.id,
      input: [
        {
          type: "function_call_output",
          call_id: toolCall.call_id,
          output: "late fixture output",
        },
      ],
      tools,
      store: true,
    });
    const lostBody = (await lostResponse.json()) as {
      error?: { code?: string };
    };
    await secondProxy.close();
    const sqlitePreserved = resumedResponse.ok;
    const copiedAuth = join(copied, "codex", "auth.json");
    const credentialFilePreserved =
      statSync(copiedAuth).size === credentialSize;

    return {
      activeRequestFailed,
      streamedDeltaBeforeCrash,
      readinessRemoved,
      recoveredWithinMs,
      storedThreadResumed:
        resumed.thread.id === first.thread.id &&
        resumedBody.output?.[0]?.content?.[0]?.text ===
          "fixture child response",
      toolContinuationCode:
        toolContinuationCode === "proxy_continuation_lost" &&
        lostResponse.status === 409
          ? lostBody.error?.code
          : "",
      sqlitePreserved,
      credentialFilePreserved,
      credentialContentRead: false,
      proxyStarts: 2,
    };
  } finally {
    await supervisor.stop();
    await fake.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
