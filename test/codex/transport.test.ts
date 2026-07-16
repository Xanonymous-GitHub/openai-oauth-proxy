import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  fakeAccountResponse,
  fakeModelListResponse,
  fakeThread,
  fakeThreadStartResponse,
  fakeToolCallRequest,
  fakeTurnStartResponse,
} from "../../src/codex/fake.js";
import type { CodexHost } from "../../src/codex/host.js";
import {
  CodexGenerationChangedError,
  CodexProtocolError,
  createJsonlTransport,
} from "../../src/codex/transport.js";

const ALLOWED_SERVER_METHODS = new Set(["item/tool/call"]);

interface JsonSchema {
  $ref?: string;
  allOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  enum?: unknown[];
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minItems?: number;
  minLength?: number;
  minimum?: number;
  definitions?: Record<string, JsonSchema>;
}

interface ServerSchema extends JsonSchema {
  oneOf: JsonSchema[];
  definitions: Record<string, JsonSchema>;
}

const serverSchemaPromise = readFile(
  new URL("../../src/codex/generated/ServerRequest.json", import.meta.url),
  "utf8",
).then((source) => JSON.parse(source) as ServerSchema);

function fixtureValue(schema: JsonSchema, root: ServerSchema): unknown {
  if (schema.$ref) {
    const name = schema.$ref.split("/").at(-1);
    if (!name || !root.definitions[name]) {
      throw new Error(`Missing generated schema definition ${name}`);
    }
    return fixtureValue(root.definitions[name], root);
  }
  if (schema.enum) return schema.enum[0];
  if (schema.allOf) {
    return Object.assign(
      {},
      ...schema.allOf.map((part) => fixtureValue(part, root)),
    );
  }
  if (schema.oneOf) return fixtureValue(schema.oneOf[0] ?? {}, root);
  if (schema.anyOf) {
    const nonNull = schema.anyOf.find((part) => part.type !== "null");
    return fixtureValue(nonNull ?? schema.anyOf[0] ?? {}, root);
  }

  const type = Array.isArray(schema.type)
    ? (schema.type.find((candidate) => candidate !== "null") ?? schema.type[0])
    : schema.type;
  if (type === "object" || schema.properties) {
    return Object.fromEntries(
      (schema.required ?? []).map((name) => [
        name,
        fixtureValue(schema.properties?.[name] ?? {}, root),
      ]),
    );
  }
  if (type === "array") {
    return Array.from({ length: schema.minItems ?? 0 }, () =>
      fixtureValue(schema.items ?? {}, root),
    );
  }
  if (type === "integer" || type === "number") return schema.minimum ?? 0;
  if (type === "boolean") return false;
  if (type === "null") return null;
  if (type === "string") return "x".repeat(Math.max(1, schema.minLength ?? 0));
  return null;
}

async function generatedServerRequest(
  method: string,
  id = 41,
): Promise<Record<string, unknown>> {
  const schema = await serverSchemaPromise;
  const variant = schema.oneOf.find(
    (candidate) => candidate.properties?.method?.enum?.[0] === method,
  );
  if (!variant) throw new Error(`Missing generated server method ${method}`);
  return { ...(fixtureValue(variant, schema) as object), id };
}

function createHarness(generation = 7) {
  const fromServer = new PassThrough();
  const toServer = new PassThrough();
  const outgoingLines = createInterface({ input: toServer })[
    Symbol.asyncIterator
  ]();
  const transport = createJsonlTransport({
    input: fromServer,
    output: toServer,
    generation,
  });

  return {
    fromServer,
    toServer,
    transport,
    async nextOutgoing(): Promise<Record<string, unknown>> {
      const line = await outgoingLines.next();
      if (line.done) throw new Error("Transport output ended");
      return JSON.parse(line.value) as Record<string, unknown>;
    },
    send(message: unknown): void {
      fromServer.write(`${JSON.stringify(message)}\n`);
    },
  };
}

function within<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("Transport did not terminate")), 100);
    }),
  ]);
}

function waitForIo(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function spawnFakeAppServer(environment: NodeJS.ProcessEnv = process.env) {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("../fixtures/fake-app-server.mjs", import.meta.url),
      ),
    ],
    { env: environment, stdio: ["pipe", "pipe", "pipe"] },
  );
  const outgoingLines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  return {
    child,
    send(message: unknown): void {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    async nextOutgoing(): Promise<Record<string, unknown>> {
      const line = await outgoingLines.next();
      if (line.done) throw new Error("Fake App Server output ended");
      return JSON.parse(line.value) as Record<string, unknown>;
    },
  };
}

async function injectServerRequest(
  method: string,
): Promise<Record<string, unknown>> {
  const harness = createHarness();
  harness.send(await generatedServerRequest(method));
  return harness.nextOutgoing();
}

describe("JSONL transport", () => {
  it("exposes only the narrow CodexHost surface", () => {
    const { transport } = createHarness();

    expect(Object.keys(transport.host).sort()).toEqual(
      [
        "generation",
        "accountRead",
        "loginStart",
        "loginCancel",
        "logout",
        "modelList",
        "threadStart",
        "threadResume",
        "threadFork",
        "threadList",
        "threadInjectItems",
        "threadDelete",
        "turnStart",
        "turnInterrupt",
        "events",
        "toolCalls",
      ].sort(),
    );
  });

  it.each([
    ["accountRead", "account/read", [true], { refreshToken: true }],
    [
      "loginStart",
      "account/login/start",
      [{ type: "chatgptDeviceCode" }],
      { type: "chatgptDeviceCode" },
    ],
    [
      "loginCancel",
      "account/login/cancel",
      [{ loginId: "login-1" }],
      { loginId: "login-1" },
    ],
    ["logout", "account/logout", [], undefined],
    ["modelList", "model/list", [{}], {}],
    ["threadStart", "thread/start", [{}], {}],
    [
      "threadResume",
      "thread/resume",
      [{ threadId: "thread-1" }],
      { threadId: "thread-1" },
    ],
    [
      "threadFork",
      "thread/fork",
      [{ threadId: "thread-1" }],
      { threadId: "thread-1" },
    ],
    [
      "threadList",
      "thread/list",
      [{ cwd: "/tmp/operation" }],
      { cwd: "/tmp/operation" },
    ],
    [
      "threadInjectItems",
      "thread/inject_items",
      [{ threadId: "thread-1", items: [] }],
      { threadId: "thread-1", items: [] },
    ],
    [
      "threadDelete",
      "thread/delete",
      [{ threadId: "thread-1" }],
      { threadId: "thread-1" },
    ],
    [
      "turnStart",
      "turn/start",
      [{ threadId: "thread-1", input: [] }],
      { threadId: "thread-1", input: [] },
    ],
    [
      "turnInterrupt",
      "turn/interrupt",
      [{ threadId: "thread-1", turnId: "turn-1" }],
      { threadId: "thread-1", turnId: "turn-1" },
    ],
  ] as const)(
    "maps %s to literal method %s",
    async (hostMethod, rpcMethod, args, expectedParams) => {
      const harness = createHarness();
      const call = harness.transport.host[hostMethod] as (
        ...values: never[]
      ) => Promise<unknown>;
      const pending = call(...(args as unknown as never[]));
      const request = await harness.nextOutgoing();

      expect(request).toMatchObject({ method: rpcMethod });
      if (expectedParams === undefined)
        expect(request).not.toHaveProperty("params");
      else expect(request.params).toEqual(expectedParams);
      harness.send({ id: request.id, result: {} });
      await expect(pending).resolves.toEqual({});
    },
  );

  it("correlates out-of-order responses by request ID", async () => {
    const harness = createHarness();
    const first = harness.transport.host.accountRead(false);
    const second = harness.transport.host.modelList({});
    const firstRequest = await harness.nextOutgoing();
    const secondRequest = await harness.nextOutgoing();

    harness.send({ id: secondRequest.id, result: "second" });
    harness.send({ id: firstRequest.id, result: "first" });

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });

  it("guards the private request path before serialization", async () => {
    const harness = createHarness();
    const privateTransport = harness.transport as unknown as {
      request(method: string, params: unknown): Promise<unknown>;
    };

    await expect(
      privateTransport.request("process/spawn", { value: 1n }),
    ).rejects.toThrow("not allowed");
    expect(harness.toServer.readableLength).toBe(0);
  });

  it.each([
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/tool/requestUserInput",
    "mcpServer/elicitation/request",
    "item/permissions/requestApproval",
    "account/chatgptAuthTokens/refresh",
    "attestation/generate",
  ])("rejects non-allowlisted server request %s", async (method) => {
    const response = await injectServerRequest(method);
    const error = response.error as { code: number; message: string };
    expect(error).toMatchObject({ code: -32601 });
    expect(error.message).not.toContain("token");
  });

  it("rejects every generated non-allowlisted server request before tool dispatch", async () => {
    const schema = await serverSchemaPromise;
    const harness = createHarness();
    const methods = schema.oneOf.flatMap(
      (variant) => variant.properties?.method?.enum ?? [],
    );

    for (const method of methods) {
      if (!ALLOWED_SERVER_METHODS.has(method as string)) {
        harness.send(await generatedServerRequest(method as string));
        await expect(harness.nextOutgoing()).resolves.toMatchObject({
          error: { code: -32601, message: "Method not found" },
        });
      }
    }

    const nextTool = harness.transport.host
      .toolCalls()
      [Symbol.asyncIterator]()
      .next();
    harness.send(await generatedServerRequest("item/tool/call", 99));
    await expect(nextTool).resolves.toMatchObject({ value: { id: 99 } });
  });

  it("dispatches generation-bound tool calls and writes their response", async () => {
    const harness = createHarness(12);
    const nextTool = harness.transport.host
      .toolCalls()
      [Symbol.asyncIterator]()
      .next();
    harness.send({
      id: "tool-1",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "lookup",
        arguments: { id: 1 },
      },
    });
    const tool = (await nextTool).value;

    expect(tool).toMatchObject({
      generation: 12,
      id: "tool-1",
      params: { tool: "lookup" },
    });
    tool?.respond({ contentItems: [], success: true });
    await expect(harness.nextOutgoing()).resolves.toEqual({
      id: "tool-1",
      result: { contentItems: [], success: true },
    });
  });

  it("routes notifications with their process generation", async () => {
    const harness = createHarness(12);
    const nextEvent = harness.transport.host
      .events()
      [Symbol.asyncIterator]()
      .next();

    harness.send({
      method: "thread/started",
      params: { thread: { id: "thread-1" } },
    });

    await expect(nextEvent).resolves.toMatchObject({
      value: { generation: 12, method: "thread/started" },
    });
  });

  it("rejects pending requests on a redacted malformed-line protocol failure", async () => {
    const harness = createHarness();
    const pending = harness.transport.host.accountRead(false);
    await harness.nextOutgoing();

    harness.fromServer.write('{"access_token":"secret-token"\n');

    await expect(pending).rejects.toBeInstanceOf(CodexProtocolError);
    await expect(pending).rejects.not.toThrow("secret-token");
  });

  it("rejects a pending request on clean input EOF", async () => {
    const harness = createHarness();
    const pending = harness.transport.host.accountRead(false);
    await harness.nextOutgoing();

    harness.fromServer.end();

    await expect(within(pending)).rejects.toBeInstanceOf(CodexProtocolError);
  });

  it.each(["input", "output"] as const)(
    "rejects pending requests and queues on %s stream error",
    async (streamName) => {
      const harness = createHarness();
      const pending = harness.transport.host.accountRead(false);
      await harness.nextOutgoing();
      const nextEvent = harness.transport.host
        .events()
        [Symbol.asyncIterator]()
        .next();
      const nextTool = harness.transport.host
        .toolCalls()
        [Symbol.asyncIterator]()
        .next();
      const stream =
        streamName === "input" ? harness.fromServer : harness.toServer;

      expect(() =>
        stream.emit("error", new Error("secret-token")),
      ).not.toThrow();

      await expect(within(pending)).rejects.toBeInstanceOf(CodexProtocolError);
      await expect(within(nextEvent)).rejects.toBeInstanceOf(
        CodexProtocolError,
      );
      await expect(within(nextTool)).rejects.toBeInstanceOf(CodexProtocolError);
    },
  );

  it("rejects pending requests when a response has an unknown ID", async () => {
    const harness = createHarness();
    const pending = harness.transport.host.accountRead(false);
    await harness.nextOutgoing();

    harness.send({ id: 999, result: {} });

    await expect(pending).rejects.toBeInstanceOf(CodexProtocolError);
  });

  it("discards responses for issued nonpending IDs without failing unrelated work", async () => {
    const harness = createHarness();
    const controller = new AbortController();
    const aborted = harness.transport.host.accountRead(
      false,
      controller.signal,
    );
    const abortedRequest = await harness.nextOutgoing();
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });

    const active = harness.transport.host.modelList({});
    const activeRequest = await harness.nextOutgoing();
    harness.send({ id: abortedRequest.id, result: {} });
    harness.send({
      id: activeRequest.id,
      result: { data: [], nextCursor: null },
    });

    await expect(active).resolves.toEqual({ data: [], nextCursor: null });

    const later = harness.transport.host.accountRead(false);
    const laterRequest = await harness.nextOutgoing();
    harness.send({ id: abortedRequest.id, result: {} });
    harness.send({ id: activeRequest.id, result: {} });
    harness.send({ id: laterRequest.id, result: { account: null } });
    await expect(later).resolves.toEqual({ account: null });
  });

  it("discards more than 1000 aborted late responses without retaining tombstones", async () => {
    const harness = createHarness();

    for (let index = 0; index < 1_001; index += 1) {
      const controller = new AbortController();
      const pending = harness.transport.host.accountRead(
        false,
        controller.signal,
      );
      const request = await harness.nextOutgoing();
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      harness.send({ id: request.id, result: {} });
    }

    const active = harness.transport.host.modelList({});
    const activeRequest = await harness.nextOutgoing();
    harness.send({
      id: activeRequest.id,
      result: { data: [], nextCursor: null },
    });
    await expect(active).resolves.toEqual({ data: [], nextCursor: null });

    const futureVictim = harness.transport.host.accountRead(false);
    await harness.nextOutgoing();
    harness.send({ id: 2_000, result: {} });
    await expect(futureVictim).rejects.toBeInstanceOf(CodexProtocolError);

    const source = await readFile("src/codex/transport.ts", "utf8");
    expect(source).not.toContain("abortedResponseIds");
    expect(source).not.toContain("MAX_ABORTED_RESPONSE_IDS");
  });

  it.each(["0", -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "protocol-fails malformed response ID %j",
    async (id) => {
      const harness = createHarness();
      const pending = harness.transport.host.accountRead(false);
      await harness.nextOutgoing();

      harness.send({ id, result: {} });

      await expect(pending).rejects.toBeInstanceOf(CodexProtocolError);
    },
  );

  it("resets the issued numeric ID range with a replacement generation", async () => {
    const retired = createHarness(1);
    const old = retired.transport.host.accountRead(false);
    await retired.nextOutgoing();
    retired.transport.invalidateGeneration();
    await expect(old).rejects.toBeInstanceOf(CodexGenerationChangedError);

    const replacement = createHarness(2);
    const pending = replacement.transport.host.accountRead(false);
    const request = await replacement.nextOutgoing();
    expect(request.id).toBe(0);
    replacement.send({ id: 0, result: { account: null } });
    await expect(pending).resolves.toEqual({ account: null });
  });

  it("invalidates every pending request and tool call on generation change", async () => {
    const harness = createHarness();
    const first = harness.transport.host.accountRead(false);
    const second = harness.transport.host.modelList({});
    await harness.nextOutgoing();
    await harness.nextOutgoing();

    const nextTool = harness.transport.host
      .toolCalls()
      [Symbol.asyncIterator]()
      .next();
    harness.send(await generatedServerRequest("item/tool/call", 77));
    const tool = (await nextTool).value;
    harness.transport.invalidateGeneration();

    await expect(first).rejects.toBeInstanceOf(CodexGenerationChangedError);
    await expect(second).rejects.toBeInstanceOf(CodexGenerationChangedError);
    expect(() => tool?.reject(-32_000, "late")).toThrow(
      CodexGenerationChangedError,
    );
  });

  it("does not yield a buffered notification after generation invalidation", async () => {
    const harness = createHarness();
    harness.send({
      method: "thread/started",
      params: { thread: { id: "thread-1" } },
    });
    await waitForIo();

    harness.transport.invalidateGeneration();

    await expect(
      harness.transport.host.events()[Symbol.asyncIterator]().next(),
    ).rejects.toBeInstanceOf(CodexGenerationChangedError);
  });

  it("does not yield a buffered tool call after generation invalidation", async () => {
    const harness = createHarness();
    harness.send(await generatedServerRequest("item/tool/call", 77));
    await waitForIo();

    harness.transport.invalidateGeneration();

    await expect(
      harness.transport.host.toolCalls()[Symbol.asyncIterator]().next(),
    ).rejects.toBeInstanceOf(CodexGenerationChangedError);
  });

  it("sends initialized as the only transport notification", async () => {
    const harness = createHarness();

    harness.transport.initialized();

    await expect(harness.nextOutgoing()).resolves.toEqual({
      method: "initialized",
      params: {},
    });
    expect(harness.transport).not.toHaveProperty("notify");
  });
});

const _hostTypeCheck: CodexHost | undefined = undefined;
void _hostTypeCheck;

describe("Codex fixture builders", () => {
  it("builds deterministic account, model, thread, turn, and tool-call records", () => {
    expect(fakeAccountResponse()).toMatchObject({
      account: { type: "chatgpt" },
      requiresOpenaiAuth: true,
    });
    expect(fakeModelListResponse().data[0]).toMatchObject({
      id: "gpt-5.2-codex",
    });
    expect(fakeThread()).toMatchObject({
      id: "thread-1",
      status: { type: "idle" },
    });
    expect(fakeThreadStartResponse()).toMatchObject({
      thread: { id: "thread-1" },
    });
    expect(fakeTurnStartResponse()).toMatchObject({ turn: { id: "turn-1" } });
    expect(fakeToolCallRequest()).toMatchObject({
      id: "tool-1",
      method: "item/tool/call",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
  });
});

describe("fake App Server", () => {
  it("requires initialization and returns deterministic protocol records", async () => {
    const fake = spawnFakeAppServer();
    try {
      fake.send({
        id: 1,
        method: "account/read",
        params: { refreshToken: false },
      });
      await expect(fake.nextOutgoing()).resolves.toMatchObject({
        id: 1,
        error: { code: -32002 },
      });

      fake.send({
        id: 2,
        method: "initialize",
        params: {
          clientInfo: { name: "test", title: null, version: "1" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
      });
      await expect(fake.nextOutgoing()).resolves.toMatchObject({
        id: 2,
        result: { userAgent: "fake-codex-app-server/0.144.1" },
      });
      fake.send({ method: "initialized", params: {} });

      const cases = [
        [
          3,
          "account/read",
          { refreshToken: false },
          { account: { type: "chatgpt" } },
        ],
        [
          4,
          "account/login/start",
          { type: "chatgptDeviceCode" },
          { loginId: "login-1" },
        ],
        [
          5,
          "account/login/cancel",
          { loginId: "login-1" },
          { status: "canceled" },
        ],
        [6, "account/logout", undefined, {}],
        [7, "model/list", {}, { data: [{ id: "gpt-5.2-codex" }] }],
        [8, "thread/start", {}, { thread: { id: "thread-1" } }],
        [
          9,
          "thread/resume",
          { threadId: "thread-existing" },
          { thread: { id: "thread-existing" } },
        ],
        [
          10,
          "thread/fork",
          { threadId: "thread-1" },
          { thread: { id: "thread-2" } },
        ],
        [11, "thread/inject_items", { threadId: "thread-1", items: [] }, {}],
        [12, "thread/delete", { threadId: "thread-1" }, {}],
        [
          13,
          "turn/start",
          { threadId: "thread-1", input: [] },
          { turn: { id: "turn-1" } },
        ],
        [14, "turn/interrupt", { threadId: "thread-1", turnId: "turn-1" }, {}],
      ] as const;

      for (const [id, method, params, result] of cases) {
        fake.send(
          params === undefined ? { id, method } : { id, method, params },
        );
        await expect(fake.nextOutgoing()).resolves.toMatchObject({
          id,
          result,
        });
      }
    } finally {
      fake.child.kill();
    }
  });

  it("replays scripted notifications after initialized", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fake-codex-"));
    const scriptPath = join(directory, "script.json");
    await writeFile(
      scriptPath,
      JSON.stringify([
        {
          method: "thread/started",
          params: { thread: { id: "scripted-thread" } },
        },
      ]),
    );
    const fake = spawnFakeAppServer({
      ...process.env,
      FAKE_CODEX_SCRIPT: scriptPath,
    });
    try {
      fake.send({ id: 1, method: "initialize", params: {} });
      await fake.nextOutgoing();
      fake.send({ method: "initialized", params: {} });
      await expect(fake.nextOutgoing()).resolves.toEqual({
        method: "thread/started",
        params: { thread: { id: "scripted-thread" } },
      });
    } finally {
      fake.child.kill();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
