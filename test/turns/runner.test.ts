import { describe, expect, it, vi } from "vitest";
import {
  fakeThread,
  fakeThreadStartResponse,
  fakeTurn,
} from "../../src/codex/fake.js";
import type {
  CodexHost,
  HostNotification,
  PendingServerToolCall,
} from "../../src/codex/host.js";
import { CodexGenerationChangedError } from "../../src/codex/transport.js";
import { ProxyError } from "../../src/http/errors.js";
import type { ProxyStreamEvent, TurnCommand } from "../../src/turns/events.js";
import { TurnRunner } from "../../src/turns/runner.js";

const emptyWorkingDirectory = "/tmp/openai-oauth-proxy-empty";
const neutralInstructions = "Respond only through the supplied interface.";

class EventQueue implements AsyncIterable<HostNotification> {
  readonly #values: HostNotification[] = [];
  readonly #waiters: Array<{
    resolve(value: IteratorResult<HostNotification>): void;
    reject(error: unknown): void;
  }> = [];
  #failure: unknown;

  push(event: Omit<HostNotification, "generation">, generation = 1): void {
    const value = { ...event, generation } as HostNotification;
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
        return new Promise((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function setGeneration(host: CodexHost, generation: number): void {
  (host as { generation: number }).generation = generation;
}

function command(overrides: Partial<TurnCommand> = {}): TurnCommand {
  return {
    action: { type: "start" },
    model: "gpt-5.4",
    history: [],
    input: [{ type: "text", text: "hello", text_elements: [] }],
    ...overrides,
  };
}

function createHost() {
  const events = new EventQueue();
  const tools = new ToolQueue();
  const host = {
    generation: 1,
    threadStart: vi.fn(async () => fakeThreadStartResponse()),
    threadResume: vi.fn(async ({ threadId }: { threadId: string }) =>
      fakeThreadStartResponse({ thread: fakeThread({ id: threadId }) }),
    ),
    threadFork: vi.fn(async () =>
      fakeThreadStartResponse({ thread: fakeThread({ id: "thread-fork" }) }),
    ),
    threadInjectItems: vi.fn(async () => ({})),
    threadDelete: vi.fn(async () => ({})),
    turnStart: vi.fn(async () => ({ turn: fakeTurn() })),
    turnInterrupt: vi.fn(async () => ({})),
    events: vi.fn(() => events),
    toolCalls: vi.fn(() => tools),
  } as unknown as CodexHost;

  return { events, host, tools };
}

function createRunner(host: CodexHost, overrides = {}) {
  return new TurnRunner({
    host,
    emptyWorkingDirectory,
    neutralInstructions,
    ...overrides,
  });
}

it("interrupts and settles every active turn during forced drain", async () => {
  const { events, host } = createHost();
  const release = vi.fn();
  vi.mocked(host.turnInterrupt).mockImplementation(
    async ({ threadId, turnId }) => {
      events.push({
        method: "turn/completed",
        params: {
          threadId,
          turn: fakeTurn({ id: turnId, status: "interrupted" }),
        },
      });
      return {};
    },
  );
  const runner = createRunner(host, { interruptWaitMs: 10 });
  const result = runner.run(command(), undefined, { release });
  const outcome = result.catch((error: unknown) => error);
  await vi.waitFor(() => expect(host.turnStart).toHaveBeenCalledOnce());

  await runner.interruptAll();

  await expect(outcome).resolves.toMatchObject({ code: "request_aborted" });
  expect(host.turnInterrupt).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
  expect(runner.active).toBe(0);
});

async function collect(
  source: AsyncIterable<ProxyStreamEvent>,
): Promise<ProxyStreamEvent[]> {
  const events: ProxyStreamEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

function emitCompletedTurn(
  events: EventQueue,
  threadId: string,
  turnId: string,
  text: string,
  usage = true,
): void {
  events.push({
    method: "item/agentMessage/delta",
    params: { threadId, turnId, itemId: "item-1", delta: "streamed " },
  });
  events.push({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      completedAtMs: 1,
      item: {
        type: "commandExecution",
        id: "internal-command",
        command: "pwd",
      },
    },
  } as never);
  events.push({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      completedAtMs: 2,
      item: {
        type: "reasoning",
        id: "internal-reasoning",
        summary: ["hidden"],
        content: ["hidden"],
      },
    },
  });
  events.push({
    method: "item/agentMessage/delta",
    params: { threadId, turnId, itemId: "item-1", delta: "delta" },
  });
  events.push({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      completedAtMs: 3,
      item: {
        type: "agentMessage",
        id: "item-1",
        text,
        phase: null,
        memoryCitation: null,
      },
    },
  });
  if (usage) {
    events.push({
      method: "thread/tokenUsage/updated",
      params: {
        threadId,
        turnId,
        tokenUsage: {
          total: {
            totalTokens: 99,
            inputTokens: 88,
            cachedInputTokens: 0,
            outputTokens: 11,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 12,
            inputTokens: 7,
            cachedInputTokens: 0,
            outputTokens: 5,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 128_000,
        },
      },
    });
  }
  events.push({
    method: "turn/completed",
    params: {
      threadId,
      turn: fakeTurn({
        id: turnId,
        status: "completed",
        completedAt: 2,
      }),
    },
  });
}

describe("TurnRunner", () => {
  it("projects deltas in order and uses completed items as final authority", async () => {
    const { events, host } = createHost();
    vi.mocked(host.turnStart).mockImplementation(async () => {
      emitCompletedTurn(events, "thread-1", "turn-1", "authoritative final");
      return { turn: fakeTurn() };
    });

    const projected = await collect(createRunner(host).stream(command()));

    expect(projected).toEqual([
      { type: "text.delta", delta: "streamed " },
      { type: "text.delta", delta: "delta" },
      {
        type: "usage",
        usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 },
      },
      {
        type: "completed",
        result: {
          threadId: "thread-1",
          turnId: "turn-1",
          text: "authoritative final",
          finishReason: "stop",
          usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 },
        },
      },
    ]);
    expect(host.events).toHaveBeenCalledTimes(1);
    expect(host.turnInterrupt).not.toHaveBeenCalled();
  });

  it("omits usage when Codex supplies no token event", async () => {
    const { events, host } = createHost();
    vi.mocked(host.turnStart).mockImplementation(async () => {
      emitCompletedTurn(events, "thread-1", "turn-1", "final", false);
      return { turn: fakeTurn() };
    });

    await expect(createRunner(host).run(command())).resolves.toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      text: "final",
      finishReason: "stop",
    });
  });

  it("hardens new threads and injects history plus newest developer instructions", async () => {
    const { events, host } = createHost();
    vi.mocked(host.turnStart).mockImplementation(async () => {
      emitCompletedTurn(events, "thread-1", "turn-1", "final", false);
      return { turn: fakeTurn() };
    });
    const history = [
      {
        type: "message" as const,
        role: "user",
        content: [{ type: "input_text" as const, text: "earlier" }],
      },
    ];

    await createRunner(host).run(
      command({ history, instructions: "newest developer instruction" }),
    );

    expect(host.threadStart).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.4",
        cwd: emptyWorkingDirectory,
        approvalPolicy: "never",
        sandbox: "read-only",
        baseInstructions: neutralInstructions,
        developerInstructions: null,
        ephemeral: false,
        serviceName: "openai_oauth_proxy",
        environments: [],
        selectedCapabilityRoots: [],
      }),
      expect.any(AbortSignal),
    );
    expect(host.threadInjectItems).toHaveBeenCalledWith(
      {
        threadId: "thread-1",
        items: [
          ...history,
          {
            type: "message",
            role: "developer",
            content: [
              { type: "input_text", text: "newest developer instruction" },
            ],
          },
        ],
      },
      expect.any(AbortSignal),
    );
    expect(host.threadInjectItems).toHaveBeenCalledBefore(
      vi.mocked(host.turnStart),
    );
  });

  it("passes dynamic tools only when creating a thread", async () => {
    const { events, host } = createHost();
    vi.mocked(host.turnStart).mockImplementation(async () => {
      emitCompletedTurn(events, "thread-1", "turn-1", "final", false);
      return { turn: fakeTurn() };
    });
    const dynamicTools = [
      {
        type: "function" as const,
        name: "weather",
        description: "Read weather",
        inputSchema: { type: "object" },
      },
    ];

    await createRunner(host).run(command({ dynamicTools }));

    expect(host.threadStart).toHaveBeenCalledWith(
      expect.objectContaining({ dynamicTools }),
      expect.any(AbortSignal),
    );
    expect(host.turnStart).not.toHaveBeenCalledWith(
      expect.objectContaining({ dynamicTools }),
      expect.anything(),
    );
  });

  it("suspends one live turn for a client tool result and then completes it", async () => {
    const { events, host, tools } = createHost();
    const runner = createRunner(host);
    const release = vi.fn();
    const cleanup = vi.fn();
    const dynamicTools = [
      {
        type: "function" as const,
        name: "weather",
        description: "Read weather",
        inputSchema: { type: "object" },
      },
    ];
    const fingerprint = runner.tools.fingerprint(dynamicTools);
    const respond = vi.fn();
    vi.mocked(host.turnStart).mockImplementation(async () => {
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

    const suspended = await runner.run(command({ dynamicTools }), undefined, {
      release,
      cleanup,
      tool: {
        kind: "chat",
        leaseOwner: "request-1",
        toolFingerprint: fingerprint,
      },
    });

    expect(suspended).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: expect.stringMatching(/^call_g1_/),
          name: "weather",
          arguments: { city: "Paris" },
        },
      ],
    });
    expect(release).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();

    const callId = suspended.toolCalls?.[0]?.id ?? "missing";
    const continuation = await runner.tools.continue({
      kind: "chat",
      toolFingerprint: fingerprint,
      results: [{ callId, output: "sunny" }],
    });
    expect(continuation.type).toBe("continued");
    if (continuation.type !== "continued") throw new Error("not continued");
    const nextEvent = continuation.events[Symbol.asyncIterator]().next();
    events.push({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-continued",
        delta: "live ",
      },
    });
    await expect(nextEvent).resolves.toEqual({
      done: false,
      value: { type: "text.delta", delta: "live " },
    });
    emitCompletedTurn(events, "thread-1", "turn-1", "sunny", false);
    await expect(continuation.result).resolves.toMatchObject({
      text: "sunny",
      finishReason: "stop",
    });
    expect(host.toolCalls).toHaveBeenCalledOnce();
    expect(host.turnStart).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith({
      success: true,
      contentItems: [{ type: "inputText", text: "sunny" }],
    });
    expect(release).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("interrupts and finalizes an expired suspended tool turn once", async () => {
    const { events, host, tools } = createHost();
    const runner = createRunner(host);
    const release = vi.fn();
    const cleanup = vi.fn();
    const dynamicTools = [
      {
        type: "function" as const,
        name: "lookup",
        description: "",
        inputSchema: {},
      },
    ];
    const fingerprint = runner.tools.fingerprint(dynamicTools);
    vi.mocked(host.turnStart).mockImplementationOnce(async () => {
      tools.push({
        generation: 1,
        id: "rpc-expiring",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "internal-expiring",
          namespace: null,
          tool: "lookup",
          arguments: {},
        },
        respond: vi.fn(),
        reject: vi.fn(),
      });
      return { turn: fakeTurn() };
    });
    vi.mocked(host.turnInterrupt).mockImplementationOnce(
      async ({ threadId, turnId }) => {
        events.push({
          method: "turn/completed",
          params: {
            threadId,
            turn: fakeTurn({ id: turnId, status: "interrupted" }),
          },
        });
        return {};
      },
    );
    const suspended = await runner.run(command({ dynamicTools }), undefined, {
      release,
      cleanup,
      tool: {
        kind: "chat",
        leaseOwner: "request-1",
        toolFingerprint: fingerprint,
      },
    });
    const callId = suspended.toolCalls?.[0]?.id ?? "missing";

    runner.tools.expire(Number.MAX_SAFE_INTEGER);

    await vi.waitFor(() => expect(host.turnInterrupt).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(
      runner.tools.continue({
        kind: "chat",
        toolFingerprint: fingerprint,
        results: [{ callId, output: "late" }],
      }),
    ).resolves.toEqual({ type: "lost" });
    expect(host.turnInterrupt).toHaveBeenCalledOnce();
  });

  it("does not inject an empty history", async () => {
    const { events, host } = createHost();
    vi.mocked(host.turnStart).mockImplementation(async () => {
      emitCompletedTurn(events, "thread-1", "turn-1", "final", false);
      return { turn: fakeTurn() };
    });

    await createRunner(host).run(command());

    expect(host.threadInjectItems).not.toHaveBeenCalled();
  });

  it("reports opened thread and started turn identities at their durable boundaries", async () => {
    const { events, host } = createHost();
    const opened = vi.fn();
    const started = vi.fn();
    vi.mocked(host.turnStart).mockImplementation(async () => {
      emitCompletedTurn(events, "thread-1", "turn-1", "final", false);
      return { turn: fakeTurn({ id: "turn-1" }) };
    });

    await createRunner(host).run(command(), undefined, { opened, started });

    expect(opened).toHaveBeenCalledWith("thread-1");
    expect(opened).toHaveBeenCalledBefore(vi.mocked(host.turnStart));
    expect(started).toHaveBeenCalledWith("thread-1", "turn-1");
    expect(started).toHaveBeenCalledAfter(vi.mocked(host.turnStart));
  });

  it("resumes and forks with the requested lineage", async () => {
    const { events, host } = createHost();
    vi.mocked(host.turnStart).mockImplementation(async ({ threadId }) => {
      emitCompletedTurn(events, threadId, "turn-1", "final", false);
      return { turn: fakeTurn() };
    });
    const runner = createRunner(host);

    await runner.run(
      command({ action: { type: "resume", threadId: "thread-existing" } }),
    );
    await runner.run(
      command({
        action: {
          type: "fork",
          threadId: "thread-existing",
          lastTurnId: "turn-parent",
        },
      }),
    );

    expect(host.threadResume).toHaveBeenCalledWith(
      { threadId: "thread-existing" },
      expect.any(AbortSignal),
    );
    expect(host.threadFork).toHaveBeenCalledWith(
      { threadId: "thread-existing", lastTurnId: "turn-parent" },
      expect.any(AbortSignal),
    );
  });

  it("uses a response operation cwd for new and forked threads", async () => {
    const { events, host } = createHost();
    vi.mocked(host.turnStart).mockImplementation(async ({ threadId }) => {
      emitCompletedTurn(events, threadId, "turn-1", "final", false);
      return { turn: fakeTurn() };
    });
    const runner = createRunner(host);

    await runner.run(command({ cwd: "/tmp/work/resp_start" }));
    await runner.run(
      command({
        action: {
          type: "fork",
          threadId: "thread-existing",
          lastTurnId: "turn-parent",
        },
        cwd: "/tmp/work/resp_fork",
      }),
    );

    expect(host.threadStart).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/work/resp_start" }),
      expect.any(AbortSignal),
    );
    expect(host.threadFork).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/work/resp_fork" }),
      expect.any(AbortSignal),
    );
  });

  it("routes four concurrent turns through one dispatcher", async () => {
    const { events, host } = createHost();
    vi.mocked(host.turnStart).mockImplementation(async ({ threadId }) => {
      const turnId = `turn-${threadId}`;
      emitCompletedTurn(events, threadId, turnId, `answer-${threadId}`, false);
      return { turn: fakeTurn({ id: turnId }) };
    });
    const runner = createRunner(host);

    const threadIds = ["a", "b", "c", "d"];
    const results = await Promise.all(
      threadIds.map((threadId) =>
        runner.run(command({ action: { type: "resume", threadId } })),
      ),
    );

    expect(results.map(({ text }) => text)).toEqual(
      threadIds.map((threadId) => `answer-${threadId}`),
    );
    expect(host.events).toHaveBeenCalledTimes(1);
  });

  it("fails if generation changes while opening a thread", async () => {
    const { host } = createHost();
    const cleanup = vi.fn();
    const opening = deferred<Awaited<ReturnType<CodexHost["threadStart"]>>>();
    vi.mocked(host.threadStart).mockReturnValue(opening.promise);
    const result = createRunner(host, { cleanup }).run(
      command({
        history: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "history" }],
          },
        ],
      }),
    );

    await vi.waitFor(() => expect(host.threadStart).toHaveBeenCalledOnce());
    opening.resolve(fakeThreadStartResponse());
    setGeneration(host, 2);

    await expect(result).rejects.toMatchObject({
      status: 503,
      code: "codex_generation_changed",
    });
    expect(host.threadInjectItems).not.toHaveBeenCalled();
    expect(host.turnStart).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith("thread-1", expect.any(AbortSignal));
  });

  it("fails if generation changes while injecting history", async () => {
    const { host } = createHost();
    const injection =
      deferred<Awaited<ReturnType<CodexHost["threadInjectItems"]>>>();
    vi.mocked(host.threadInjectItems).mockReturnValue(injection.promise);
    const result = createRunner(host).run(
      command({
        history: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "history" }],
          },
        ],
      }),
    );

    await vi.waitFor(() =>
      expect(host.threadInjectItems).toHaveBeenCalledOnce(),
    );
    injection.resolve({});
    setGeneration(host, 2);

    await expect(result).rejects.toMatchObject({
      status: 503,
      code: "codex_generation_changed",
    });
    expect(host.turnStart).not.toHaveBeenCalled();
  });

  it("fails if generation changes while starting a turn", async () => {
    const { host } = createHost();
    const starting = deferred<Awaited<ReturnType<CodexHost["turnStart"]>>>();
    vi.mocked(host.turnStart).mockReturnValue(starting.promise);
    const result = createRunner(host).run(command());

    await vi.waitFor(() => expect(host.turnStart).toHaveBeenCalledOnce());
    starting.resolve({ turn: fakeTurn() });
    setGeneration(host, 2);

    await expect(result).rejects.toMatchObject({
      status: 503,
      code: "codex_generation_changed",
    });
  });

  it("rejects a routed event from another generation", async () => {
    const { events, host } = createHost();
    vi.mocked(host.turnStart).mockImplementation(async () => {
      events.push(
        {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "item-1",
            delta: "must not escape",
          },
        },
        2,
      );
      return { turn: fakeTurn() };
    });

    await expect(createRunner(host).run(command())).rejects.toMatchObject({
      status: 503,
      code: "codex_generation_changed",
    });
  });

  it("normalizes a generation change while awaiting turn events", async () => {
    const { events, host } = createHost();
    const result = createRunner(host).run(command());

    await vi.waitFor(() => expect(host.turnStart).toHaveBeenCalledOnce());
    setGeneration(host, 2);
    events.fail(new CodexGenerationChangedError());

    const error = await result.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ProxyError);
    expect(error).toMatchObject({
      status: 503,
      code: "codex_generation_changed",
    });
  });

  it("reconnects the central dispatcher for a later host generation", async () => {
    const firstGeneration = new EventQueue();
    const secondGeneration = new EventQueue();
    const { host } = createHost();
    vi.mocked(host.events)
      .mockReturnValueOnce(firstGeneration)
      .mockReturnValue(secondGeneration);
    vi.mocked(host.turnStart)
      .mockResolvedValueOnce({ turn: fakeTurn() })
      .mockImplementationOnce(async () => {
        emitCompletedTurn(
          secondGeneration,
          "thread-1",
          "turn-1",
          "after restart",
          false,
        );
        return { turn: fakeTurn() };
      });
    const runner = createRunner(host, { timeoutMs: 1_000, interruptWaitMs: 5 });

    const failedGeneration = expect(
      runner.run(command()),
    ).rejects.toMatchObject({
      code: "codex_host_error",
    });
    await vi.waitFor(() => expect(host.turnStart).toHaveBeenCalledOnce());
    expect(host.events).toHaveReturnedWith(firstGeneration);
    firstGeneration.fail(new Error("generation changed"));
    await failedGeneration;

    const nextRunner = createRunner(host, {
      timeoutMs: 10,
      interruptWaitMs: 5,
    });
    await expect(nextRunner.run(command())).resolves.toMatchObject({
      text: "after restart",
    });
    expect(host.events).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["failed", 502, "codex_turn_failed"],
    ["interrupted", 499, "codex_turn_interrupted"],
  ] as const)(
    "maps %s turns to a stable error",
    async (status, httpStatus, code) => {
      const { events, host } = createHost();
      vi.mocked(host.turnStart).mockImplementation(async () => {
        events.push({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: fakeTurn({
              status,
              error:
                status === "failed"
                  ? {
                      message: "sensitive upstream failure",
                      codexErrorInfo: null,
                      additionalDetails: null,
                    }
                  : null,
            }),
          },
        });
        return { turn: fakeTurn() };
      });

      await expect(createRunner(host).run(command())).rejects.toMatchObject({
        status: httpStatus,
        code,
      });
    },
  );

  it("interrupts once on abort and runs release and cleanup once", async () => {
    const { events, host } = createHost();
    const release = vi.fn(async () => undefined);
    const cleanup = vi.fn(async () => undefined);
    vi.mocked(host.turnInterrupt).mockImplementation(
      async ({ threadId, turnId }) => {
        events.push({
          method: "turn/completed",
          params: {
            threadId,
            turn: fakeTurn({ id: turnId, status: "interrupted" }),
          },
        });
        return {};
      },
    );
    const controller = new AbortController();
    const result = createRunner(host, { release, cleanup })
      .run(command(), controller.signal)
      .catch((error: unknown) => error);

    await vi.waitFor(() => expect(host.turnStart).toHaveBeenCalledOnce());
    controller.abort();
    const error = await result;

    expect(error).toMatchObject({ code: "request_aborted", status: 499 });
    expect(host.turnInterrupt).toHaveBeenCalledTimes(1);
    expect(host.turnInterrupt).toHaveBeenCalledWith({
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(release).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith("thread-1", expect.any(AbortSignal));
  });

  it("interrupts once when abort races a pending turn start", async () => {
    const { events, host } = createHost();
    let turnStartSignal: AbortSignal | undefined;
    vi.mocked(host.turnStart).mockImplementation((_params, signal) => {
      turnStartSignal = signal;
      return new Promise((_, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    });
    vi.mocked(host.turnInterrupt).mockImplementation(
      async ({ threadId, turnId }) => {
        events.push({
          method: "turn/completed",
          params: {
            threadId,
            turn: fakeTurn({ id: turnId, status: "interrupted" }),
          },
        });
        return {};
      },
    );
    const release = vi.fn();
    const cleanup = vi.fn();
    const controller = new AbortController();
    const result = createRunner(host, {
      release,
      cleanup,
      interruptWaitMs: 20,
    }).run(command(), controller.signal);

    await vi.waitFor(() => expect(host.turnStart).toHaveBeenCalledOnce());
    controller.abort();
    await Promise.resolve();
    events.push({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "late",
      },
    });

    await expect(result).rejects.toMatchObject({
      status: 499,
      code: "request_aborted",
    });
    expect(turnStartSignal?.aborted).toBe(true);
    expect(host.turnInterrupt).toHaveBeenCalledTimes(1);
    expect(host.turnInterrupt).toHaveBeenCalledWith({
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(release).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("times out without hanging on a pending turn start", async () => {
    const { host } = createHost();
    let turnStartSignal: AbortSignal | undefined;
    vi.mocked(host.turnStart).mockImplementation(async (_params, signal) => {
      turnStartSignal = signal;
      return new Promise(() => undefined);
    });
    const release = vi.fn();
    const cleanup = vi.fn();

    await expect(
      createRunner(host, {
        timeoutMs: 5,
        interruptWaitMs: 5,
        release,
        cleanup,
      }).run(command()),
    ).rejects.toMatchObject({ status: 504, code: "turn_timeout" });
    expect(turnStartSignal?.aborted).toBe(true);
    expect(host.turnInterrupt).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("settles release and cleanup independently and reports release first", async () => {
    const { events, host } = createHost();
    vi.mocked(host.turnStart).mockImplementation(async () => {
      emitCompletedTurn(events, "thread-1", "turn-1", "final", false);
      return { turn: fakeTurn() };
    });
    const releaseError = new Error("release failed");
    const release = vi.fn(() => {
      throw releaseError;
    });
    const cleanup = vi.fn(async () => {
      throw new Error("cleanup failed");
    });

    await expect(
      createRunner(host, { release, cleanup }).run(command()),
    ).rejects.toBe(releaseError);
    expect(release).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("bounds lifecycle cleanup and aborts its signal", async () => {
    const { events, host } = createHost();
    let cleanupSignal: AbortSignal | undefined;
    vi.mocked(host.turnStart).mockImplementation(async () => {
      emitCompletedTurn(events, "thread-1", "turn-1", "final", false);
      return { turn: fakeTurn() };
    });
    const cleanup = vi.fn(
      async (_threadId: string, signal?: AbortSignal): Promise<void> => {
        cleanupSignal = signal;
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    );

    await expect(
      createRunner(host, { cleanup, lifecycleWaitMs: 5 }).run(command()),
    ).rejects.toMatchObject({
      status: 502,
      code: "turn_lifecycle_timeout",
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanupSignal?.aborted).toBe(true);
  });

  it("bounds the wait when interrupted completion is not emitted", async () => {
    const { host } = createHost();
    const controller = new AbortController();
    const result = createRunner(host, { interruptWaitMs: 5 }).run(
      command(),
      controller.signal,
    );

    await vi.waitFor(() => expect(host.turnStart).toHaveBeenCalledOnce());
    controller.abort();

    await expect(result).rejects.toMatchObject({
      code: "request_aborted",
      status: 499,
    });
    expect(host.turnInterrupt).toHaveBeenCalledOnce();
  });

  it("bounds a hung interrupt RPC from the moment it is issued", async () => {
    const { host } = createHost();
    const release = vi.fn();
    const cleanup = vi.fn();
    vi.mocked(host.turnInterrupt).mockImplementation(
      async () => new Promise(() => undefined),
    );
    const controller = new AbortController();
    const result = createRunner(host, {
      interruptWaitMs: 5,
      release,
      cleanup,
    }).run(command(), controller.signal);

    await vi.waitFor(() => expect(host.turnStart).toHaveBeenCalledOnce());
    controller.abort();
    const outcome = await Promise.race([
      result.catch((error: unknown) => error),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 50)),
    ]);

    expect(outcome).not.toBe("hung");
    expect(outcome).toMatchObject({ code: "request_aborted", status: 499 });
    expect(host.turnInterrupt).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("settles lifecycle when turn interrupt throws synchronously", async () => {
    const { host } = createHost();
    const release = vi.fn();
    const cleanup = vi.fn();
    vi.mocked(host.turnInterrupt).mockImplementation(() => {
      throw new Error("sensitive synchronous interrupt failure");
    });
    const controller = new AbortController();
    const result = createRunner(host, {
      interruptWaitMs: 5,
      release,
      cleanup,
    }).run(command(), controller.signal);

    await vi.waitFor(() => expect(host.turnStart).toHaveBeenCalledOnce());
    controller.abort();

    await expect(result).rejects.toMatchObject({
      code: "codex_host_error",
      status: 502,
    });
    expect(host.turnInterrupt).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("preserves timeout status when its interrupt RPC hangs", async () => {
    const { host } = createHost();
    const release = vi.fn();
    const cleanup = vi.fn();
    vi.mocked(host.turnInterrupt).mockImplementation(
      async () => new Promise(() => undefined),
    );
    const result = createRunner(host, {
      timeoutMs: 5,
      interruptWaitMs: 5,
      release,
      cleanup,
    }).run(command());
    const outcome = await Promise.race([
      result.catch((error: unknown) => error),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 50)),
    ]);

    expect(outcome).not.toBe("hung");
    expect(outcome).toMatchObject({ code: "turn_timeout", status: 504 });
    expect(host.turnInterrupt).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("interrupts a timed-out turn and reports a timeout", async () => {
    const { events, host } = createHost();
    vi.mocked(host.turnInterrupt).mockImplementation(
      async ({ threadId, turnId }) => {
        events.push({
          method: "turn/completed",
          params: {
            threadId,
            turn: fakeTurn({ id: turnId, status: "interrupted" }),
          },
        });
        return {};
      },
    );

    await expect(
      createRunner(host, { timeoutMs: 5 }).run(command()),
    ).rejects.toMatchObject({ status: 504, code: "turn_timeout" });
    expect(host.turnInterrupt).toHaveBeenCalledTimes(1);
  });
});
