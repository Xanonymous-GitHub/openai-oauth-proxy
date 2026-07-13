import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CodexHost, HostNotification } from "../../src/codex/host.js";
import { createSupervisor } from "../../src/codex/supervisor.js";
import { startFakeResponsesServer } from "./fake-responses-server.js";

interface ContractResult {
  codexVersion: string;
  methods: string[];
  text: string;
  cancelled: boolean;
  dynamicToolResult: string;
  toolOutputForwarded: boolean;
  schemaErrors: string[];
}

async function nextEvent(
  iterator: AsyncIterator<HostNotification>,
  method: HostNotification["method"],
): Promise<HostNotification> {
  for (;;) {
    const event = await iterator.next();
    if (event.done) throw new Error("App Server event stream ended");
    if (event.value.method === method) return event.value;
  }
}

async function nextAgentText(
  iterator: AsyncIterator<HostNotification>,
): Promise<string> {
  for (;;) {
    const event = await nextEvent(iterator, "item/completed");
    if (
      event.method === "item/completed" &&
      event.params.item.type === "agentMessage"
    ) {
      return event.params.item.text;
    }
  }
}

function generatedMethods(schemaName: string): string[] {
  const schema = JSON.parse(
    readFileSync(resolve("src/codex/generated", schemaName), "utf8"),
  ) as { oneOf: Array<{ properties: { method: { enum: string[] } } }> };
  return schema.oneOf.flatMap((entry) => entry.properties.method.enum);
}

async function startThread(host: CodexHost, cwd: string) {
  return host.threadStart({
    model: "gpt-5.4",
    modelProvider: "fixture",
    cwd,
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: false,
    experimentalRawEvents: false,
  });
}

async function step<T>(name: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new Error(`Real App Server ${name} failed`, { cause: error });
  }
}

export async function runRealAppServerContract(): Promise<ContractResult> {
  const fake = await startFakeResponsesServer();
  const directory = mkdtempSync(join(tmpdir(), "real-app-server-"));
  const codexHome = join(directory, "codex-home");
  const cwd = join(directory, "work");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(codexHome, "config.toml"),
    `model_provider = "fixture"\napproval_policy = "never"\nsandbox_mode = "read-only"\n\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "${fake.baseURL}"\nwire_api = "responses"\nrequires_openai_auth = false\n`,
    { mode: 0o600 },
  );
  const codexBin = resolve("node_modules/.bin/codex");
  const codexVersion = execFileSync(codexBin, ["--version"], {
    encoding: "utf8",
  })
    .trim()
    .replace("codex-cli ", "");
  const supervisor = createSupervisor({
    config: { codexBin, codexHome },
    random: () => 0,
  });
  const methods = [
    "initialize",
    "model/list",
    "thread/start",
    "thread/resume",
    "thread/fork",
    "thread/inject_items",
    "thread/delete",
    "turn/start",
    "turn/interrupt",
    "item/tool/call",
  ];
  try {
    const host = await supervisor.start();
    const models = await step("model/list", () =>
      host.modelList({ includeHidden: false, limit: 100 }),
    );
    if (models.data.length === 0)
      throw new Error("Fixture model list was empty");
    const started = await step("thread/start", () => startThread(host, cwd));
    const events = host.events()[Symbol.asyncIterator]();
    const turn = await step("turn/start", () =>
      host.turnStart({
        threadId: started.thread.id,
        input: [{ type: "text", text: "text fixture", text_elements: [] }],
      }),
    );
    const text = await nextAgentText(events);
    await nextEvent(events, "turn/completed");

    const resumed = await step("thread/resume", () =>
      host.threadResume({ threadId: started.thread.id }),
    );
    const forked = await step("thread/fork", () =>
      host.threadFork({
        threadId: resumed.thread.id,
        lastTurnId: turn.turn.id,
      }),
    );
    await step("thread/inject_items", () =>
      host.threadInjectItems({
        threadId: forked.thread.id,
        items: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "raw fixture" }],
          },
        ],
      }),
    );
    await step("thread/delete", () =>
      host.threadDelete({ threadId: forked.thread.id }),
    );

    const cancelThread = await step("cancel thread/start", () =>
      startThread(host, cwd),
    );
    const cancelTurn = await step("cancel turn/start", () =>
      host.turnStart({
        threadId: cancelThread.thread.id,
        input: [{ type: "text", text: "cancel fixture", text_elements: [] }],
      }),
    );
    await fake.waitForRequests(2);
    await step("turn/interrupt", () =>
      host.turnInterrupt({
        threadId: cancelThread.thread.id,
        turnId: cancelTurn.turn.id,
      }),
    );
    const cancelledEvent = await nextEvent(events, "turn/completed");
    const cancelled =
      cancelledEvent.method === "turn/completed" &&
      cancelledEvent.params.turn.status === "interrupted";

    const toolThread = await step("tool thread/start", () =>
      host.threadStart({
        model: "gpt-5.4",
        modelProvider: "fixture",
        cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
        dynamicTools: [
          {
            type: "function",
            name: "fixture_tool",
            description: "Return deterministic fixture data",
            inputSchema: { type: "object" },
          },
        ],
      }),
    );
    const pendingTool = host.toolCalls()[Symbol.asyncIterator]().next();
    await step("tool turn/start", () =>
      host.turnStart({
        threadId: toolThread.thread.id,
        input: [{ type: "text", text: "tool fixture", text_elements: [] }],
      }),
    );
    const toolCall = await pendingTool;
    if (toolCall.done) throw new Error("Dynamic tool stream ended");
    toolCall.value.respond({
      success: true,
      contentItems: [{ type: "inputText", text: "fixture tool result" }],
    });
    const dynamicToolResult = await nextAgentText(events);
    await nextEvent(events, "turn/completed");

    const schemaErrors = methods.filter((method) => {
      const generated = [
        ...generatedMethods("ClientRequest.json"),
        ...generatedMethods("ServerRequest.json"),
      ];
      return !generated.includes(method);
    });
    return {
      codexVersion,
      methods,
      text,
      cancelled,
      dynamicToolResult,
      toolOutputForwarded: JSON.stringify(fake.requests.at(-1)).includes(
        "fixture tool result",
      ),
      schemaErrors,
    };
  } finally {
    await supervisor.stop();
    await fake.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
