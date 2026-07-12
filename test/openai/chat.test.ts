import { describe, expect, it, vi } from "vitest";
import { createDataApp } from "../../src/app.js";
import {
  fakeModel,
  fakeModelListResponse,
  fakeThreadStartResponse,
  fakeTurn,
} from "../../src/codex/fake.js";
import type { CodexHost, HostNotification } from "../../src/codex/host.js";
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
    turnStart?: CodexHost["turnStart"];
    threadInjectItems?: CodexHost["threadInjectItems"];
  } = {},
) {
  const events = new EventQueue();
  const release = vi.fn(async () => undefined);
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
  const app = createDataApp({
    health: () => true,
    ready: () => true,
    draining: () => false,
    bifrostToken,
    metricsToken: "m".repeat(32),
    host,
    chat: {
      runner,
      release,
      deleteThread: async (threadId: string, signal?: AbortSignal) => {
        await host.threadDelete({ threadId }, signal);
      },
    },
  });
  return { app, events, host, release };
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
      "function tools",
      {
        ...ordinaryRequest,
        tools: [
          {
            type: "function",
            function: { name: "lookup", parameters: { type: "object" } },
          },
        ],
      },
      400,
      "unsupported_tool_semantics",
    ],
    [
      "an empty tools field",
      { ...ordinaryRequest, tools: [] },
      400,
      "unsupported_tool_semantics",
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
      "unsupported_tool_semantics",
    ],
    [
      "terminal tool output",
      {
        ...ordinaryRequest,
        messages: [{ role: "tool", tool_call_id: "call-1", content: "result" }],
      },
      400,
      "unsupported_tool_semantics",
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
});
