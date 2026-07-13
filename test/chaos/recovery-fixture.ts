import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexSupervisor } from "../../src/codex/supervisor.js";
import { CodexGenerationChangedError } from "../../src/codex/transport.js";
import type { Config } from "../../src/config.js";
import { ConversationStore } from "../../src/conversations/store.js";
import { start } from "../../src/main.js";
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

function proxyConfig(dataDir: string): Config {
  return {
    dataHost: "0.0.0.0",
    dataPort: 0,
    adminHost: "127.0.0.1",
    adminPort: 0,
    dataDir,
    codexHome: join(dataDir, "codex"),
    codexBin: "codex",
    bifrostProxyToken: "b".repeat(32),
    metricsToken: "m".repeat(32),
    maxActiveTurns: 1,
    queueCapacity: 0,
    turnTimeoutMs: 30_000,
    toolTimeoutMs: 30_000,
    responseTtlMs: 60_000,
  };
}

async function startAndStopProxy(dataDir: string): Promise<void> {
  const supervisor = {
    health: () => true,
    ready: () => false,
    start: () => new Promise<never>(() => undefined),
    stop: async () => undefined,
  };
  const service = await start(proxyConfig(dataDir), { supervisor });
  await service.close();
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
    const databasePath = join(data, "proxy.sqlite");
    const store = ConversationStore.open(
      databasePath,
      { now: () => Date.now() },
      { responseTtlMs: 60_000, turnLeaseMs: 30_000, toolLeaseMs: 30_000 },
    );
    store.beginPending("resp_recovery", {
      threadId: first.thread.id,
      stored: true,
      processGeneration: 1,
    });
    store.complete("resp_recovery", "turn-recovery");
    store.close();
    const codexData = join(data, "codex");
    mkdirSync(codexData, { mode: 0o700 });
    const authPath = join(codexData, "auth.json");
    writeFileSync(authPath, "opaque credential fixture", { mode: 0o600 });
    const credentialSize = statSync(authPath).size;
    await startAndStopProxy(data);
    cpSync(data, copied, { recursive: true, preserveTimestamps: true });
    await startAndStopProxy(copied);
    const reopened = ConversationStore.open(
      join(copied, "proxy.sqlite"),
      { now: () => Date.now() },
      { responseTtlMs: 60_000, turnLeaseMs: 30_000, toolLeaseMs: 30_000 },
    );
    const sqlitePreserved =
      reopened.lookup("resp_recovery")?.state === "complete";
    reopened.close();
    const copiedAuth = join(copied, "codex", "auth.json");
    const credentialFilePreserved =
      existsSync(copiedAuth) && statSync(copiedAuth).size === credentialSize;

    return {
      activeRequestFailed,
      readinessRemoved,
      recoveredWithinMs,
      storedThreadResumed: resumed.thread.id === first.thread.id,
      toolContinuationCode,
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
