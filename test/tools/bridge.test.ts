import { describe, expect, it, vi } from "vitest";
import type { JsonValue } from "../../src/codex/generated/serde_json/JsonValue.js";
import type { CodexHost, PendingServerToolCall } from "../../src/codex/host.js";
import { ToolBridge, type ToolBridgeContext } from "../../src/tools/bridge.js";
import type { TurnResult } from "../../src/turns/events.js";

const allowedTools = [
  "weather",
  "clock",
  "first",
  "second",
  "third",
  "danger",
  "lookup",
].map((name) => ({
  type: "function" as const,
  name,
  description: "",
  inputSchema: {},
}));

function result(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    text: "done",
    finishReason: "stop",
    ...overrides,
  };
}

function createBridge() {
  let now = 1_000;
  const host = { generation: 7 } as CodexHost;
  const bridge = new ToolBridge({
    host,
    now: () => now,
    timeoutMs: 15 * 60 * 1_000,
  });
  return {
    bridge,
    host,
    setNow(value: number) {
      now = value;
    },
  };
}

function context(
  overrides: Partial<ToolBridgeContext> = {},
): ToolBridgeContext {
  return {
    kind: "chat",
    threadId: "thread-1",
    turnId: "turn-1",
    leaseOwner: "request-1",
    generation: 7,
    toolFingerprint: "tools-v1",
    toolDefinitions: allowedTools,
    serviceTier: "auto",
    resume: vi.fn(() => ({
      result: Promise.resolve(result()),
      events: (async function* () {
        yield { type: "text.delta" as const, delta: "done" };
      })(),
    })),
    invalidate: vi.fn(async () => undefined),
    ...overrides,
  };
}

function serverCall(
  id: string,
  tool: string,
  args: JsonValue = {},
): PendingServerToolCall {
  return {
    generation: 7,
    id,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: `internal-${id}`,
      namespace: null,
      tool,
      arguments: args,
    },
    respond: vi.fn(),
    reject: vi.fn(),
  };
}

describe("ToolBridge", () => {
  it("maps Chat and Responses function definitions exactly", () => {
    const { bridge } = createBridge();

    expect(
      bridge.toDynamicTools([
        {
          type: "function",
          function: {
            name: "weather",
            description: "Read weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
        },
      ]),
    ).toEqual([
      {
        type: "function",
        name: "weather",
        description: "Read weather",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      },
    ]);
    expect(
      bridge.toDynamicTools([
        {
          type: "function",
          name: "lookup",
          parameters: { type: "object" },
          strict: true,
        },
      ]),
    ).toEqual([
      {
        type: "function",
        name: "lookup",
        description: "",
        inputSchema: { type: "object" },
      },
    ]);
  });

  it.each(["mcp", "mcp__server", "has space", "slash/name", ""])(
    "rejects reserved or invalid function name %j",
    (name) => {
      const { bridge } = createBridge();
      expect(() =>
        bridge.toDynamicTools([
          {
            type: "function",
            name,
            parameters: { type: "object" },
          },
        ]),
      ).toThrowError(expect.objectContaining({ status: 400 }));
    },
  );

  it("canonicalizes definitions without mutating array order", () => {
    const { bridge } = createBridge();
    const first = bridge.toDynamicTools([
      {
        type: "function",
        name: "lookup",
        description: "Lookup",
        parameters: {
          required: ["id"],
          properties: { id: { type: "number" } },
          type: "object",
        },
      },
    ]);
    const reorderedKeys = bridge.toDynamicTools([
      {
        parameters: {
          type: "object",
          properties: { id: { type: "number" } },
          required: ["id"],
        },
        description: "Lookup",
        name: "lookup",
        type: "function",
      },
    ]);
    const reorderedTools = [
      ...first,
      {
        type: "function" as const,
        name: "other",
        description: "",
        inputSchema: {},
      },
    ];

    expect(bridge.fingerprint(first)).toBe(bridge.fingerprint(reorderedKeys));
    expect(bridge.fingerprint(first)).not.toBe(
      bridge.fingerprint(reorderedTools.reverse()),
    );
  });

  it("canonicalizes every accepted endpoint definition field", () => {
    const { bridge } = createBridge();
    const fingerprintDefinitions = (
      bridge as unknown as {
        fingerprintDefinitions(tools: unknown[]): string;
      }
    ).fingerprintDefinitions.bind(bridge);
    const first = [
      {
        type: "function",
        name: "lookup",
        description: "Lookup",
        parameters: {
          required: ["id"],
          properties: { id: { type: "number" } },
          type: "object",
        },
        strict: true,
      },
    ];
    const reorderedKeys = [
      {
        strict: true,
        parameters: {
          type: "object",
          properties: { id: { type: "number" } },
          required: ["id"],
        },
        description: "Lookup",
        name: "lookup",
        type: "function",
      },
    ];

    expect(fingerprintDefinitions(first)).toBe(
      fingerprintDefinitions(reorderedKeys),
    );
    expect(fingerprintDefinitions(first)).not.toBe(
      fingerprintDefinitions([{ ...reorderedKeys[0], strict: false }]),
    );
  });

  it("registers opaque generation-bound IDs and fans in all results", async () => {
    const { bridge } = createBridge();
    const turn = context();
    const first = serverCall("rpc-secret-1", "weather", { city: "Paris" });
    const second = serverCall("rpc-secret-2", "clock", { zone: "UTC" });
    const externalFirst = bridge.register(first, turn);
    const externalSecond = bridge.register(second, turn);

    expect(externalFirst).toMatchObject({
      id: expect.stringMatching(/^call_g7_[A-Za-z0-9_-]+$/),
      name: "weather",
      arguments: { city: "Paris" },
    });
    expect(externalFirst.id).not.toContain("rpc-secret-1");
    expect(externalSecond.id).not.toBe(externalFirst.id);

    await expect(
      bridge.continue({
        kind: "chat",
        toolFingerprint: "tools-v1",
        results: [
          { callId: externalSecond.id, output: "12:00" },
          { callId: externalFirst.id, output: "sunny" },
        ],
      }),
    ).resolves.toMatchObject({
      type: "continued",
      threadId: "thread-1",
      turnId: "turn-1",
      result: expect.any(Promise),
      events: expect.objectContaining({
        [Symbol.asyncIterator]: expect.any(Function),
      }),
    });
    expect(first.respond).toHaveBeenCalledWith({
      success: true,
      contentItems: [{ type: "inputText", text: "sunny" }],
    });
    expect(second.respond).toHaveBeenCalledWith({
      success: true,
      contentItems: [{ type: "inputText", text: "12:00" }],
    });
    expect(first.respond).toHaveBeenCalledAfter(vi.mocked(turn.resume));
    expect(second.respond).toHaveBeenCalledAfter(vi.mocked(turn.resume));
  });

  it("finds a Responses continuation by call ID", async () => {
    const { bridge } = createBridge();
    const turn = context({ kind: "responses", responseId: "resp-1" });
    const call = serverCall("rpc-1", "lookup");
    const external = bridge.register(call, turn);

    await expect(
      bridge.continue({
        kind: "responses",
        toolFingerprint: "tools-v1",
        results: [{ callId: external.id, output: "found" }],
      }),
    ).resolves.toMatchObject({
      type: "continued",
      responseId: "resp-1",
    });
    expect(call.respond).toHaveBeenCalledOnce();
  });

  it("joins only an identical active Chat continuation", async () => {
    const { bridge } = createBridge();
    const pending = Promise.withResolvers<TurnResult>();
    const turn = context({
      resume: vi.fn(() => ({
        result: pending.promise,
        events: (async function* () {
          await pending.promise;
          return yield* [];
        })(),
      })),
    });
    const call = serverCall("rpc-1", "lookup");
    const external = bridge.register(call, turn);
    const request = {
      kind: "chat" as const,
      toolFingerprint: "tools-v1",
      results: [{ callId: external.id, output: "found" }],
    };

    const owner = await bridge.continue(request);
    const retry = await bridge.continue({ ...request, serviceTier: "auto" });

    expect(owner).toMatchObject({ type: "continued" });
    expect(retry).toMatchObject({ type: "continued", joined: true });
    expect(turn.resume).toHaveBeenCalledOnce();
    expect(call.respond).toHaveBeenCalledOnce();
    await expect(
      bridge.continue({
        ...request,
        results: [{ callId: external.id, output: "different" }],
      }),
    ).rejects.toMatchObject({ status: 409, code: "thread_busy" });
    await expect(
      bridge.continue({ ...request, toolFingerprint: "different-tools" }),
    ).rejects.toMatchObject({
      status: 400,
      code: "tool_definitions_changed",
    });
    pending.resolve(result());
    if (retry.type !== "continued") throw new Error("not continued");
    await expect(retry.result).resolves.toEqual(result());
  });

  it("isolates cancellation of a joined Chat continuation", async () => {
    const { bridge } = createBridge();
    const pending = Promise.withResolvers<TurnResult>();
    const turn = context({
      resume: vi.fn(() => ({
        result: pending.promise,
        events: (async function* () {
          await pending.promise;
          return yield* [];
        })(),
      })),
    });
    const call = serverCall("rpc-cancel", "lookup");
    const external = bridge.register(call, turn);
    const request = {
      kind: "chat" as const,
      toolFingerprint: "tools-v1",
      results: [{ callId: external.id, output: "found" }],
    };
    await bridge.continue(request);
    const controller = new AbortController();
    const retry = await bridge.continue({
      ...request,
      signal: controller.signal,
    });
    if (retry.type !== "continued") throw new Error("not continued");

    controller.abort();

    await expect(retry.result).rejects.toMatchObject({
      status: 499,
      code: "request_aborted",
    });
    expect(turn.invalidate).not.toHaveBeenCalled();
    pending.resolve(result());
  });

  it("keeps an active Chat retry joinable through normal turn cleanup", async () => {
    const { bridge } = createBridge();
    const pending = Promise.withResolvers<TurnResult>();
    const turn = context({
      resume: vi.fn(() => ({
        result: pending.promise,
        events: (async function* () {
          await pending.promise;
          return yield* [];
        })(),
      })),
    });
    const call = serverCall("rpc-cleanup", "lookup");
    const external = bridge.register(call, turn);
    const request = {
      kind: "chat" as const,
      toolFingerprint: "tools-v1",
      results: [{ callId: external.id, output: "found" }],
    };

    await bridge.continue(request);
    bridge.complete(turn);
    const retry = await bridge.continue(request);

    expect(retry).toMatchObject({ type: "continued", joined: true });
    pending.resolve(result());
    if (retry.type !== "continued") throw new Error("not continued");
    await expect(retry.result).resolves.toEqual(result());
  });

  it("invalidates an active Chat retry after normal turn cleanup", async () => {
    const { bridge } = createBridge();
    const pending = Promise.withResolvers<TurnResult>();
    const turn = context({
      resume: vi.fn(() => ({
        result: pending.promise,
        events: (async function* () {
          await pending.promise;
          return yield* [];
        })(),
      })),
    });
    const call = serverCall("rpc-invalidate", "lookup");
    const external = bridge.register(call, turn);
    const request = {
      kind: "chat" as const,
      toolFingerprint: "tools-v1",
      results: [{ callId: external.id, output: "found" }],
    };

    await bridge.continue(request);
    bridge.complete(turn);
    bridge.invalidateAll();

    await expect(bridge.continue(request)).resolves.toEqual({ type: "lost" });
    expect(turn.invalidate).toHaveBeenCalledOnce();
    pending.resolve(result());
  });

  it("expires invalidated Chat continuation tombstones", async () => {
    const { bridge, setNow } = createBridge();
    const pending = Promise.withResolvers<TurnResult>();
    const turn = context({
      resume: vi.fn(() => ({
        result: pending.promise,
        events: (async function* () {
          await pending.promise;
          return yield* [];
        })(),
      })),
    });
    const call = serverCall("rpc-tombstone", "lookup");
    const external = bridge.register(call, turn);
    const request = {
      kind: "chat" as const,
      toolFingerprint: "tools-v1",
      results: [{ callId: external.id, output: "found" }],
    };

    await bridge.continue(request);
    bridge.invalidateAll();
    await expect(bridge.continue(request)).resolves.toEqual({ type: "lost" });

    setNow(1_000 + 15 * 60 * 1_000);
    await expect(bridge.continue(request)).rejects.toMatchObject({
      status: 400,
      code: "unknown_tool_call",
    });
    pending.resolve(result());
  });

  it.each([
    ["undeclared tool", { tool: "filesystem", namespace: null }],
    ["namespaced tool", { tool: "weather", namespace: "internal" }],
  ] as const)(
    "rejects an %s before allocating an external ID",
    (_name, override) => {
      const { bridge } = createBridge();
      const call = serverCall("rpc-secret", override.tool);
      call.params.namespace = override.namespace;

      expect(() => bridge.register(call, context())).toThrowError(
        expect.objectContaining({ code: "codex_protocol_error", status: 502 }),
      );
      expect(call.reject).toHaveBeenCalledWith(
        -32602,
        "Tool call did not match the active turn",
      );
      expect(bridge.pending).toBe(0);
      expect(JSON.stringify(vi.mocked(call.reject).mock.calls)).not.toContain(
        "filesystem",
      );
    },
  );

  it("does not resolve a partial set and rejects unknown or duplicate IDs", async () => {
    const { bridge } = createBridge();
    const turn = context();
    const first = serverCall("rpc-1", "first");
    const second = serverCall("rpc-2", "second");
    const externalFirst = bridge.register(first, turn);
    const externalSecond = bridge.register(second, turn);

    await expect(
      bridge.continue({
        kind: "chat",
        toolFingerprint: "tools-v1",
        results: [{ callId: externalFirst.id, output: "one" }],
      }),
    ).resolves.toEqual({
      type: "incomplete",
      missingCallIds: [externalSecond.id],
    });
    expect(first.respond).not.toHaveBeenCalled();
    expect(second.respond).not.toHaveBeenCalled();

    await expect(
      bridge.continue({
        kind: "chat",
        toolFingerprint: "tools-v1",
        results: [
          { callId: externalFirst.id, output: "one" },
          { callId: "call_g7_unknown", output: "unknown" },
        ],
      }),
    ).rejects.toMatchObject({ status: 400, code: "unknown_tool_call" });
    await expect(
      bridge.continue({
        kind: "chat",
        toolFingerprint: "tools-v1",
        results: [
          { callId: externalFirst.id, output: "one" },
          { callId: externalFirst.id, output: "again" },
        ],
      }),
    ).rejects.toMatchObject({ status: 400, code: "duplicate_tool_output" });
  });

  it("buffers partial Responses outputs and re-exposes pending calls", async () => {
    const { bridge } = createBridge();
    const turn = context({ kind: "responses", responseId: "resp-1" });
    const first = serverCall("rpc-1", "first");
    const second = serverCall("rpc-2", "second");
    const externalFirst = bridge.register(first, turn);
    const externalSecond = bridge.register(second, turn);

    const partial = await bridge.continue({
      kind: "responses",
      responseId: "resp-1",
      toolFingerprint: "tools-v1",
      results: [{ callId: externalFirst.id, output: "one" }],
    });

    expect(partial.type).toBe("continued");
    if (partial.type !== "continued") throw new Error("not continued");
    await expect(partial.result).resolves.toMatchObject({
      finishReason: "tool_calls",
      toolCalls: [externalSecond],
    });
    expect(first.respond).not.toHaveBeenCalled();
    expect(second.respond).not.toHaveBeenCalled();
    expect(turn.resume).not.toHaveBeenCalled();

    await expect(
      bridge.continue({
        kind: "responses",
        responseId: "resp-1",
        toolFingerprint: "tools-v1",
        results: [{ callId: externalSecond.id, output: "two" }],
      }),
    ).resolves.toMatchObject({ type: "continued" });
    expect(turn.resume).toHaveBeenCalledOnce();
    expect(first.respond).toHaveBeenCalledWith({
      success: true,
      contentItems: [{ type: "inputText", text: "one" }],
    });
    expect(second.respond).toHaveBeenCalledWith({
      success: true,
      contentItems: [{ type: "inputText", text: "two" }],
    });
  });

  it("does not buffer a Responses output into a Chat turn", async () => {
    const { bridge } = createBridge();
    const turn = context({ kind: "chat" });
    const first = serverCall("rpc-1", "first");
    const second = serverCall("rpc-2", "second");
    const externalFirst = bridge.register(first, turn);
    const externalSecond = bridge.register(second, turn);

    await expect(
      bridge.continue({
        kind: "responses",
        toolFingerprint: "tools-v1",
        results: [{ callId: externalFirst.id, output: "one" }],
      }),
    ).rejects.toMatchObject({ status: 400, code: "unknown_tool_call" });

    await expect(
      bridge.continue({
        kind: "chat",
        toolFingerprint: "tools-v1",
        results: [
          { callId: externalFirst.id, output: "one" },
          { callId: externalSecond.id, output: "two" },
        ],
      }),
    ).resolves.toMatchObject({ type: "continued" });
    expect(first.respond).toHaveBeenCalledOnce();
    expect(second.respond).toHaveBeenCalledOnce();
  });

  it("sanitizes failed client tool results", async () => {
    const { bridge } = createBridge();
    const turn = context();
    const call = serverCall("rpc-1", "danger");
    const external = bridge.register(call, turn);

    await bridge.continue({
      kind: "chat",
      toolFingerprint: "tools-v1",
      results: [
        {
          callId: external.id,
          output: "secret client stack and credentials",
          success: false,
        },
      ],
    });

    expect(call.respond).toHaveBeenCalledWith({
      success: false,
      contentItems: [{ type: "inputText", text: "Tool execution failed" }],
    });
  });

  it("rejects mismatched definitions without consuming the pending call", async () => {
    const { bridge, host } = createBridge();
    const turn = context();
    const call = serverCall("rpc-1", "lookup");
    const external = bridge.register(call, turn);

    await expect(
      bridge.continue({
        kind: "chat",
        toolFingerprint: "different-tools",
        results: [{ callId: external.id, output: "found" }],
      }),
    ).rejects.toMatchObject({ status: 400, code: "tool_definitions_changed" });
    expect(turn.invalidate).not.toHaveBeenCalled();
    expect(call.reject).not.toHaveBeenCalled();

    await expect(
      bridge.continue({
        kind: "chat",
        toolFingerprint: "tools-v1",
        results: [{ callId: external.id, output: "found" }],
      }),
    ).resolves.toMatchObject({ type: "continued" });

    const nextTurn = context();
    const nextCall = serverCall("rpc-2", "lookup");
    const nextExternal = bridge.register(nextCall, nextTurn);
    (host as { generation: number }).generation = 8;
    await expect(
      bridge.continue({
        kind: "chat",
        toolFingerprint: "tools-v1",
        results: [{ callId: nextExternal.id, output: "found" }],
      }),
    ).resolves.toEqual({ type: "lost" });
    expect(nextTurn.invalidate).toHaveBeenCalledOnce();
  });

  it("rejects a changed service tier without consuming the pending call", async () => {
    const { bridge } = createBridge();
    const turn = context({ serviceTier: "priority" });
    const call = serverCall("rpc-1", "lookup");
    const external = bridge.register(call, turn);

    await expect(
      bridge.continue({
        kind: "chat",
        serviceTier: "default",
        toolFingerprint: "tools-v1",
        results: [{ callId: external.id, output: "found" }],
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "service_tier_changed",
      param: "service_tier",
    });
    expect(call.respond).not.toHaveBeenCalled();

    await expect(
      bridge.continue({
        kind: "chat",
        serviceTier: "priority",
        toolFingerprint: "tools-v1",
        results: [{ callId: external.id, output: "found" }],
      }),
    ).resolves.toMatchObject({ type: "continued" });
  });

  it("expires a suspended turn once after fifteen minutes", () => {
    const { bridge, setNow } = createBridge();
    const turn = context();
    const call = serverCall("rpc-1", "lookup");
    bridge.register(call, turn);
    expect(bridge.pending).toBe(1);
    expect(bridge.expired).toBe(0);

    setNow(1_000 + 15 * 60 * 1_000 - 1);
    bridge.expire(1_000 + 15 * 60 * 1_000 - 1);
    expect(turn.invalidate).not.toHaveBeenCalled();
    setNow(1_000 + 15 * 60 * 1_000);
    bridge.expire(1_000 + 15 * 60 * 1_000);
    bridge.expire(1_000 + 15 * 60 * 1_000 + 1);

    expect(turn.invalidate).toHaveBeenCalledOnce();
    expect(call.reject).toHaveBeenCalledOnce();
    expect(bridge.pending).toBe(0);
    expect(bridge.expired).toBe(1);
  });

  it("awaits Responses invalidation cleanup", async () => {
    const { bridge } = createBridge();
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const turn = context({
      kind: "responses",
      responseId: "resp-1",
      invalidate: vi.fn(() => cleanup),
    });
    bridge.register(serverCall("rpc-1", "lookup"), turn);
    let settled = false;

    const invalidation = Promise.resolve(
      bridge.invalidateResponse("resp-1"),
    ).then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    finishCleanup();
    await invalidation;
    expect(turn.invalidate).toHaveBeenCalledOnce();
  });
});
