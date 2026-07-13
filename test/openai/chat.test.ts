import { describe, expect, it, vi } from "vitest";
import { createDataApp } from "../../src/app.js";
import {
  fakeModel,
  fakeModelListResponse,
  fakeThreadStartResponse,
  fakeTurn,
} from "../../src/codex/fake.js";
import type {
  CodexHost,
  HostNotification,
  PendingServerToolCall,
} from "../../src/codex/host.js";
import { TurnCapacity } from "../../src/operations/capacity.js";
import { createLogger, type Logger } from "../../src/operations/log.js";
import { Metrics } from "../../src/operations/metrics.js";
import { TurnRunner } from "../../src/turns/runner.js";

const bifrostToken = "b".repeat(32);
const authorization = { authorization: `Bearer ${bifrostToken}` };

class EventQueue implements AsyncIterable<HostNotification> {
  readonly #values: HostNotification[] = [];
  readonly #waiters: Array<{
    resolve(value: IteratorResult<HostNotification>): void;
    reject(error: unknown): void;
  }> = [];
  #failure: unknown;

  push(event: Omit<HostNotification, "generation">): void {
    const value = { ...event, generation: 1 } as HostNotification;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.#values.push(value);
  }

  fail(error: unknown): void {
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<HostNotification> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value) return { done: false, value };
        if (this.#failure !== undefined) throw this.#failure;
        return new Promise((resolve, reject) =>
          this.#waiters.push({ resolve, reject }),
        );
      },
    };
  }
}

class ToolQueue implements AsyncIterable<PendingServerToolCall> {
  readonly #values: PendingServerToolCall[] = [];
  readonly #waiters: Array<
    (value: IteratorResult<PendingServerToolCall>) => void
  > = [];

  push(value: PendingServerToolCall): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#values.push(value);
  }

  [Symbol.asyncIterator](): AsyncIterator<PendingServerToolCall> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value) return { done: false, value };
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function emitCompletion(
  events: EventQueue,
  text = "fixture answer",
  withUsage = true,
): void {
  events.push({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      delta: "fixture ",
    },
  });
  events.push({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      delta: "answer",
    },
  });
  events.push({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 1,
      item: {
        type: "agentMessage",
        id: "message-1",
        text,
        phase: null,
        memoryCitation: null,
      },
    },
  });
  if (withUsage) {
    events.push({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          total: {
            inputTokens: 100,
            cachedInputTokens: 0,
            outputTokens: 50,
            reasoningOutputTokens: 0,
            totalTokens: 150,
          },
          last: {
            inputTokens: 7,
            cachedInputTokens: 0,
            outputTokens: 5,
            reasoningOutputTokens: 0,
            totalTokens: 12,
          },
          modelContextWindow: 128_000,
        },
      },
    });
  }
  events.push({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: fakeTurn({ id: "turn-1", status: "completed" }),
    },
  });
}

function createFixture(
  options: {
    supportsImage?: boolean;
    withUsage?: boolean;
    timeoutMs?: number;
    lifecycleWaitMs?: number;
    streamAbortBeforeWrite?: boolean;
    streamAbortAt?: number;
    streamWriteFailureAt?: number;
    turnStart?: CodexHost["turnStart"];
    threadInjectItems?: CodexHost["threadInjectItems"];
    capacity?: TurnCapacity;
    logger?: Logger;
    metrics?: Metrics;
  } = {},
) {
  let draining = false;
  const events = new EventQueue();
  const tools = new ToolQueue();
  const release = vi.fn(async () => undefined);
  const streamPayloads: string[] = [];
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
    threadStart: vi.fn(async () => fakeThreadStartResponse()),
    threadResume: vi.fn(),
    threadFork: vi.fn(),
    threadInjectItems: vi.fn(options.threadInjectItems ?? (async () => ({}))),
    threadDelete: vi.fn(async () => ({})),
    turnStart: vi.fn(
      options.turnStart ??
        (async () => {
          emitCompletion(events, "fixture answer", options.withUsage ?? true);
          return { turn: fakeTurn() };
        }),
    ),
    turnInterrupt: vi.fn(async ({ threadId, turnId }) => {
      events.push({
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
  const runner = new TurnRunner({
    host,
    emptyWorkingDirectory: "/tmp/work",
    neutralInstructions: "Use only the supplied interface.",
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    ...(options.lifecycleWaitMs === undefined
      ? {}
      : { lifecycleWaitMs: options.lifecycleWaitMs }),
    interruptWaitMs: 10,
  });
  const chat = {
    runner,
    release,
    ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
    deleteThread: async (threadId: string, signal?: AbortSignal) => {
      await host.threadDelete({ threadId }, signal);
    },
    ...(options.streamAbortBeforeWrite !== true &&
    options.streamAbortAt === undefined &&
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
                  async writeSSE(event: { data: string }) {
                    writes += 1;
                    if (writes === options.streamAbortAt) {
                      onAbort();
                      return;
                    }
                    if (writes === options.streamWriteFailureAt) {
                      throw new Error(`stream write ${writes} failed`);
                    }
                    streamPayloads.push(event.data);
                    payload += `data: ${event.data}\n\n`;
                  },
                };
                const streaming = callback(stream);
                if (options.streamAbortBeforeWrite) queueMicrotask(onAbort);
                void streaming.then(
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
  };
  const app = createDataApp({
    health: () => true,
    ready: () => true,
    accountReady: () => true,
    draining: () => draining,
    bifrostToken,
    metricsToken: "m".repeat(32),
    host,
    chat,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    processGeneration: () => host.generation,
  });
  return {
    app,
    beginDrain: () => {
      draining = true;
      options.capacity?.beginDrain();
    },
    events,
    host,
    release,
    runner,
    streamPayloads,
    tools,
  };
}

function post(
  app: ReturnType<typeof createFixture>["app"],
  body: unknown,
): Promise<Response> {
  return Promise.resolve(
    app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const ordinaryRequest = {
  model: "gpt-5.4",
  messages: [{ role: "user" as const, content: "final question" }],
};

describe("POST /v1/chat/completions", () => {
  it("injects complete history and returns an exact ordinary completion", async () => {
    const { app, host, release } = createFixture();
    const before = Math.floor(Date.now() / 1_000);
    const response = await post(app, {
      model: "gpt-5.4",
      messages: [
        { role: "system", content: "system rule" },
        { role: "developer", content: "developer rule" },
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
        { role: "user", content: "final question" },
      ],
      reasoning_effort: "high",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
          },
        },
      },
    });
    const after = Math.floor(Date.now() / 1_000);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { created: number };
    expect(body).toEqual({
      id: expect.stringMatching(/^chatcmpl_[A-Za-z0-9_-]{32}$/),
      object: "chat.completion",
      created: expect.any(Number),
      model: "gpt-5.4",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "fixture answer" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
    });
    expect(Number.isInteger(body.created)).toBe(true);
    expect(body.created).toBeGreaterThanOrEqual(before);
    expect(body.created).toBeLessThanOrEqual(after);
    expect(host.threadInjectItems).toHaveBeenCalledWith(
      {
        threadId: "thread-1",
        items: [
          {
            type: "message",
            role: "system",
            content: [{ type: "input_text", text: "system rule" }],
          },
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "developer rule" }],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "earlier question" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "earlier answer" }],
          },
        ],
      },
      expect.any(AbortSignal),
    );
    expect(host.turnStart).toHaveBeenCalledWith(
      {
        threadId: "thread-1",
        input: [{ type: "text", text: "final question", text_elements: [] }],
        model: "gpt-5.4",
        effort: "high",
        outputSchema: {
          type: "object",
          properties: { answer: { type: "string" } },
        },
      },
      expect.any(AbortSignal),
    );
    expect(host.threadStart).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: false }),
      expect.any(AbortSignal),
    );
    expect(host.threadDelete).toHaveBeenCalledOnce();
    expect(host.threadDelete).toHaveBeenCalledWith(
      { threadId: "thread-1" },
      expect.any(AbortSignal),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("omits usage when Codex supplies none", async () => {
    const { app } = createFixture({ withUsage: false });
    const response = await post(app, ordinaryRequest);

    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("usage");
  });

  it("validates tool_choice none definitions but passes no dynamic tools", async () => {
    const { app, host } = createFixture();
    const response = await post(app, {
      ...ordinaryRequest,
      tools: [
        {
          type: "function",
          function: { name: "lookup", parameters: { type: "object" } },
        },
      ],
      tool_choice: "none",
    });

    expect(response.status).toBe(200);
    expect(host.threadStart).toHaveBeenCalledWith(
      expect.not.objectContaining({ dynamicTools: expect.anything() }),
      expect.any(AbortSignal),
    );
    expect(host.toolCalls).not.toHaveBeenCalled();
  });

  it("returns lost rather than unknown for an old-generation Chat call ID", async () => {
    const { app, host } = createFixture();
    (host as { generation: number }).generation = 2;
    const response = await post(app, {
      model: "gpt-5.4",
      tools: [
        {
          type: "function",
          function: { name: "lookup", parameters: { type: "object" } },
        },
      ],
      messages: [
        { role: "tool", tool_call_id: "call_g1_stale", content: "late" },
      ],
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "proxy_continuation_lost" },
    });
    expect(host.threadStart).not.toHaveBeenCalled();
  });

  it("suspends and continues one client-executed function call on the same turn", async () => {
    const capacity = new TurnCapacity(1, 32);
    const { app, beginDrain, events, host, release, tools } = createFixture({
      capacity,
    });
    const respond = vi.fn(() => emitCompletion(events, "It is sunny", false));
    vi.mocked(host.turnStart).mockImplementationOnce(async () => {
      tools.push({
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
    const toolsDefinition = [
      {
        type: "function" as const,
        function: {
          name: "weather",
          description: "Read weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      },
    ];

    const suspended = await post(app, {
      ...ordinaryRequest,
      tools: toolsDefinition,
      tool_choice: "auto",
    });
    const suspendedBody = (await suspended.json()) as {
      choices: Array<{ message: { tool_calls: Array<{ id: string }> } }>;
    };
    const callId =
      suspendedBody.choices[0]?.message.tool_calls[0]?.id ?? "missing";

    expect(suspended.status).toBe(200);
    expect(suspendedBody).toMatchObject({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: expect.stringMatching(/^call_g1_/),
                type: "function",
                function: {
                  name: "weather",
                  arguments: '{"city":"Paris"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    expect(host.threadDelete).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(capacity.active).toBe(1);

    beginDrain();

    const completed = await post(app, {
      model: "gpt-5.4",
      tools: toolsDefinition,
      tool_choice: "auto",
      messages: [
        ...ordinaryRequest.messages,
        suspendedBody.choices[0]?.message,
        { role: "tool", tool_call_id: callId, content: "sunny" },
      ],
    });

    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      choices: [
        {
          message: { role: "assistant", content: "It is sunny" },
          finish_reason: "stop",
        },
      ],
    });
    expect(host.turnStart).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith({
      success: true,
      contentItems: [{ type: "inputText", text: "sunny" }],
    });
    expect(host.threadDelete).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(capacity.active).toBe(0);
  });

  it("fans in parallel tool outputs without resolving a partial submission", async () => {
    const { app, events, host, tools } = createFixture();
    let responses = 0;
    const respond = vi.fn(() => {
      responses += 1;
      if (responses === 2) emitCompletion(events, "combined", false);
    });
    vi.mocked(host.turnStart).mockImplementationOnce(async () => {
      for (const [id, tool] of [
        ["one", "first"],
        ["two", "second"],
      ] as const) {
        tools.push({
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
          respond,
          reject: vi.fn(),
        });
      }
      return { turn: fakeTurn() };
    });
    const definitions = ["first", "second"].map((name) => ({
      type: "function" as const,
      function: { name, parameters: { type: "object" } },
    }));
    const suspended = await post(app, {
      ...ordinaryRequest,
      tools: definitions,
    });
    const body = (await suspended.json()) as {
      choices: Array<{ message: { tool_calls: Array<{ id: string }> } }>;
    };
    const calls = body.choices[0]?.message.tool_calls ?? [];

    const partial = await post(app, {
      model: "gpt-5.4",
      tools: definitions,
      messages: [
        ...ordinaryRequest.messages,
        body.choices[0]?.message,
        { role: "tool", tool_call_id: calls[0]?.id, content: "one" },
      ],
    });
    expect(partial.status).toBe(400);
    expect(respond).not.toHaveBeenCalled();

    const complete = await post(app, {
      model: "gpt-5.4",
      tools: definitions,
      messages: [
        ...ordinaryRequest.messages,
        body.choices[0]?.message,
        { role: "tool", tool_call_id: calls[1]?.id, content: "two" },
        { role: "tool", tool_call_id: calls[0]?.id, content: "one" },
      ],
    });
    expect(complete.status).toBe(200);
    expect(respond).toHaveBeenCalledTimes(2);
    expect(host.turnStart).toHaveBeenCalledOnce();
  });

  it("supports repeated tool-call loops without starting another turn", async () => {
    const { app, events, host, tools } = createFixture();
    const pushCall = (tool: string, id: string, onRespond: () => void) => {
      tools.push({
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
    vi.mocked(host.turnStart).mockImplementationOnce(async () => {
      pushCall("first", "one", () =>
        pushCall("second", "two", () => emitCompletion(events, "done", false)),
      );
      return { turn: fakeTurn() };
    });
    const definitions = ["first", "second"].map((name) => ({
      type: "function" as const,
      function: { name, parameters: { type: "object" } },
    }));
    const first = await post(app, { ...ordinaryRequest, tools: definitions });
    const firstBody = (await first.json()) as {
      choices: Array<{
        message: { tool_calls: Array<{ id: string }> };
      }>;
    };
    const firstMessage = firstBody.choices[0]?.message;
    const firstCall = firstMessage?.tool_calls[0]?.id;
    if (!firstMessage || !firstCall) throw new Error("Missing first tool call");
    const second = await post(app, {
      model: "gpt-5.4",
      tools: definitions,
      messages: [
        ...ordinaryRequest.messages,
        firstMessage,
        { role: "tool", tool_call_id: firstCall, content: "one" },
      ],
    });
    const secondBody = (await second.json()) as {
      choices: Array<{
        message: { tool_calls: Array<{ id: string }> };
      }>;
    };
    const secondMessage = secondBody.choices[0]?.message;
    const secondCall = secondMessage?.tool_calls[0]?.id;
    if (!secondMessage || !secondCall)
      throw new Error("Missing second tool call");
    const completed = await post(app, {
      model: "gpt-5.4",
      tools: definitions,
      messages: [
        ...ordinaryRequest.messages,
        firstMessage,
        { role: "tool", tool_call_id: firstCall, content: "one" },
        secondMessage,
        { role: "tool", tool_call_id: secondCall, content: "two" },
      ],
    });

    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      choices: [{ message: { content: "done" }, finish_reason: "stop" }],
    });
    expect(host.turnStart).toHaveBeenCalledOnce();
    expect(host.toolCalls).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "an unknown model",
      { ...ordinaryRequest, model: "not-a-model" },
      404,
      "model_not_found",
    ],
    [
      "unsupported reasoning",
      { ...ordinaryRequest, reasoning_effort: "medium" },
      400,
      "unsupported_reasoning_effort",
    ],
    [
      "assistant tool calls",
      {
        ...ordinaryRequest,
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "lookup", arguments: "{}" },
              },
            ],
          },
          { role: "user", content: "continue" },
        ],
      },
      400,
      "unknown_tool_call",
    ],
    [
      "terminal tool output",
      {
        ...ordinaryRequest,
        messages: [{ role: "tool", tool_call_id: "call-1", content: "result" }],
      },
      400,
      "unknown_tool_call",
    ],
  ])("rejects %s before creating a thread", async (_name, request, status, code) => {
    const { app, host } = createFixture();
    const response = await post(app, request);

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
    expect(host.threadStart).not.toHaveBeenCalled();
  });

  it("rejects image input for a text-only model before creating a thread", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    const { app, host } = createFixture();
    const response = await post(app, {
      ...ordinaryRequest,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${png}` },
            },
          ],
        },
      ],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "unsupported_image_model", param: "model" },
    });
    expect(host.threadStart).not.toHaveBeenCalled();
  });

  it("deletes the disposable thread once when history injection fails", async () => {
    const { app, host, release } = createFixture({
      threadInjectItems: async () => {
        throw new Error("sensitive injection failure");
      },
    });
    const response = await post(app, {
      ...ordinaryRequest,
      messages: [
        { role: "user", content: "history" },
        { role: "user", content: "final question" },
      ],
    });

    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("sensitive injection failure");
    expect(host.threadDelete).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "turn start fails",
      async () => {
        throw new Error("sensitive turn failure");
      },
      undefined,
      502,
    ],
    ["turn times out", async () => new Promise<never>(() => undefined), 5, 504],
  ])("deletes the disposable thread once when %s", async (_name, turnStart, timeoutMs, status) => {
    const { app, host, release } = createFixture({
      turnStart,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    const response = await post(app, ordinaryRequest);

    expect(response.status).toBe(status);
    expect(host.threadDelete).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("streams only OpenAI chunks with one stable identity and terminal usage", async () => {
    const { app, host } = createFixture();
    const response = await post(app, { ...ordinaryRequest, stream: true });
    const payload = await response.text();
    const frames = payload.trim().split("\n\n");
    const chunks = frames
      .slice(0, -1)
      .map((frame) => JSON.parse(frame.replace(/^data: /, "")));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(chunks.map((chunk) => chunk.choices[0])).toEqual([
      { index: 0, delta: { role: "assistant" }, finish_reason: null },
      { index: 0, delta: { content: "fixture " }, finish_reason: null },
      { index: 0, delta: { content: "answer" }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: "stop" },
    ]);
    expect(chunks.at(-1)?.usage).toEqual({
      prompt_tokens: 7,
      completion_tokens: 5,
      total_tokens: 12,
    });
    expect(new Set(chunks.map(({ id }) => id)).size).toBe(1);
    expect(new Set(chunks.map(({ created }) => created)).size).toBe(1);
    expect(new Set(chunks.map(({ model }) => model))).toEqual(
      new Set(["gpt-5.4"]),
    );
    expect(
      chunks.every(({ object }) => object === "chat.completion.chunk"),
    ).toBe(true);
    expect(frames.at(-1)).toBe("data: [DONE]");
    expect(payload).not.toContain("item/agentMessage/delta");
    expect(payload).not.toContain("thread/tokenUsage/updated");
    expect(host.threadDelete).toHaveBeenCalledOnce();
  });

  it("streams tool calls to an intentional terminal tool_calls chunk", async () => {
    const { app, events, host, tools } = createFixture();
    const respond = vi.fn(() => emitCompletion(events, "done", false));
    vi.mocked(host.turnStart).mockImplementationOnce(async () => {
      tools.push({
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
        function: { name: "lookup", parameters: { type: "object" } },
      },
    ];
    const response = await post(app, {
      ...ordinaryRequest,
      tools: definitions,
      stream: true,
    });
    const payload = await response.text();
    const chunks = payload
      .trim()
      .split("\n\n")
      .slice(0, -1)
      .map((frame) => JSON.parse(frame.replace(/^data: /, "")));
    const toolCall = chunks.find(
      (chunk) => chunk.choices[0].delta.tool_calls !== undefined,
    ).choices[0].delta.tool_calls[0];

    expect(toolCall).toMatchObject({
      index: 0,
      id: expect.stringMatching(/^call_g1_/),
      function: { name: "lookup", arguments: '{"id":1}' },
    });
    expect(chunks.at(-1)?.choices[0].finish_reason).toBe("tool_calls");
    expect(payload).toContain("data: [DONE]");
    expect(host.turnInterrupt).not.toHaveBeenCalled();
    expect(host.threadDelete).not.toHaveBeenCalled();

    const completed = await post(app, {
      model: "gpt-5.4",
      tools: definitions,
      messages: [
        ...ordinaryRequest.messages,
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: toolCall.id,
              type: "function",
              function: { name: "lookup", arguments: '{"id":1}' },
            },
          ],
        },
        { role: "tool", tool_call_id: toolCall.id, content: "found" },
      ],
    });
    expect(completed.status).toBe(200);
    expect(host.turnStart).toHaveBeenCalledOnce();
  });

  it.each([
    ["write", { streamWriteFailureAt: 2 }],
    ["abort", { streamAbortAt: 2 }],
  ] as const)("invalidates mixed text and parallel repeated calls when text streaming %s fails", async (_name, streamFailure) => {
    const { app, events, host, release, streamPayloads, tools } =
      createFixture(streamFailure);
    const repeatedRejects = [vi.fn(), vi.fn()];
    const firstRespond = vi.fn(() => {
      events.push({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          completedAtMs: 1,
          item: {
            type: "agentMessage",
            id: "message-preamble",
            text: "tool preamble",
            phase: null,
            memoryCitation: null,
          },
        },
      });
      for (const [index, tool] of ["second", "third"].entries()) {
        tools.push({
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
    vi.mocked(host.turnStart).mockImplementationOnce(async () => {
      tools.push({
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
      function: { name, parameters: { type: "object" } },
    }));
    const suspended = await post(app, {
      ...ordinaryRequest,
      tools: definitions,
    });
    const body = (await suspended.json()) as {
      choices: Array<{
        message: { tool_calls: Array<{ id: string }> };
      }>;
    };
    const firstCallId = body.choices[0]?.message.tool_calls[0]?.id ?? "missing";
    const continuation = await post(app, {
      model: "gpt-5.4",
      tools: definitions,
      stream: true,
      messages: [
        ...ordinaryRequest.messages,
        body.choices[0]?.message,
        { role: "tool", tool_call_id: firstCallId, content: "first result" },
      ],
    });

    if (_name === "abort")
      await expect(continuation.text()).resolves.toBeDefined();
    else await expect(continuation.text()).rejects.toThrow();
    await vi.waitFor(() => expect(host.turnInterrupt).toHaveBeenCalledOnce());
    expect(repeatedRejects[0]).toHaveBeenCalledOnce();
    expect(repeatedRejects[1]).toHaveBeenCalledOnce();
    expect(host.threadDelete).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(streamPayloads).not.toContain("[DONE]");
  });

  it("aborts a pending repeated stage before call IDs or stream output exist", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createFixture({
        lifecycleWaitMs: 10,
        streamAbortBeforeWrite: true,
      });
      const firstRespond = vi.fn();
      vi.mocked(fixture.host.turnStart).mockImplementationOnce(async () => {
        fixture.tools.push({
          generation: 1,
          id: "rpc-pending-repeat",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: "internal-pending-repeat",
            namespace: null,
            tool: "first",
            arguments: {},
          },
          respond: firstRespond,
          reject: vi.fn(),
        });
        return { turn: fakeTurn() };
      });
      const definitions = [
        {
          type: "function" as const,
          function: { name: "first", parameters: { type: "object" } },
        },
      ];
      const suspendedPromise = post(fixture.app, {
        ...ordinaryRequest,
        tools: definitions,
      });
      await vi.advanceTimersByTimeAsync(0);
      const suspended = await suspendedPromise;
      const body = (await suspended.json()) as {
        choices: Array<{
          message: { tool_calls: Array<{ id: string }> };
        }>;
      };
      const firstCallId =
        body.choices[0]?.message.tool_calls[0]?.id ?? "missing";
      const continueSpy = vi.spyOn(fixture.runner.tools, "continue");

      const responsePromise = post(fixture.app, {
        model: "gpt-5.4",
        tools: definitions,
        stream: true,
        messages: [
          ...ordinaryRequest.messages,
          body.choices[0]?.message,
          { role: "tool", tool_call_id: firstCallId, content: "first result" },
        ],
      });
      await vi.advanceTimersByTimeAsync(0);
      const response = await responsePromise;
      const continuation = await continueSpy.mock.results[0]?.value;
      if (continuation?.type !== "continued") {
        throw new Error("Expected continued tool stage");
      }
      let settled = false;
      void continuation.result.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(settled).toBe(true);
      await expect(continuation.result).rejects.toMatchObject({
        code: "request_aborted",
      });
      await expect(response.text()).resolves.toContain('"role":"assistant"');
      expect(firstRespond).toHaveBeenCalledOnce();
      expect(fixture.host.turnInterrupt).toHaveBeenCalledOnce();
      expect(fixture.host.threadDelete).toHaveBeenCalledOnce();
      expect(fixture.release).toHaveBeenCalledOnce();
      expect(fixture.streamPayloads).toHaveLength(1);
      expect(fixture.streamPayloads).not.toContain("[DONE]");
      await vi.advanceTimersByTimeAsync(10);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards a resumed text delta before the continuation result resolves", async () => {
    const fixture = createFixture();
    const respond = vi.fn(() => {
      fixture.events.push({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "message-live",
          delta: "live continuation",
        },
      });
    });
    vi.mocked(fixture.host.turnStart).mockImplementationOnce(async () => {
      fixture.tools.push({
        generation: 1,
        id: "rpc-live",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "internal-live",
          namespace: null,
          tool: "lookup",
          arguments: {},
        },
        respond,
        reject: vi.fn(),
      });
      return { turn: fakeTurn() };
    });
    const definitions = [
      {
        type: "function" as const,
        function: { name: "lookup", parameters: {} },
      },
    ];
    const suspended = await post(fixture.app, {
      ...ordinaryRequest,
      tools: definitions,
    });
    const suspendedBody = (await suspended.json()) as {
      choices: Array<{ message: { tool_calls: Array<{ id: string }> } }>;
    };
    const callId = suspendedBody.choices[0]?.message.tool_calls[0]?.id;
    if (!callId) throw new Error("Missing tool call");
    const continueSpy = vi.spyOn(fixture.runner.tools, "continue");
    const response = await post(fixture.app, {
      model: "gpt-5.4",
      tools: definitions,
      stream: true,
      messages: [
        ...ordinaryRequest.messages,
        suspendedBody.choices[0]?.message,
        { role: "tool", tool_call_id: callId, content: "found" },
      ],
    });
    const continuation = await continueSpy.mock.results[0]?.value;
    if (continuation?.type !== "continued") throw new Error("Not continued");
    let finalResolved = false;
    void continuation.result.finally(() => {
      finalResolved = true;
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing response body");
    const decoder = new TextDecoder();
    let payload = "";
    while (!payload.includes("live continuation")) {
      const next = await reader.read();
      if (next.done) throw new Error("Stream ended before live delta");
      payload += decoder.decode(next.value, { stream: true });
    }

    expect(finalResolved).toBe(false);
    emitCompletion(fixture.events, "complete", false);
    while (!(await reader.read()).done) {
      // Drain the terminal chunks after proving the timing boundary.
    }
    expect(finalResolved).toBe(true);
  });

  it("emits a sanitized SSE error when a stream fails before text", async () => {
    const { app, host } = createFixture({
      turnStart: async () => {
        throw new Error("sensitive pre-text failure");
      },
    });
    const response = await post(app, { ...ordinaryRequest, stream: true });
    const payload = await response.text();

    expect(payload).toContain('"code":"codex_host_error"');
    expect(payload).toContain('"message":"Upstream service error"');
    expect(payload).not.toContain("sensitive pre-text failure");
    expect(payload).not.toContain('"finish_reason":"stop"');
    expect(payload).not.toContain("data: [DONE]");
    expect(host.threadDelete).toHaveBeenCalledOnce();
  });

  it("emits a sanitized SSE error after a partial delta", async () => {
    const { app, events, host } = createFixture();
    vi.mocked(host.turnStart).mockImplementation(async () => {
      events.push({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "message-1",
          delta: "partial output",
        },
      });
      setImmediate(() => events.fail(new Error("sensitive post-text failure")));
      return { turn: fakeTurn() };
    });
    const response = await post(app, { ...ordinaryRequest, stream: true });
    const payload = await response.text();

    expect(payload).toContain('"content":"partial output"');
    expect(payload).toContain('"code":"codex_host_error"');
    expect(payload).not.toContain("sensitive post-text failure");
    expect(payload).not.toContain('"finish_reason":"stop"');
    expect(payload).not.toContain("data: [DONE]");
    expect(host.threadDelete).toHaveBeenCalledOnce();
  });

  it("emits a sanitized SSE error when thread deletion rejects", async () => {
    const { app, host, release } = createFixture();
    vi.mocked(host.threadDelete).mockRejectedValue(
      new Error("sensitive thread deletion failure"),
    );
    const response = await post(app, { ...ordinaryRequest, stream: true });
    const payload = await response.text();

    expect(payload).toContain('"code":"codex_host_error"');
    expect(payload).toContain('"message":"Upstream service error"');
    expect(payload).not.toContain("sensitive thread deletion failure");
    expect(payload).not.toContain('"finish_reason":"stop"');
    expect(payload).not.toContain("data: [DONE]");
    expect(host.threadDelete).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("emits a sanitized SSE error when lifecycle cleanup times out", async () => {
    const { app, host, release } = createFixture({ lifecycleWaitMs: 5 });
    vi.mocked(host.threadDelete).mockImplementation(
      async (_params, signal) =>
        new Promise((resolve) =>
          signal?.addEventListener("abort", () => resolve({}), { once: true }),
        ),
    );
    const response = await post(app, { ...ordinaryRequest, stream: true });
    const payload = await response.text();

    expect(payload).toContain('"code":"turn_lifecycle_timeout"');
    expect(payload).toContain('"message":"Upstream service error"');
    expect(payload).not.toContain('"finish_reason":"stop"');
    expect(payload).not.toContain("data: [DONE]");
    expect(host.threadDelete).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("interrupts, releases, and deletes once when the stream disconnects", async () => {
    const { app, host, release } = createFixture({
      turnStart: async () => ({ turn: fakeTurn() }),
    });
    const response = await post(app, { ...ordinaryRequest, stream: true });

    await vi.waitFor(() => expect(host.turnStart).toHaveBeenCalledOnce());
    await response.body?.cancel();
    await vi.waitFor(() => expect(host.threadDelete).toHaveBeenCalledOnce());

    expect(host.turnInterrupt).toHaveBeenCalledOnce();
    expect(host.turnInterrupt).toHaveBeenCalledWith({
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("records streaming success only after the body completes", async () => {
    const write = vi.fn();
    const capacity = new TurnCapacity(1, 0);
    const { app } = createFixture({
      capacity,
      logger: createLogger(write),
    });
    const response = await post(app, { ...ordinaryRequest, stream: true });

    expect(write).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await response.text();

    expect(write).toHaveBeenCalledOnce();
    const event = JSON.parse(String(write.mock.calls[0]?.[0]));
    expect(event).toMatchObject({
      route: "chat",
      model: "gpt-5.4",
      status: 200,
      streamOutcome: "completed",
      queueOutcome: "admitted",
      processGeneration: 1,
    });
    expect(event.durationMs).toBeGreaterThanOrEqual(8);
  });

  it("records a stable midstream failure once without metric model labels", async () => {
    const write = vi.fn();
    const metrics = new Metrics();
    const { app } = createFixture({
      streamWriteFailureAt: 2,
      logger: createLogger(write),
      metrics,
    });
    const response = await post(app, {
      ...ordinaryRequest,
      messages: [{ role: "user", content: "private prompt" }],
      stream: true,
    });

    await expect(response.text()).rejects.toThrow("stream write 2 failed");

    expect(write).toHaveBeenCalledOnce();
    const logged = String(write.mock.calls[0]?.[0]);
    expect(JSON.parse(logged)).toMatchObject({
      route: "chat",
      model: "gpt-5.4",
      status: 200,
      errorCode: "internal_error",
      streamOutcome: "failed",
    });
    expect(logged).not.toContain("private prompt");
    expect(metrics.render()).toContain(
      'proxy_errors_total{route="chat",code="internal_error"} 1',
    );
    expect(metrics.render()).not.toContain("gpt-5.4");
    expect(metrics.render()).not.toContain("private prompt");
  });

  it("records consumer cancellation once at cancellation time", async () => {
    const write = vi.fn();
    const { app, host } = createFixture({
      turnStart: async () => ({ turn: fakeTurn() }),
      logger: createLogger(write),
    });
    const response = await post(app, { ...ordinaryRequest, stream: true });
    await vi.waitFor(() => expect(host.turnStart).toHaveBeenCalledOnce());

    await response.body?.cancel();
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      route: "chat",
      model: "gpt-5.4",
      status: 200,
      errorCode: "request_aborted",
      streamOutcome: "cancelled",
    });
  });
});
