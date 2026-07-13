import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
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
  frameCounts: { requests: number; responses: number; notifications: number };
  schemaErrors: string[];
}

type JsonFrame = Record<string, unknown>;
export interface CapturedFrames {
  client: JsonFrame[];
  server: JsonFrame[];
}

const generatedDirectory = resolve("src/codex/generated");
const responseSchemas: Record<string, string> = {
  initialize: "v1/InitializeResponse.json",
  "model/list": "v2/ModelListResponse.json",
  "thread/start": "v2/ThreadStartResponse.json",
  "thread/resume": "v2/ThreadResumeResponse.json",
  "thread/fork": "v2/ThreadForkResponse.json",
  "thread/inject_items": "v2/ThreadInjectItemsResponse.json",
  "thread/delete": "v2/ThreadDeleteResponse.json",
  "turn/start": "v2/TurnStartResponse.json",
  "turn/interrupt": "v2/TurnInterruptResponse.json",
  "item/tool/call": "DynamicToolCallResponse.json",
};

function schema(path: string): object {
  return JSON.parse(readFileSync(resolve(generatedDirectory, path), "utf8"));
}

function diagnostic(
  direction: "client" | "server",
  kind: string,
  method: string,
  errors: ErrorObject[] | null | undefined,
): Error {
  const issue = errors?.[0];
  const location = issue?.instancePath || "/";
  const keyword = issue?.keyword ?? "schema";
  const message = issue?.message ?? "validation failed";
  return new Error(
    `${direction} ${kind} ${method} ${location} ${keyword}: ${message}`,
  );
}

export function validateCapturedFrames(frames: CapturedFrames): string[] {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    formats: {
      double: true,
      int32: true,
      int64: true,
      uint: true,
      uint16: true,
      uint32: true,
      uint64: true,
    },
  });
  const validators = new Map<string, ValidateFunction>();
  const validator = (path: string) => {
    let validate = validators.get(path);
    if (!validate) {
      validate = ajv.compile(schema(path));
      validators.set(path, validate);
    }
    return validate;
  };
  const clientMethods = new Map<string | number, string>();
  const serverMethods = new Map<string | number, string>();
  for (const frame of frames.client) {
    if (frame.id !== undefined && typeof frame.method === "string") {
      clientMethods.set(frame.id as string | number, frame.method);
    }
  }
  for (const frame of frames.server) {
    if (frame.id !== undefined && typeof frame.method === "string") {
      serverMethods.set(frame.id as string | number, frame.method);
    }
  }
  const validate = (
    direction: "client" | "server",
    kind: string,
    method: string,
    path: string,
    value: unknown,
  ) => {
    const check = validator(path);
    if (!check(value)) throw diagnostic(direction, kind, method, check.errors);
  };

  for (const frame of frames.client) {
    const method = typeof frame.method === "string" ? frame.method : "response";
    if (frame.id !== undefined && typeof frame.method === "string") {
      validate("client", "request", method, "ClientRequest.json", frame);
    } else if (typeof frame.method === "string") {
      validate(
        "client",
        "notification",
        method,
        "ClientNotification.json",
        frame,
      );
    } else if (frame.id !== undefined) {
      const requestMethod =
        serverMethods.get(frame.id as string | number) ?? "unknown";
      const path = responseSchemas[requestMethod] ?? "JSONRPCResponse.json";
      validate(
        "client",
        "response",
        requestMethod,
        path,
        responseSchemas[requestMethod] ? frame.result : frame,
      );
    }
  }
  for (const frame of frames.server) {
    const method = typeof frame.method === "string" ? frame.method : "response";
    if (frame.id !== undefined && typeof frame.method === "string") {
      validate("server", "request", method, "ServerRequest.json", frame);
    } else if (typeof frame.method === "string") {
      validate(
        "server",
        "notification",
        method,
        "ServerNotification.json",
        frame,
      );
    } else if (frame.id !== undefined) {
      const requestMethod =
        clientMethods.get(frame.id as string | number) ?? "unknown";
      const responsePath =
        responseSchemas[requestMethod] ?? "JSONRPCResponse.json";
      validate(
        "server",
        "response",
        requestMethod,
        responsePath,
        responseSchemas[requestMethod] ? frame.result : frame,
      );
    }
  }
  return [];
}

function frameCollector(target: JsonFrame[]): (chunk: Buffer | string) => void {
  let pending = "";
  return (chunk) => {
    pending += chunk.toString();
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() !== "") target.push(JSON.parse(line) as JsonFrame);
    }
  };
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
  const frames: CapturedFrames = { client: [], server: [] };
  const collectClient = frameCollector(frames.client);
  const collectServer = frameCollector(frames.server);
  const supervisor = createSupervisor({
    config: { codexBin, codexHome },
    random: () => 0,
    childFactory(command, args, options) {
      const child = spawn(command, args, options);
      const input = new PassThrough();
      input.on("data", collectClient);
      input.pipe(child.stdin);
      child.stdout.on("data", collectServer);
      return {
        stdin: input,
        stdout: child.stdout,
        stderr: child.stderr,
        on: child.on.bind(child),
        once: child.once.bind(child),
        off: child.off.bind(child),
        kill: child.kill.bind(child),
      };
    },
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

    const schemaErrors = validateCapturedFrames(frames);
    const frameCounts = {
      requests: frames.client.filter(
        (frame) => frame.id !== undefined && typeof frame.method === "string",
      ).length,
      responses: frames.server.filter(
        (frame) => frame.id !== undefined && frame.method === undefined,
      ).length,
      notifications: frames.server.filter(
        (frame) => frame.id === undefined && typeof frame.method === "string",
      ).length,
    };
    return {
      codexVersion,
      methods,
      text,
      cancelled,
      dynamicToolResult,
      toolOutputForwarded: JSON.stringify(fake.requests.at(-1)).includes(
        "fixture tool result",
      ),
      frameCounts,
      schemaErrors,
    };
  } finally {
    await supervisor.stop();
    await fake.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
