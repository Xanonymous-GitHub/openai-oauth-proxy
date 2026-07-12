import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDataApp } from "../../src/app.js";
import {
  fakeModel,
  fakeModelListResponse,
  fakeThread,
  fakeThreadStartResponse,
  fakeTurn,
} from "../../src/codex/fake.js";
import type {
  CodexHost,
  HostNotification,
  PendingServerToolCall,
} from "../../src/codex/host.js";
import {
  type ConversationClock,
  ConversationStore,
} from "../../src/conversations/store.js";
import {
  recoverResponseOperations,
  startResponseSweeper,
  sweepExpiredResponses,
} from "../../src/openai/responses.js";
import { createLogger, type Logger } from "../../src/operations/log.js";
import { ToolBridge } from "../../src/tools/bridge.js";
import type {
  ProxyStreamEvent,
  TurnCommand,
  TurnResult,
} from "../../src/turns/events.js";
import type {
  TurnLifecycleCallbacks,
  TurnRunner,
} from "../../src/turns/runner.js";
import { TurnRunner as ActualTurnRunner } from "../../src/turns/runner.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const bifrostToken = "b".repeat(32);
const authorization = { authorization: `Bearer ${bifrostToken}` };

let now = 1_700_000_000_000;
const clock: ConversationClock = { now: () => now };
const directories = new Set<string>();
const stores = new Set<ConversationStore>();

interface RunnerInvocation {
  command: TurnCommand;
  threadId: string;
  turnId: string;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(value: IteratorResult<T>) => void> = [];

  push(value: T): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#values.push(value);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value) return { done: false, value };
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function openStore(): ConversationStore {
  const directory = mkdtempSync(join(tmpdir(), "responses-route-"));
  directories.add(directory);
  const store = ConversationStore.open(join(directory, "proxy.sqlite"), clock, {
    responseTtlMs: 7 * DAY_MS,
    turnLeaseMs: 10 * 60 * 1_000,
    toolLeaseMs: 15 * 60 * 1_000,
  });
  stores.add(store);
  return store;
}

afterEach(() => {
  for (const store of stores) store.close();
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
  stores.clear();
  directories.clear();
  now = 1_700_000_000_000;
});

function createFixture(
  options: {
    failAt?: number;
    supportsImage?: boolean;
    streamWriteFailureAt?: number;
    iteratorFails?: boolean;
    logger?: Logger;
  } = {},
) {
  const store = openStore();
  const operationWorkingDirectory = mkdtempSync(
    join(tmpdir(), "responses-operations-"),
  );
  directories.add(operationWorkingDirectory);
  const invocations: RunnerInvocation[] = [];
  const deleteThread = vi.fn(async () => undefined);
  const streamEvents: string[] = [];
  let call = 0;

  const execute = async (
    command: TurnCommand,
    lifecycle?: TurnLifecycleCallbacks,
  ): Promise<TurnResult> => {
    call += 1;
    const threadId =
      command.action.type === "start"
        ? `thread-${call}`
        : command.action.type === "resume"
          ? command.action.threadId
          : `thread-fork-${call}`;
    const turnId = `turn-${call}`;
    await lifecycle?.opened?.(threadId);
    await lifecycle?.started?.(threadId, turnId);
    invocations.push({ command, threadId, turnId });
    try {
      if (options.failAt === call) throw new Error("interrupted fixture turn");
      return {
        threadId,
        turnId,
        text: `answer-${call}`,
        finishReason: "stop",
        usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 },
      };
    } finally {
      await Promise.all([
        lifecycle?.release?.(),
        lifecycle?.cleanup?.(threadId),
      ]);
    }
  };
  const runner = {
    run: vi.fn(
      async (
        command: TurnCommand,
        _signal?: AbortSignal,
        lifecycle?: TurnLifecycleCallbacks,
      ) => execute(command, lifecycle),
    ),
    stream: vi.fn(async function* (
      command: TurnCommand,
      _signal?: AbortSignal,
      lifecycle?: TurnLifecycleCallbacks,
    ): AsyncIterable<ProxyStreamEvent> {
      let result: TurnResult;
      try {
        result = await execute(command, lifecycle);
      } catch {
        yield {
          type: "failed",
          error: new Error("fixture failure") as never,
        };
        return;
      }
      yield { type: "text.delta", delta: result.text };
      if (options.iteratorFails) throw new Error("iterator transport failed");
      if (result.usage) yield { type: "usage", usage: result.usage };
      yield { type: "completed", result };
    }),
  } as unknown as TurnRunner;
  const host = {
    generation: 1,
    modelList: vi.fn(async () =>
      fakeModelListResponse({
        data: [
          fakeModel({
            id: "gpt-5.4",
            model: "gpt-5.4",
            inputModalities: options.supportsImage
              ? ["text", "image"]
              : ["text"],
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Low" },
              { reasoningEffort: "high", description: "High" },
            ],
          }),
        ],
      }),
    ),
  } as unknown as CodexHost;
  (runner as unknown as { tools: ToolBridge }).tools = new ToolBridge({ host });
  const app = createDataApp({
    health: () => true,
    ready: () => true,
    accountReady: () => true,
    draining: () => false,
    bifrostToken,
    metricsToken: "m".repeat(32),
    host,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    processGeneration: () => host.generation,
    responses: {
      runner,
      store,
      clock,
      processGeneration: () => host.generation,
      operationWorkingDirectory,
      deleteThread,
      ...(options.streamWriteFailureAt === undefined
        ? {}
        : {
            streamSSE: ((
              _context: unknown,
              callback: (stream: unknown) => Promise<void>,
            ) => {
              let writes = 0;
              let payload = "";
              const body = new ReadableStream({
                start(controller) {
                  const stream = {
                    onAbort() {},
                    async writeSSE(event: { event?: string; data: string }) {
                      writes += 1;
                      if (writes === options.streamWriteFailureAt) {
                        throw new Error(`stream write ${writes} failed`);
                      }
                      if (event.event !== undefined)
                        streamEvents.push(event.event);
                      payload += `${event.event ? `event: ${event.event}\n` : ""}data: ${event.data}\n\n`;
                    },
                  };
                  void callback(stream).then(
                    () => {
                      controller.enqueue(new TextEncoder().encode(payload));
                      controller.close();
                    },
                    (error) => controller.error(error),
                  );
                },
              });
              return new Response(body, {
                headers: { "content-type": "text/event-stream" },
              });
            }) as never,
          }),
    },
  });

  return {
    app,
    deleteThread,
    host,
    invocations,
    operationWorkingDirectory,
    runner,
    store,
    streamEvents,
  };
}

function createToolFixture(
  options: {
    deleteThreadError?: Error;
    deleteThread?: () => Promise<void>;
    logger?: Logger;
    streamAbortAt?: number;
    streamWriteFailureAt?: number;
  } = {},
) {
  const store = openStore();
  const operationWorkingDirectory = mkdtempSync(
    join(tmpdir(), "responses-tool-operations-"),
  );
  directories.add(operationWorkingDirectory);
  const events = new AsyncQueue<HostNotification>();
  const tools = new AsyncQueue<PendingServerToolCall>();
  const deleteThread = vi.fn(async () => {
    if (options.deleteThread) await options.deleteThread();
    if (options.deleteThreadError) throw options.deleteThreadError;
  });
  const streamEvents: string[] = [];
  const host = {
    generation: 1,
    modelList: vi.fn(async () =>
      fakeModelListResponse({
        data: [fakeModel({ id: "gpt-5.4", model: "gpt-5.4" })],
      }),
    ),
    threadStart: vi.fn(async () => fakeThreadStartResponse()),
    threadResume: vi.fn(),
    threadFork: vi.fn(),
    threadInjectItems: vi.fn(async () => ({})),
    threadDelete: vi.fn(async () => ({})),
    turnStart: vi.fn(async () => ({ turn: fakeTurn() })),
    turnInterrupt: vi.fn(async ({ threadId, turnId }) => {
      events.push({
        generation: host.generation,
        method: "turn/completed",
        params: {
          threadId,
          turn: fakeTurn({ id: turnId, status: "interrupted" }),
        },
      });
      return {};
    }),
    events: vi.fn(() => events),
    toolCalls: vi.fn(() => tools),
  } as unknown as CodexHost;
  const runner = new ActualTurnRunner({
    host,
    emptyWorkingDirectory: "/tmp/work",
    neutralInstructions: "Use only the supplied interface.",
    interruptWaitMs: 10,
  });
  const app = createDataApp({
    health: () => true,
    ready: () => true,
    accountReady: () => true,
    draining: () => false,
    bifrostToken,
    metricsToken: "m".repeat(32),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    host,
    responses: {
      runner,
      store,
      clock,
      processGeneration: () => host.generation,
      operationWorkingDirectory,
      deleteThread,
      ...(options.streamAbortAt === undefined &&
      options.streamWriteFailureAt === undefined
        ? {}
        : {
            streamSSE: ((
              _context: unknown,
              callback: (stream: unknown) => Promise<void>,
            ) => {
              let writes = 0;
              let onAbort: () => void = () => undefined;
              let payload = "";
              const body = new ReadableStream({
                start(controller) {
                  const stream = {
                    onAbort(callback: () => void) {
                      onAbort = callback;
                    },
                    async writeSSE(event: { event?: string; data: string }) {
                      writes += 1;
                      if (writes === options.streamAbortAt) {
                        onAbort();
                        return;
                      }
                      if (writes === options.streamWriteFailureAt) {
                        throw new Error(`stream write ${writes} failed`);
                      }
                      if (event.event !== undefined)
                        streamEvents.push(event.event);
                      payload += `${event.event ? `event: ${event.event}\n` : ""}data: ${event.data}\n\n`;
                    },
                  };
                  void callback(stream).then(
                    () => {
                      controller.enqueue(new TextEncoder().encode(payload));
                      controller.close();
                    },
                    (error) => controller.error(error),
                  );
                },
              });
              return new Response(body, {
                headers: { "content-type": "text/event-stream" },
              });
            }) as never,
          }),
    },
  });
  const complete = (text: string) => {
    events.push({
      generation: host.generation,
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        completedAtMs: now,
        item: {
          type: "agentMessage",
          id: "message-1",
          text,
          phase: null,
          memoryCitation: null,
        },
      },
    });
    events.push({
      generation: host.generation,
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: fakeTurn({ id: "turn-1", status: "completed" }),
      },
    });
  };
  return {
    app,
    complete,
    deleteThread,
    events,
    host,
    operationWorkingDirectory,
    runner,
    store,
    streamEvents,
    tools,
  };
}

async function postResponse(
  app: ReturnType<typeof createFixture>["app"],
  body: unknown,
): Promise<Response> {
  return app.request("/v1/responses", {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function postJson(
  app: ReturnType<typeof createFixture>["app"],
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await postResponse(app, body);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe("POST /v1/responses", () => {
  it("starts, resumes the latest response, and forks inclusively from an older response", async () => {
    const { app, invocations } = createFixture();

    const first = await postJson(app, { model: "gpt-5.4", input: "first" });
    const latest = await postJson(app, {
      model: "gpt-5.4",
      input: "latest",
      previous_response_id: first.id,
    });
    await postJson(app, {
      model: "gpt-5.4",
      input: "branch",
      previous_response_id: first.id,
    });

    expect(first.id).toMatch(/^resp_[A-Za-z0-9_-]{32}$/);
    expect(latest.id).toMatch(/^resp_[A-Za-z0-9_-]{32}$/);
    expect(invocations.map(({ command }) => command.action)).toEqual([
      { type: "start" },
      { type: "resume", threadId: "thread-1" },
      { type: "fork", threadId: "thread-1", lastTurnId: "turn-1" },
    ]);
  });

  it("returns stable not-found and busy errors without calling upstream", async () => {
    const { app, invocations, store } = createFixture();
    const missing = await postResponse(app, {
      model: "gpt-5.4",
      input: "missing",
      previous_response_id: "resp_missing",
    });
    const first = await postJson(app, { model: "gpt-5.4", input: "first" });
    expect(store.acquireLease("thread-1", "competing", "turn", 1)).toBe(true);
    const busy = await postResponse(app, {
      model: "gpt-5.4",
      input: "busy",
      previous_response_id: first.id,
    });

    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: { code: "response_not_found", param: "previous_response_id" },
    });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: { code: "thread_busy" } });
    expect(invocations).toHaveLength(1);
  });

  it("returns response_not_found after a stored response expires", async () => {
    const { app, invocations } = createFixture();
    const first = await postJson(app, { model: "gpt-5.4", input: "first" });
    now += 7 * DAY_MS;

    const response = await postResponse(app, {
      model: "gpt-5.4",
      input: "too late",
      previous_response_id: first.id,
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "response_not_found" },
    });
    expect(invocations).toHaveLength(1);
  });

  it("stores only completed turns and slides successful continuation expiry", async () => {
    const { app, store } = createFixture({ failAt: 2 });
    const first = await postJson(app, { model: "gpt-5.4", input: "first" });
    const original = store.lookup(first.id as string);
    now += DAY_MS;

    const interrupted = await postResponse(app, {
      model: "gpt-5.4",
      input: "interrupted",
      previous_response_id: first.id,
    });

    expect(interrupted.status).toBe(500);
    expect(store.lookup(first.id as string)).toMatchObject({
      state: "complete",
      expiresAt: now + 7 * DAY_MS,
    });
    expect(store.lookup(first.id as string)?.expiresAt).toBeGreaterThan(
      original?.expiresAt ?? 0,
    );
    const retry = await postResponse(app, {
      model: "gpt-5.4",
      input: "retry",
      previous_response_id: first.id,
    });
    expect(retry.status).toBe(200);
  });

  it("projects ordinary output, instructions, structured output, and usage", async () => {
    const { app, invocations } = createFixture();
    const response = await postResponse(app, {
      model: "gpt-5.4",
      input: [
        { role: "system", content: "history" },
        { role: "user", content: "question" },
      ],
      instructions: "newest developer instruction",
      reasoning: { effort: "high" },
      text: {
        format: {
          type: "json_schema",
          name: "answer",
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
          },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: expect.stringMatching(/^resp_/),
      object: "response",
      status: "completed",
      model: "gpt-5.4",
      output: [
        {
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "answer-1", annotations: [] }],
        },
      ],
      usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 },
    });
    expect(invocations[0]?.command).toMatchObject({
      instructions: "newest developer instruction",
      effort: "high",
      outputSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
      },
    });
  });

  it("durably suspends and completes a function call on the original response turn", async () => {
    const fixture = createToolFixture();
    const respond = vi.fn(() => fixture.complete("weather complete"));
    vi.mocked(fixture.host.turnStart).mockImplementationOnce(async () => {
      fixture.tools.push({
        generation: 1,
        id: "rpc-secret",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "internal-secret",
          namespace: null,
          tool: "weather",
          arguments: { city: "Paris" },
        },
        respond,
        reject: vi.fn(),
      });
      return { turn: fakeTurn() };
    });
    const definitions = [
      {
        type: "function" as const,
        name: "weather",
        description: "Read weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      },
    ];

    const suspended = await postResponse(fixture.app, {
      model: "gpt-5.4",
      input: "weather",
      tools: definitions,
    });
    const body = (await suspended.json()) as {
      id: string;
      output: Array<{ type: string; call_id: string }>;
    };
    const callId = body.output[0]?.call_id ?? "missing";

    expect(suspended.status).toBe(200);
    expect(body).toMatchObject({
      id: expect.stringMatching(/^resp_/),
      status: "completed",
      output: [
        {
          type: "function_call",
          status: "completed",
          call_id: expect.stringMatching(/^call_g1_/),
          name: "weather",
          arguments: '{"city":"Paris"}',
        },
      ],
    });
    expect(fixture.store.lookup(body.id)).toMatchObject({ state: "pending" });
    expect(fixture.store.lookupOperation(body.id)).toMatchObject({
      state: "active",
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const completed = await postResponse(fixture.app, {
      model: "gpt-5.4",
      previous_response_id: body.id,
      tools: definitions,
      input: [
        { type: "function_call_output", call_id: callId, output: "sunny" },
      ],
    });

    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      id: body.id,
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "weather complete" }],
        },
      ],
    });
    expect(fixture.host.turnStart).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith({
      success: true,
      contentItems: [{ type: "inputText", text: "sunny" }],
    });
    expect(fixture.store.lookup(body.id)).toMatchObject({ state: "complete" });
    expect(fixture.store.lookupOperation(body.id)).toBeUndefined();
  });

  it("supports parallel and repeated Responses tool loops on one turn", async () => {
    const fixture = createToolFixture();
    let parallelResults = 0;
    const pushCall = (
      id: string,
      tool: string,
      onRespond: () => void,
    ): void => {
      fixture.tools.push({
        generation: 1,
        id,
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: `internal-${id}`,
          namespace: null,
          tool,
          arguments: {},
        },
        respond: vi.fn(onRespond),
        reject: vi.fn(),
      });
    };
    vi.mocked(fixture.host.turnStart).mockImplementationOnce(async () => {
      for (const [id, tool] of [
        ["one", "first"],
        ["two", "second"],
      ] as const) {
        pushCall(id, tool, () => {
          parallelResults += 1;
          if (parallelResults === 2) {
            pushCall("three", "third", () => fixture.complete("all done"));
          }
        });
      }
      return { turn: fakeTurn() };
    });
    const definitions = ["first", "second", "third"].map((name) => ({
      type: "function" as const,
      name,
      parameters: { type: "object" },
    }));
    const first = await postResponse(fixture.app, {
      model: "gpt-5.4",
      input: "start",
      tools: definitions,
    });
    const firstBody = (await first.json()) as {
      id: string;
      output: Array<{ call_id: string }>;
    };
    const second = await postResponse(fixture.app, {
      model: "gpt-5.4",
      previous_response_id: firstBody.id,
      tools: definitions,
      input: firstBody.output.map((call, index) => ({
        type: "function_call_output",
        call_id: call.call_id,
        output: `result-${index}`,
      })),
    });
    const secondBody = (await second.json()) as {
      id: string;
      output: Array<{ call_id: string }>;
    };

    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.output).toHaveLength(1);
    expect(fixture.store.lookup(firstBody.id)).toMatchObject({
      state: "pending",
    });

    const completed = await postResponse(fixture.app, {
      model: "gpt-5.4",
      previous_response_id: firstBody.id,
      tools: definitions,
      input: [
        {
          type: "function_call_output",
          call_id: secondBody.output[0]?.call_id,
          output: "third result",
        },
      ],
    });
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      id: firstBody.id,
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "all done" }],
        },
      ],
    });
    expect(fixture.host.turnStart).toHaveBeenCalledOnce();
    expect(fixture.host.toolCalls).toHaveBeenCalledOnce();
  });

  it("returns stable lost semantics for an old-generation pending response", async () => {
    const fixture = createToolFixture();
    vi.mocked(fixture.host.turnStart).mockImplementationOnce(async () => {
      fixture.tools.push({
        generation: 1,
        id: "rpc-secret",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "internal-secret",
          namespace: null,
          tool: "lookup",
          arguments: {},
        },
        respond: vi.fn(),
        reject: vi.fn(),
      });
      return { turn: fakeTurn() };
    });
    const definitions = [
      { type: "function" as const, name: "lookup", parameters: {} },
    ];
    const suspended = await postResponse(fixture.app, {
      model: "gpt-5.4",
      input: "lookup",
      tools: definitions,
    });
    const body = (await suspended.json()) as {
      id: string;
      output: Array<{ call_id: string }>;
    };
    (fixture.host as { generation: number }).generation = 2;

    const continuation = await postResponse(fixture.app, {
      model: "gpt-5.4",
      previous_response_id: body.id,
      tools: definitions,
      input: [
        {
          type: "function_call_output",
          call_id: body.output[0]?.call_id ?? "missing",
          output: "found",
        },
      ],
    });

    expect(continuation.status).toBe(409);
    expect(await continuation.json()).toMatchObject({
      error: { code: "proxy_continuation_lost" },
    });
    await vi.waitFor(() =>
      expect(fixture.store.lookup(body.id)).toMatchObject({ state: "lost" }),
    );
    expect(fixture.host.turnInterrupt).not.toHaveBeenCalled();
  });

  it("interrupts and releases the lease when durable loss cleanup rejects", async () => {
    const fixture = createToolFixture({
      deleteThreadError: new Error("sensitive delete failure"),
    });
    vi.mocked(fixture.host.turnStart).mockImplementationOnce(async () => {
      fixture.tools.push({
        generation: 1,
        id: "rpc-cleanup-reject",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "internal-cleanup-reject",
          namespace: null,
          tool: "lookup",
          arguments: {},
        },
        respond: vi.fn(),
        reject: vi.fn(),
      });
      return { turn: fakeTurn() };
    });
    const suspended = await postResponse(fixture.app, {
      model: "gpt-5.4",
      input: "lookup",
      tools: [{ type: "function", name: "lookup", parameters: {} }],
    });
    const body = (await suspended.json()) as { id: string };

    fixture.runner.tools.invalidateResponse(body.id);

    await vi.waitFor(() =>
      expect(fixture.host.turnInterrupt).toHaveBeenCalledOnce(),
    );
    expect(fixture.deleteThread).toHaveBeenCalledOnce();
    expect(fixture.store.lookup(body.id)).toMatchObject({ state: "lost" });
    expect(
      fixture.store.acquireLease("thread-1", "lease-probe", "turn", 1),
    ).toBe(true);
    expect(readdirSync(fixture.operationWorkingDirectory)).toEqual([]);
  });

  it("rejects a strict definition change without consuming the pending call", async () => {
    const fixture = createToolFixture();
    const respond = vi.fn(() => fixture.complete("strict complete"));
    vi.mocked(fixture.host.turnStart).mockImplementationOnce(async () => {
      fixture.tools.push({
        generation: 1,
        id: "rpc-strict",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "internal-strict",
          namespace: null,
          tool: "lookup",
          arguments: {},
        },
        respond,
        reject: vi.fn(),
      });
      return { turn: fakeTurn() };
    });
    const strictTools = [
      {
        type: "function" as const,
        name: "lookup",
        parameters: {},
        strict: true,
      },
    ];
    const suspended = await postResponse(fixture.app, {
      model: "gpt-5.4",
      input: "lookup",
      tools: strictTools,
    });
    const body = (await suspended.json()) as {
      id: string;
      output: Array<{ call_id: string }>;
    };
    const callId = body.output[0]?.call_id ?? "missing";

    const mismatch = await postResponse(fixture.app, {
      model: "gpt-5.4",
      previous_response_id: body.id,
      tools: [{ ...strictTools[0], strict: false }],
      input: [
        { type: "function_call_output", call_id: callId, output: "found" },
      ],
    });

    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({
      error: { code: "tool_definitions_changed" },
    });
    expect(respond).not.toHaveBeenCalled();
    expect(fixture.store.lookup(body.id)).toMatchObject({ state: "pending" });

    const completed = await postResponse(fixture.app, {
      model: "gpt-5.4",
      previous_response_id: body.id,
      tools: strictTools,
      input: [
        { type: "function_call_output", call_id: callId, output: "found" },
      ],
    });
    expect(completed.status).toBe(200);
  });

  it.each([
    ["initial write", { streamWriteFailureAt: 1 }],
    ["mid-item write", { streamWriteFailureAt: 3 }],
    ["final write", { streamWriteFailureAt: 10 }],
    [
      "write with cleanup rejection",
      {
        streamWriteFailureAt: 1,
        deleteThreadError: new Error("sensitive delete failure"),
      },
    ],
    ["abort", { streamAbortAt: 2 }],
  ] as const)("invalidates every repeated call after a continuation stream %s failure", async (_name, streamFailure) => {
    const fixture = createToolFixture(streamFailure);
    const repeatedRejects = [vi.fn(), vi.fn()];
    const firstRespond = vi.fn(() => {
      for (const [index, tool] of ["second", "third"].entries()) {
        fixture.tools.push({
          generation: 1,
          id: `rpc-repeat-${index}`,
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: `internal-repeat-${index}`,
            namespace: null,
            tool,
            arguments: { index },
          },
          respond: vi.fn(),
          reject: repeatedRejects[index] ?? vi.fn(),
        });
      }
    });
    vi.mocked(fixture.host.turnStart).mockImplementationOnce(async () => {
      fixture.tools.push({
        generation: 1,
        id: "rpc-first",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "internal-first",
          namespace: null,
          tool: "first",
          arguments: {},
        },
        respond: firstRespond,
        reject: vi.fn(),
      });
      return { turn: fakeTurn() };
    });
    const definitions = ["first", "second", "third"].map((name) => ({
      type: "function" as const,
      name,
      parameters: { type: "object" },
    }));
    const suspended = await postResponse(fixture.app, {
      model: "gpt-5.4",
      input: "start",
      tools: definitions,
    });
    const body = (await suspended.json()) as {
      id: string;
      output: Array<{ call_id: string }>;
    };
    const continuation = await postResponse(fixture.app, {
      model: "gpt-5.4",
      previous_response_id: body.id,
      tools: definitions,
      stream: true,
      input: [
        {
          type: "function_call_output",
          call_id: body.output[0]?.call_id ?? "missing",
          output: "first result",
        },
      ],
    });

    if (_name === "abort")
      await expect(continuation.text()).resolves.toBeDefined();
    else
      await expect(continuation.text()).rejects.toThrow(
        /stream write \d+ failed/,
      );
    await vi.waitFor(() =>
      expect(fixture.host.turnInterrupt).toHaveBeenCalledOnce(),
    );
    expect(repeatedRejects[0]).toHaveBeenCalledOnce();
    expect(repeatedRejects[1]).toHaveBeenCalledOnce();
    expect(fixture.deleteThread).toHaveBeenCalledOnce();
    expect(fixture.streamEvents).not.toContain("response.completed");
    expect(
      fixture.store.acquireLease("thread-1", "lease-probe", "turn", 1),
    ).toBe(true);
  });

  it("returns response_not_found for outputs targeting an unknown response", async () => {
    const { app, invocations } = createFixture();
    const response = await postResponse(app, {
      model: "gpt-5.4",
      previous_response_id: "resp_missing",
      tools: [{ type: "function", name: "lookup", parameters: {} }],
      input: [
        {
          type: "function_call_output",
          call_id: "call_g1_unknown",
          output: "found",
        },
      ],
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "response_not_found" },
    });
    expect(invocations).toEqual([]);
  });

  it("returns an opaque store=false ID without creating a resumable mapping", async () => {
    const { app, deleteThread, store } = createFixture();
    const body = await postJson(app, {
      model: "gpt-5.4",
      input: "disposable",
      store: false,
    });
    const continuation = await postResponse(app, {
      model: "gpt-5.4",
      input: "cannot resume",
      previous_response_id: body.id,
    });

    expect(body.id).toMatch(/^resp_[A-Za-z0-9_-]{32}$/);
    expect(store.lookup(body.id as string)).toBeUndefined();
    expect(continuation.status).toBe(404);
    expect(deleteThread).toHaveBeenCalledOnce();
    expect(deleteThread).toHaveBeenCalledWith("thread-1");
  });

  it("deletes a store=false thread when the turn fails", async () => {
    const { app, deleteThread } = createFixture({ failAt: 1 });
    const response = await postResponse(app, {
      model: "gpt-5.4",
      input: "fails",
      store: false,
    });

    expect(response.status).toBe(500);
    expect(deleteThread).toHaveBeenCalledOnce();
  });

  it("forks store=false continuations without deleting the stored source or its live branches", async () => {
    const { app, deleteThread, invocations } = createFixture();
    const first = await postJson(app, { model: "gpt-5.4", input: "first" });
    const latest = await postJson(app, {
      model: "gpt-5.4",
      input: "latest",
      previous_response_id: first.id,
    });
    const branch = await postJson(app, {
      model: "gpt-5.4",
      input: "branch",
      previous_response_id: first.id,
    });

    await postJson(app, {
      model: "gpt-5.4",
      input: "disposable continuation",
      previous_response_id: latest.id,
      store: false,
    });
    await postJson(app, {
      model: "gpt-5.4",
      input: "source survives",
      previous_response_id: latest.id,
    });
    await postJson(app, {
      model: "gpt-5.4",
      input: "branch survives",
      previous_response_id: branch.id,
    });

    expect(invocations.map(({ command }) => command.action)).toEqual([
      { type: "start" },
      { type: "resume", threadId: "thread-1" },
      { type: "fork", threadId: "thread-1", lastTurnId: "turn-1" },
      { type: "fork", threadId: "thread-1", lastTurnId: "turn-2" },
      { type: "resume", threadId: "thread-1" },
      { type: "resume", threadId: "thread-fork-3" },
    ]);
    expect(deleteThread).toHaveBeenCalledOnce();
    expect(deleteThread).toHaveBeenCalledWith("thread-fork-4");
  });

  it("durably reserves start, resume, and fork identities before invoking the runner", async () => {
    const start = createFixture();
    const startReserve = vi.spyOn(start.store, "reserveOperation");
    vi.mocked(start.runner.run).mockImplementationOnce(async (command) => {
      const responseId = startReserve.mock.calls[0]?.[0].responseId;
      const operation = start.store.lookupOperation(responseId ?? "missing");
      expect(operation).toMatchObject({
        action: "start",
        state: "active",
        operationCwd: command.cwd,
      });
      expect(command.cwd).toBeDefined();
      expect(readdirSync(command.cwd ?? "missing")).toEqual([]);
      throw new Error("start crash window");
    });
    expect(
      (await postResponse(start.app, { model: "gpt-5.4", input: "start" }))
        .status,
    ).toBe(500);
    expect(startReserve).toHaveBeenCalledOnce();
    expect(startReserve.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(start.runner.run).mock.invocationCallOrder[0] ?? Infinity,
    );
    const startId = startReserve.mock.calls[0]?.[0].responseId;
    expect(start.store.lookupOperation(startId ?? "missing")).toMatchObject({
      action: "start",
      recoveryPending: true,
    });

    const resume = createFixture();
    const resumeSource = await postJson(resume.app, {
      model: "gpt-5.4",
      input: "source",
    });
    const resumeReserve = vi.spyOn(resume.store, "reserveOperation");
    vi.mocked(resume.runner.run).mockImplementationOnce(async () => {
      const responseId = resumeReserve.mock.calls[0]?.[0].responseId;
      expect(
        resume.store.lookupOperation(responseId ?? "missing"),
      ).toMatchObject({
        action: "resume",
        sourceThreadId: "thread-1",
        state: "active",
      });
      throw new Error("resume crash window");
    });
    expect(
      (
        await postResponse(resume.app, {
          model: "gpt-5.4",
          input: "resume",
          previous_response_id: resumeSource.id,
        })
      ).status,
    ).toBe(500);
    expect(resumeReserve).toHaveBeenCalledOnce();
    expect(resumeReserve.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(resume.runner.run).mock.invocationCallOrder.at(-1) ?? Infinity,
    );
    const resumeId = resumeReserve.mock.calls[0]?.[0].responseId;
    expect(resume.store.lookupOperation(resumeId ?? "missing")).toBeUndefined();

    const fork = createFixture();
    const forkSource = await postJson(fork.app, {
      model: "gpt-5.4",
      input: "source",
    });
    await postJson(fork.app, {
      model: "gpt-5.4",
      input: "descendant",
      previous_response_id: forkSource.id,
    });
    const forkReserve = vi.spyOn(fork.store, "reserveOperation");
    vi.mocked(fork.runner.run).mockImplementationOnce(async (command) => {
      const responseId = forkReserve.mock.calls[0]?.[0].responseId;
      expect(fork.store.lookupOperation(responseId ?? "missing")).toMatchObject(
        {
          action: "fork",
          sourceThreadId: "thread-1",
          sourceTurnId: "turn-1",
          state: "active",
          operationCwd: command.cwd,
        },
      );
      expect(command.cwd).toBeDefined();
      expect(readdirSync(command.cwd ?? "missing")).toEqual([]);
      throw new Error("fork crash window");
    });
    expect(
      (
        await postResponse(fork.app, {
          model: "gpt-5.4",
          input: "fork",
          previous_response_id: forkSource.id,
        })
      ).status,
    ).toBe(500);
    expect(forkReserve).toHaveBeenCalledOnce();
    expect(forkReserve.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(fork.runner.run).mock.invocationCallOrder.at(-1) ?? Infinity,
    );
    const forkId = forkReserve.mock.calls[0]?.[0].responseId;
    expect(fork.store.lookupOperation(forkId ?? "missing")).toMatchObject({
      action: "fork",
      recoveryPending: true,
    });
  });

  it("deletes a returned new thread once when durable thread attachment fails", async () => {
    const fixture = createFixture();
    const reserve = vi.spyOn(fixture.store, "reserveOperation");
    vi.spyOn(fixture.store, "attachOperation").mockImplementationOnce(() => {
      throw new Error("SQLite attachment failed");
    });

    const response = await postResponse(fixture.app, {
      model: "gpt-5.4",
      input: "start",
    });

    expect(response.status).toBe(500);
    const responseId = reserve.mock.calls[0]?.[0].responseId;
    expect(
      fixture.store.lookupOperation(responseId ?? "missing"),
    ).toBeUndefined();
    expect(fixture.deleteThread).toHaveBeenCalledOnce();
    expect(fixture.deleteThread).toHaveBeenCalledWith("thread-1");
  });

  it("retains a returned thread for sweep retry when attachment and deletion fail", async () => {
    const fixture = createFixture();
    const reserve = vi.spyOn(fixture.store, "reserveOperation");
    vi.spyOn(fixture.store, "attachOperation").mockImplementationOnce(() => {
      throw new Error("SQLite attachment failed");
    });
    fixture.deleteThread.mockRejectedValueOnce(new Error("delete failed"));

    const response = await postResponse(fixture.app, {
      model: "gpt-5.4",
      input: "start",
    });

    expect(response.status).toBe(500);
    const responseId = reserve.mock.calls[0]?.[0].responseId;
    expect(
      fixture.store.lookupOperation(responseId ?? "missing"),
    ).toMatchObject({
      state: "abandoned",
      threadId: "thread-1",
    });
    expect(fixture.deleteThread).toHaveBeenCalledOnce();

    await sweepExpiredResponses({
      store: fixture.store,
      deleteThread: fixture.deleteThread,
    });
    expect(fixture.deleteThread).toHaveBeenCalledTimes(2);
    expect(
      fixture.store.lookupOperation(responseId ?? "missing"),
    ).toBeUndefined();
  });

  it.each([
    [
      "disposable tools",
      {
        model: "gpt-5.4",
        input: "tool",
        store: false,
        tools: [{ type: "function", name: "lookup", parameters: {} }],
      },
      "store_required_for_tools",
    ],
    [
      "function call input",
      {
        model: "gpt-5.4",
        input: [
          {
            type: "function_call",
            call_id: "call-1",
            name: "lookup",
            arguments: "{}",
          },
        ],
      },
      "unknown_tool_call",
    ],
  ])("rejects %s before model lookup or thread start", async (_name, request, code) => {
    const { app, host, invocations } = createFixture();
    const response = await postResponse(app, request);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code } });
    expect(host.modelList).not.toHaveBeenCalled();
    expect(invocations).toEqual([]);
  });

  it("validates reasoning before acquiring a continuation lease", async () => {
    const { app, invocations } = createFixture();
    const first = await postJson(app, { model: "gpt-5.4", input: "first" });
    const invalid = await postResponse(app, {
      model: "gpt-5.4",
      input: "invalid",
      previous_response_id: first.id,
      reasoning: { effort: "medium" },
    });
    const valid = await postResponse(app, {
      model: "gpt-5.4",
      input: "valid",
      previous_response_id: first.id,
      reasoning: { effort: "low" },
    });

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: "unsupported_reasoning_effort" },
    });
    expect(valid.status).toBe(200);
    expect(invocations).toHaveLength(2);
  });

  it("validates model and image support before acquiring a continuation lease", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    const { app, invocations } = createFixture();
    const first = await postJson(app, { model: "gpt-5.4", input: "first" });
    const unknownModel = await postResponse(app, {
      model: "missing",
      input: "invalid",
      previous_response_id: first.id,
    });
    const invalidImage = await postResponse(app, {
      model: "gpt-5.4",
      input: [
        {
          role: "user",
          content: [
            { type: "input_image", image_url: `data:image/png;base64,${png}` },
          ],
        },
      ],
      previous_response_id: first.id,
    });
    const valid = await postResponse(app, {
      model: "gpt-5.4",
      input: "valid",
      previous_response_id: first.id,
    });

    expect(unknownModel.status).toBe(404);
    expect(invalidImage.status).toBe(400);
    expect(await invalidImage.json()).toMatchObject({
      error: { code: "unsupported_image_model" },
    });
    expect(valid.status).toBe(200);
    expect(invocations).toHaveLength(2);
  });

  it("translates inline image input for an image-capable model", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    const { app, invocations } = createFixture({ supportsImage: true });
    const response = await postResponse(app, {
      model: "gpt-5.4",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "describe" },
            {
              type: "input_image",
              image_url: `data:image/png;base64,${png}`,
              detail: "high",
            },
          ],
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(invocations[0]?.command.input).toEqual([
      { type: "text", text: "describe", text_elements: [] },
      {
        type: "image",
        url: `data:image/png;base64,${png}`,
        detail: "high",
      },
    ]);
  });

  it("streams only supported named events with one reserved response ID", async () => {
    const { app, store } = createFixture();
    const response = await postResponse(app, {
      model: "gpt-5.4",
      input: "stream",
      stream: true,
    });
    const frames = (await response.text()).trim().split("\n\n");
    const events = frames.map((frame) => {
      const lines = frame.split("\n");
      return {
        event: lines[0]?.replace("event: ", ""),
        data: JSON.parse(lines[1]?.replace("data: ", "") ?? "null"),
      };
    });
    const responseId = events[0]?.data.response.id as string;

    expect(events.map(({ event }) => event)).toEqual([
      "response.created",
      "response.output_text.delta",
      "response.output_text.done",
      "response.completed",
    ]);
    expect(events.map(({ data }) => data.sequence_number)).toEqual([
      0, 1, 2, 3,
    ]);
    expect(events[1]?.data).toMatchObject({
      item_id: expect.stringMatching(/^msg_/),
      logprobs: [],
    });
    expect(events[1]?.data).not.toHaveProperty("response_id");
    expect(events[2]?.data).toMatchObject({
      item_id: events[1]?.data.item_id,
      logprobs: [],
    });
    expect(events[2]?.data).not.toHaveProperty("response_id");
    expect(events[3]?.data.response.id).toBe(responseId);
    expect(events[3]?.data.response.output[0].id).toBe(events[1]?.data.item_id);
    expect(store.lookup(responseId)).toMatchObject({
      state: "complete",
      turnId: "turn-1",
    });
  });

  it("records the released Responses lease at actual stream completion", async () => {
    const write = vi.fn();
    const { app } = createFixture({ logger: createLogger(write) });
    const response = await postResponse(app, {
      model: "gpt-5.4",
      input: "private response prompt",
      stream: true,
    });

    expect(write).not.toHaveBeenCalled();
    await response.text();

    expect(write).toHaveBeenCalledOnce();
    const logged = String(write.mock.calls[0]?.[0]);
    expect(JSON.parse(logged)).toMatchObject({
      route: "responses",
      model: "gpt-5.4",
      status: 200,
      streamOutcome: "completed",
      leaseOutcome: "released",
    });
    expect(logged).not.toContain("private response prompt");
  });

  it("awaits delayed cancellation cleanup before terminal telemetry", async () => {
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const write = vi.fn();
    const fixture = createToolFixture({
      deleteThread: () => cleanup,
      logger: createLogger(write),
    });
    const response = await postResponse(fixture.app, {
      model: "gpt-5.4",
      input: "cancel after start",
      stream: true,
    });
    await vi.waitFor(() =>
      expect(fixture.host.turnStart).toHaveBeenCalledOnce(),
    );

    const cancelled = response.body?.cancel();
    await vi.waitFor(() => expect(fixture.deleteThread).toHaveBeenCalledOnce());
    expect(write).not.toHaveBeenCalled();
    finishCleanup();
    await cancelled;
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      route: "responses",
      model: "gpt-5.4",
      status: 200,
      errorCode: "request_aborted",
      streamOutcome: "cancelled",
      leaseOutcome: "released",
    });
  });

  it("streams function-call argument and output-item events before suspension", async () => {
    const fixture = createToolFixture();
    const respond = vi.fn(() => fixture.complete("stream complete"));
    vi.mocked(fixture.host.turnStart).mockImplementationOnce(async () => {
      fixture.tools.push({
        generation: 1,
        id: "rpc-stream",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "internal-stream",
          namespace: null,
          tool: "lookup",
          arguments: { id: 1 },
        },
        respond,
        reject: vi.fn(),
      });
      return { turn: fakeTurn() };
    });
    const definitions = [
      {
        type: "function" as const,
        name: "lookup",
        parameters: { type: "object" },
      },
    ];
    const response = await postResponse(fixture.app, {
      model: "gpt-5.4",
      input: "stream tool",
      tools: definitions,
      stream: true,
    });
    const frames = (await response.text()).trim().split("\n\n");
    const projected = frames.map((frame) => {
      const lines = frame.split("\n");
      return {
        event: lines[0]?.replace("event: ", ""),
        data: JSON.parse(lines[1]?.replace("data: ", "") ?? "null"),
      };
    });
    const completed = projected.at(-1)?.data.response;
    const callId = completed?.output[0]?.call_id as string;

    expect(projected.map(({ event }) => event)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(projected.map(({ data }) => data.sequence_number)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(completed).toMatchObject({
      id: expect.stringMatching(/^resp_/),
      output: [
        {
          type: "function_call",
          call_id: expect.stringMatching(/^call_g1_/),
          arguments: '{"id":1}',
        },
      ],
    });
    expect(fixture.host.turnInterrupt).not.toHaveBeenCalled();
    expect(fixture.store.lookup(completed.id)).toMatchObject({
      state: "pending",
    });

    const continuation = await postResponse(fixture.app, {
      model: "gpt-5.4",
      previous_response_id: completed.id,
      tools: definitions,
      input: [
        { type: "function_call_output", call_id: callId, output: "found" },
      ],
    });
    expect(continuation.status).toBe(200);
    expect(fixture.host.turnStart).toHaveBeenCalledOnce();
  });

  it("does not emit response.completed when SQLite completion fails", async () => {
    const fixture = createFixture({
      streamWriteFailureAt: Number.MAX_SAFE_INTEGER,
    });
    const complete = vi
      .spyOn(fixture.store, "completeOperation")
      .mockImplementationOnce(() => {
        throw new Error("SQLite completion failed");
      });
    const response = await postResponse(fixture.app, {
      model: "gpt-5.4",
      input: "stream",
      stream: true,
    });

    await expect(response.text()).rejects.toThrow("SQLite completion failed");
    expect(fixture.streamEvents).not.toContain("response.completed");
    expect(complete).toHaveBeenCalledOnce();
  });

  it("preserves the complete mapping when the response.completed write fails", async () => {
    const fixture = createFixture({ streamWriteFailureAt: 4 });
    const reserve = vi.spyOn(fixture.store, "reserveOperation");
    const response = await postResponse(fixture.app, {
      model: "gpt-5.4",
      input: "stream",
      stream: true,
    });

    await expect(response.text()).rejects.toThrow("stream write 4 failed");
    const responseId = reserve.mock.calls[0]?.[0].responseId ?? "missing";
    expect(fixture.store.lookup(responseId)).toMatchObject({
      state: "complete",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(fixture.deleteThread).not.toHaveBeenCalled();
  });

  it("removes the operation cwd after successful finalization", async () => {
    const fixture = createFixture();

    await postJson(fixture.app, { model: "gpt-5.4", input: "complete" });

    expect(readdirSync(fixture.operationWorkingDirectory)).toEqual([]);
  });

  it("emits an error and no success completion after streaming lifecycle failure", async () => {
    const fixture = createFixture();
    fixture.deleteThread.mockRejectedValueOnce(
      new Error("sensitive delete failure"),
    );
    const response = await postResponse(fixture.app, {
      model: "gpt-5.4",
      input: "stream",
      stream: true,
      store: false,
    });
    const payload = await response.text();
    const errorFrame = payload
      .trim()
      .split("\n\n")
      .find((frame) => frame.startsWith("event: error"));
    const error = JSON.parse(
      errorFrame?.split("\n")[1]?.replace("data: ", "") ?? "null",
    );

    expect(payload).toContain("event: response.created");
    expect(payload).toContain("event: error");
    expect(payload).not.toContain("event: response.completed");
    expect(payload).not.toContain("sensitive delete failure");
    expect(error).toMatchObject({
      type: "error",
      code: "internal_error",
      message: "Internal server error",
      param: null,
      sequence_number: 2,
    });
    expect(error).not.toHaveProperty("error");
  });

  it("abandons and releases a continuation lease when the initial SSE write fails", async () => {
    const fixture = createFixture({ streamWriteFailureAt: 1 });
    const first = await postJson(fixture.app, {
      model: "gpt-5.4",
      input: "first",
    });
    const reserve = vi.spyOn(fixture.store, "reserveOperation");
    const response = await postResponse(fixture.app, {
      model: "gpt-5.4",
      input: "stream",
      previous_response_id: first.id,
      stream: true,
    });

    await expect(response.text()).rejects.toThrow("stream write 1 failed");
    const responseId = reserve.mock.calls[0]?.[0].responseId;
    expect(
      fixture.store.lookupOperation(responseId ?? "missing"),
    ).toBeUndefined();
    expect(fixture.deleteThread).not.toHaveBeenCalled();

    const retry = await postResponse(fixture.app, {
      model: "gpt-5.4",
      input: "retry",
      previous_response_id: first.id,
    });
    expect(retry.status).toBe(200);
  });

  it("abandons and deletes a newly opened thread once when a midstream write fails", async () => {
    const fixture = createFixture({ streamWriteFailureAt: 2 });
    const reserve = vi.spyOn(fixture.store, "reserveOperation");
    const response = await postResponse(fixture.app, {
      model: "gpt-5.4",
      input: "stream",
      stream: true,
    });

    await expect(response.text()).rejects.toThrow("stream write 2 failed");
    const responseId = reserve.mock.calls[0]?.[0].responseId;
    expect(
      fixture.store.lookupOperation(responseId ?? "missing"),
    ).toBeUndefined();
    expect(fixture.deleteThread).toHaveBeenCalledOnce();
    expect(fixture.deleteThread).toHaveBeenCalledWith("thread-1");
  });

  it("abandons and deletes a newly opened thread once when stream iteration throws", async () => {
    const fixture = createFixture({
      iteratorFails: true,
      streamWriteFailureAt: Number.MAX_SAFE_INTEGER,
    });
    const reserve = vi.spyOn(fixture.store, "reserveOperation");
    const response = await postResponse(fixture.app, {
      model: "gpt-5.4",
      input: "stream",
      stream: true,
    });

    await expect(response.text()).rejects.toThrow("iterator transport failed");
    const responseId = reserve.mock.calls[0]?.[0].responseId;
    expect(
      fixture.store.lookupOperation(responseId ?? "missing"),
    ).toBeUndefined();
    expect(fixture.deleteThread).toHaveBeenCalledOnce();
    expect(fixture.deleteThread).toHaveBeenCalledWith("thread-1");
  });
});

describe("Responses expiry cleanup", () => {
  function complete(
    store: ConversationStore,
    threadId: string,
    turnId: string,
    parent?: { responseId: string; threadId: string; turnId: string },
  ): string {
    const responseId = store.createPending({
      threadId,
      ...(parent === undefined
        ? {}
        : {
            parentResponseId: parent.responseId,
            parentThreadId: parent.threadId,
            forkedAtTurnId: parent.turnId,
          }),
      stored: true,
      processGeneration: 1,
    });
    store.complete(responseId, turnId);
    return responseId;
  }

  it("marks expiry first and retries a failed leaf before deleting its ancestor", async () => {
    const store = openStore();
    const rootId = complete(store, "thread-root", "turn-root");
    complete(store, "thread-child", "turn-child", {
      responseId: rootId,
      threadId: "thread-root",
      turnId: "turn-root",
    });
    now += 7 * DAY_MS;
    const deleteThread = vi
      .fn<(threadId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("App Server unavailable"))
      .mockResolvedValue(undefined);

    await sweepExpiredResponses({ store, deleteThread });

    expect(store.lookup(rootId)).toBeUndefined();
    expect(deleteThread).toHaveBeenCalledTimes(1);
    expect(deleteThread).toHaveBeenLastCalledWith("thread-child");
    expect(store.deletableLeafThreads()).toEqual([
      "thread-child",
      "thread-root",
    ]);

    await sweepExpiredResponses({ store, deleteThread });

    expect(deleteThread.mock.calls.map(([threadId]) => threadId)).toEqual([
      "thread-child",
      "thread-child",
      "thread-root",
    ]);
    expect(store.deletableLeafThreads()).toEqual([]);
  });

  it("deletes and finalizes an abandoned attached operation during startup cleanup", async () => {
    const store = openStore();
    store.reserveOperation({
      responseId: "resp_crashed_start",
      ownerRequestId: "req-crashed-start",
      stored: true,
      processGeneration: 1,
      operationCwd: "/tmp/resp_crashed_start",
    });
    store.attachOperation("resp_crashed_start", "thread-crashed-start");
    store.markContinuationLost(2);
    const deleteThread = vi.fn(async () => undefined);

    await sweepExpiredResponses({ store, deleteThread });

    expect(deleteThread).toHaveBeenCalledWith("thread-crashed-start");
    expect(store.lookupOperation("resp_crashed_start")).toBeUndefined();
  });

  it("runs startup and hourly cleanup and stops its injected timer cleanly", async () => {
    const store = openStore();
    complete(store, "thread-timed", "turn-timed");
    let tick: (() => void) | undefined;
    const timer = { id: 1 };
    const setInterval = vi.fn((callback: () => void, milliseconds: number) => {
      tick = callback;
      expect(milliseconds).toBe(60 * 60 * 1_000);
      return timer;
    });
    const clearInterval = vi.fn();
    let finishDelete!: () => void;
    const deleteThread = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          finishDelete = resolve;
        }),
    );
    const sweeper = startResponseSweeper({
      store,
      deleteThread,
      timers: { setInterval, clearInterval },
    });
    await sweeper.startup;
    now += 7 * DAY_MS;

    tick?.();
    await vi.waitFor(() => expect(deleteThread).toHaveBeenCalledOnce());
    const stopping = sweeper.stop();
    expect(clearInterval).toHaveBeenCalledWith(timer);
    finishDelete();
    await stopping;

    expect(store.deletableLeafThreads()).toEqual([]);
  });

  it("retries on the next timer tick after a sweep rejects", async () => {
    const store = openStore();
    complete(store, "thread-retry", "turn-retry");
    now += 7 * DAY_MS;
    const removeThread = vi
      .spyOn(store, "removeThread")
      .mockImplementationOnce(() => {
        throw new Error("transaction failed");
      });
    let tick: (() => void) | undefined;
    const sweeper = startResponseSweeper({
      store,
      deleteThread: vi.fn(async () => undefined),
      timers: {
        setInterval: (callback) => {
          tick = callback;
          return 1;
        },
        clearInterval: vi.fn(),
      },
    });
    await expect(sweeper.startup).rejects.toThrow("transaction failed");

    tick?.();
    await vi.waitFor(() => expect(removeThread).toHaveBeenCalledTimes(2));
    await sweeper.stop();

    expect(store.deletableLeafThreads()).toEqual([]);
  });

  it("reconciles exact start and fork crash-window threads by operation cwd", async () => {
    const store = openStore();
    const operationRoot = mkdtempSync(join(tmpdir(), "reconcile-operations-"));
    directories.add(operationRoot);
    const startCwd = join(operationRoot, "resp_crashed_start");
    const forkCwd = join(operationRoot, "resp_crashed_fork");
    mkdirSync(startCwd);
    mkdirSync(forkCwd);
    store.reserveOperation({
      responseId: "resp_crashed_start",
      ownerRequestId: "req-start",
      stored: true,
      processGeneration: 1,
      operationCwd: startCwd,
    });
    const sourceId = complete(store, "thread-source", "turn-source");
    store.reserveOperation({
      responseId: "resp_crashed_fork",
      previousResponseId: sourceId,
      ownerRequestId: "req-fork",
      stored: false,
      processGeneration: 1,
      operationCwd: forkCwd,
    });
    store.markContinuationLost(2);
    const threadList = vi.fn(
      async ({ cwd }: { cwd?: string | string[] | null }) => ({
        data: [
          fakeThread({
            id: cwd === startCwd ? "thread-orphan-start" : "thread-orphan-fork",
            cwd: cwd as string,
          }),
        ],
        nextCursor: null,
        backwardsCursor: null,
      }),
    );
    const threadDelete = vi.fn(async (_params: { threadId: string }) => ({}));
    const host = { threadList, threadDelete } as unknown as CodexHost;

    await recoverResponseOperations({ store, host });

    expect(threadList).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: startCwd,
        sourceKinds: ["appServer"],
      }),
    );
    expect(threadList).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: forkCwd,
        sourceKinds: ["appServer"],
      }),
    );
    expect(
      threadDelete.mock.calls.map(([{ threadId }]) => threadId).sort(),
    ).toEqual(["thread-orphan-fork", "thread-orphan-start"]);
    expect(store.lookupOperation("resp_crashed_start")).toBeUndefined();
    expect(store.lookupOperation("resp_crashed_fork")).toBeUndefined();
    expect(existsSync(startCwd)).toBe(false);
    expect(existsSync(forkCwd)).toBe(false);
    expect(store.lookup(sourceId)).toMatchObject({ state: "complete" });
  });

  it("retries zero and ambiguous cwd matches without deleting any thread", async () => {
    const store = openStore();
    const operationRoot = mkdtempSync(join(tmpdir(), "ambiguous-operations-"));
    directories.add(operationRoot);
    const zeroCwd = join(operationRoot, "resp_zero");
    const ambiguousCwd = join(operationRoot, "resp_ambiguous");
    mkdirSync(zeroCwd);
    mkdirSync(ambiguousCwd);
    for (const [responseId, operationCwd] of [
      ["resp_zero", zeroCwd],
      ["resp_ambiguous", ambiguousCwd],
    ] as const) {
      store.reserveOperation({
        responseId,
        ownerRequestId: `req_${responseId}`,
        stored: true,
        processGeneration: 1,
        operationCwd,
      });
    }
    store.markContinuationLost(2);
    const threadList = vi.fn(
      async ({ cwd }: { cwd?: string | string[] | null }) => ({
        data:
          cwd === zeroCwd
            ? [fakeThread({ id: "thread-unrelated", cwd: "/tmp/unrelated" })]
            : [
                fakeThread({ id: "thread-match-a", cwd: ambiguousCwd }),
                fakeThread({ id: "thread-match-b", cwd: ambiguousCwd }),
                fakeThread({ id: "thread-unrelated", cwd: "/tmp/unrelated" }),
              ],
        nextCursor: null,
        backwardsCursor: null,
      }),
    );
    const threadDelete = vi.fn(async (_params: { threadId: string }) => ({}));
    const host = { threadList, threadDelete } as unknown as CodexHost;

    await recoverResponseOperations({ store, host });

    expect(threadDelete).not.toHaveBeenCalled();
    expect(store.lookupOperation("resp_zero")).toBeDefined();
    expect(store.lookupOperation("resp_ambiguous")).toBeDefined();
    expect(existsSync(zeroCwd)).toBe(true);
    expect(existsSync(ambiguousCwd)).toBe(true);
  });

  it("retains a reconciled orphan and its cwd until deletion succeeds", async () => {
    const store = openStore();
    const operationRoot = mkdtempSync(join(tmpdir(), "retry-operation-"));
    directories.add(operationRoot);
    const operationCwd = join(operationRoot, "resp_retry_orphan");
    mkdirSync(operationCwd);
    store.reserveOperation({
      responseId: "resp_retry_orphan",
      ownerRequestId: "req-retry",
      stored: true,
      processGeneration: 1,
      operationCwd,
    });
    store.markContinuationLost(2);
    const host = {
      threadList: vi.fn(async () => ({
        data: [fakeThread({ id: "thread-retry-orphan", cwd: operationCwd })],
        nextCursor: null,
        backwardsCursor: null,
      })),
      threadDelete: vi
        .fn(async (_params: { threadId: string }) => ({}))
        .mockRejectedValueOnce(new Error("delete unavailable")),
    } as unknown as CodexHost;

    await expect(recoverResponseOperations({ store, host })).rejects.toThrow(
      "delete unavailable",
    );
    expect(store.lookupOperation("resp_retry_orphan")).toMatchObject({
      state: "abandoned",
      threadId: "thread-retry-orphan",
    });
    expect(existsSync(operationCwd)).toBe(true);

    await recoverResponseOperations({ store, host });
    expect(store.lookupOperation("resp_retry_orphan")).toBeUndefined();
    expect(existsSync(operationCwd)).toBe(false);
  });
});
