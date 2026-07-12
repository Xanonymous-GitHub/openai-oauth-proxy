import type { ResponseItem } from "../codex/generated/ResponseItem.js";
import type { JsonValue } from "../codex/generated/serde_json/JsonValue.js";
import type { Turn } from "../codex/generated/v2/Turn.js";
import type { CodexHost, HostNotification } from "../codex/host.js";
import { CodexGenerationChangedError } from "../codex/transport.js";
import { ProxyError } from "../http/errors.js";
import {
  type ExternalToolCall,
  type ToolBridge,
  type ToolBridgeContext,
  toolBridgeFor,
} from "../tools/bridge.js";
import {
  eventDispatcherFor,
  type ProxyStreamEvent,
  type TokenUsage,
  type TurnCommand,
  type TurnEventSubscription,
  type TurnResult,
} from "./events.js";

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_INTERRUPT_WAIT_MS = 5_000;
const DEFAULT_LIFECYCLE_WAIT_MS = 5_000;

type LifecycleCallback = () => void | Promise<void>;
type OpenedCallback = (threadId: string) => void | Promise<void>;
type StartedCallback = (
  threadId: string,
  turnId: string,
) => void | Promise<void>;
type CleanupCallback = (
  threadId: string,
  signal?: AbortSignal,
) => void | Promise<void>;

export interface TurnToolLifecycle {
  kind: "chat" | "responses";
  responseId?: string;
  leaseOwner: string;
  toolFingerprint: string;
  suspended?: (threadId: string, turnId: string) => void | Promise<void>;
  lost?: (threadId: string, turnId: string) => void | Promise<void>;
}

export interface TurnLifecycleCallbacks {
  opened?: OpenedCallback;
  started?: StartedCallback;
  release?: LifecycleCallback;
  cleanup?: CleanupCallback;
  tool?: TurnToolLifecycle;
}

export interface TurnRunnerOptions {
  host: CodexHost;
  emptyWorkingDirectory: string;
  neutralInstructions: string;
  timeoutMs?: number;
  interruptWaitMs?: number;
  lifecycleWaitMs?: number;
  toolTimeoutMs?: number;
  release?: LifecycleCallback;
  cleanup?: CleanupCallback;
}

type CancellationCause = "abort" | "timeout";

function cancellationError(cause: CancellationCause): ProxyError {
  return cause === "timeout"
    ? new ProxyError(504, "turn_timeout", "Codex turn timed out")
    : new ProxyError(499, "request_aborted", "Request aborted");
}

function completedTurnError(turn: Turn): ProxyError | undefined {
  if (turn.status === "failed") {
    return new ProxyError(502, "codex_turn_failed", "Codex turn failed");
  }
  if (turn.status === "interrupted") {
    return new ProxyError(
      499,
      "codex_turn_interrupted",
      "Codex turn interrupted",
    );
  }
  if (turn.status !== "completed") {
    return new ProxyError(
      502,
      "codex_protocol_error",
      "Codex emitted a non-terminal completed turn",
    );
  }
  return undefined;
}

function normalizeError(error: unknown): ProxyError {
  if (error instanceof ProxyError) return error;
  if (error instanceof CodexGenerationChangedError) {
    return new ProxyError(
      503,
      "codex_generation_changed",
      "Codex host generation changed",
    );
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return cancellationError("abort");
  }
  return new ProxyError(502, "codex_host_error", "Codex host request failed");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    timeout.unref?.();
  });
}

function pending<T>(): Promise<T> {
  return new Promise(() => undefined);
}

interface EventWaiter {
  resolve(value: IteratorResult<ProxyStreamEvent>): void;
}

class StreamQueue implements AsyncIterable<ProxyStreamEvent> {
  readonly #events: ProxyStreamEvent[] = [];
  readonly #waiters: EventWaiter[] = [];
  #closed = false;

  push(event: ProxyStreamEvent): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: event });
    else this.#events.push(event);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ProxyStreamEvent> {
    return {
      next: async () => {
        const event = this.#events.shift();
        if (event) return { done: false, value: event };
        if (this.#closed) return { done: true, value: undefined };
        return new Promise((resolve) => this.#waiters.push({ resolve }));
      },
      return: async () => {
        this.close();
        return { done: true, value: undefined };
      },
    };
  }
}

class TurnStage {
  readonly events = new StreamQueue();
  readonly result: Promise<TurnResult>;
  #resolve!: (result: TurnResult) => void;
  #reject!: (error: unknown) => void;
  settled = false;

  constructor() {
    this.result = new Promise<TurnResult>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    void this.result.catch(() => undefined);
  }

  complete(result: TurnResult): void {
    if (this.settled) return;
    this.settled = true;
    this.events.push({ type: "completed", result });
    this.events.close();
    this.#resolve(result);
  }

  fail(error: unknown, streamError: ProxyError): void {
    if (this.settled) return;
    this.settled = true;
    this.events.push({ type: "failed", error: streamError });
    this.events.close();
    this.#reject(error);
  }
}

class TurnAccumulator {
  #stage = new TurnStage();

  result(): Promise<TurnResult> {
    return this.#stage.result;
  }

  stream(): AsyncIterable<ProxyStreamEvent> {
    return this.#stage.events;
  }

  emit(
    event: Exclude<ProxyStreamEvent, { type: "completed" | "failed" }>,
  ): void {
    this.#stage.events.push(event);
  }

  complete(result: TurnResult): void {
    this.#stage.complete(result);
  }

  resume(): Promise<TurnResult> {
    if (!this.#stage.settled) {
      throw new Error("Cannot continue a turn before it is suspended");
    }
    this.#stage = new TurnStage();
    return this.#stage.result;
  }

  fail(error: unknown, streamError = normalizeError(error)): void {
    this.#stage.fail(error, streamError);
  }
}

function usageFrom(
  event: Extract<HostNotification, { method: "thread/tokenUsage/updated" }>,
): TokenUsage {
  const usage = event.params.tokenUsage.last;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}

function completedText(turn: Turn, current: string): string {
  let text = current;
  for (const item of turn.items) {
    if (item.type === "agentMessage") text = item.text;
  }
  return text;
}

export class TurnRunner {
  readonly #host: CodexHost;
  readonly #emptyWorkingDirectory: string;
  readonly #neutralInstructions: string;
  readonly #timeoutMs: number;
  readonly #interruptWaitMs: number;
  readonly #lifecycleWaitMs: number;
  readonly #release: LifecycleCallback | undefined;
  readonly #cleanup: CleanupCallback | undefined;
  readonly #dispatcher;
  readonly #interrupts = new Set<() => void>();
  readonly #idleWaiters = new Set<() => void>();
  readonly tools: ToolBridge;

  constructor(options: TurnRunnerOptions) {
    this.#host = options.host;
    this.#emptyWorkingDirectory = options.emptyWorkingDirectory;
    this.#neutralInstructions = options.neutralInstructions;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#interruptWaitMs =
      options.interruptWaitMs ?? DEFAULT_INTERRUPT_WAIT_MS;
    this.#lifecycleWaitMs =
      options.lifecycleWaitMs ?? DEFAULT_LIFECYCLE_WAIT_MS;
    this.#release = options.release;
    this.#cleanup = options.cleanup;
    this.#dispatcher = eventDispatcherFor(options.host);
    this.tools = toolBridgeFor(options.host, options.toolTimeoutMs);
  }

  get active(): number {
    return this.#interrupts.size;
  }

  async interruptAll(): Promise<void> {
    this.tools.invalidateAll();
    for (const interrupt of [...this.#interrupts]) interrupt();
    if (this.#interrupts.size === 0) return;
    await new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
  }

  async run(
    command: TurnCommand,
    signal?: AbortSignal,
    lifecycle?: TurnLifecycleCallbacks,
  ): Promise<TurnResult> {
    const accumulator = new TurnAccumulator();
    void this.execute(command, signal, lifecycle, false, accumulator);
    return accumulator.result();
  }

  stream(
    command: TurnCommand,
    signal?: AbortSignal,
    lifecycle?: TurnLifecycleCallbacks,
  ): AsyncIterable<ProxyStreamEvent> {
    const accumulator = new TurnAccumulator();
    void this.execute(command, signal, lifecycle, true, accumulator);
    return accumulator.stream();
  }

  private async execute(
    command: TurnCommand,
    signal: AbortSignal | undefined,
    lifecycle: TurnLifecycleCallbacks | undefined,
    projectLifecycleFailures: boolean,
    accumulator: TurnAccumulator,
  ): Promise<void> {
    const generation = this.#host.generation;
    let threadId: string | undefined;
    let turnId: string | undefined;
    let subscription: TurnEventSubscription | undefined;
    let terminal = false;
    let cancellationCause: CancellationCause | undefined;
    let generationFailure: CodexGenerationChangedError | undefined;
    let interruptPromise: Promise<void> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let interruptWait: ReturnType<typeof setTimeout> | undefined;
    let interruptDeadline: number | undefined;
    let toolContext: ToolBridgeContext | undefined;
    const drainController = new AbortController();
    let clientSignal: AbortSignal | undefined = signal
      ? AbortSignal.any([signal, drainController.signal])
      : drainController.signal;
    let text = "";
    let usage: TokenUsage | undefined;
    const release = lifecycle?.release ?? this.#release;
    const cleanup = lifecycle?.cleanup ?? this.#cleanup;
    const turnStartController = new AbortController();
    let resolveCancellation!: (cause: CancellationCause) => void;
    const cancelled = new Promise<CancellationCause>((resolve) => {
      resolveCancellation = resolve;
    });

    const issueInterrupt = (): void => {
      if (terminal || interruptPromise || !threadId || !subscription) {
        return;
      }
      const knownTurnId = turnId ?? subscription.turnId;
      if (!knownTurnId) return;
      const knownThreadId = threadId;
      turnId = knownTurnId;
      try {
        this.assertGeneration(generation);
      } catch (error) {
        if (error instanceof CodexGenerationChangedError) {
          generationFailure = error;
        }
        subscription.fail(error);
        return;
      }
      interruptDeadline = Date.now() + this.#interruptWaitMs;
      interruptWait = setTimeout(() => {
        subscription?.fail(cancellationError(cancellationCause ?? "abort"));
      }, this.#interruptWaitMs);
      interruptWait.unref?.();
      interruptPromise = Promise.resolve()
        .then(() =>
          this.#host.turnInterrupt({
            threadId: knownThreadId,
            turnId: knownTurnId,
          }),
        )
        .then(() => {
          this.assertGeneration(generation);
        })
        .catch((error: unknown) => {
          if (error instanceof CodexGenerationChangedError) {
            generationFailure = error;
          }
          subscription?.fail(error);
        });
    };
    const requestCancellation = (cause: CancellationCause): void => {
      if (terminal || cancellationCause) return;
      cancellationCause = cause;
      drainController.abort();
      turnStartController.abort();
      resolveCancellation(cause);
      issueInterrupt();
    };
    const interrupt = (): void => requestCancellation("abort");
    this.#interrupts.add(interrupt);
    const onAbort = (): void => requestCancellation("abort");
    const detachClient = (): void => {
      clientSignal?.removeEventListener("abort", onAbort);
      clientSignal = undefined;
    };
    const attachClient = (nextSignal?: AbortSignal): void => {
      detachClient();
      clientSignal = nextSignal;
      clientSignal?.addEventListener("abort", onAbort, { once: true });
      if (clientSignal?.aborted) onAbort();
    };
    const startTimeout = (): void => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(
        () => requestCancellation("timeout"),
        this.#timeoutMs,
      );
      timeout.unref?.();
    };
    let finalization: Promise<unknown | undefined> | undefined;
    const finalize = (): Promise<unknown | undefined> => {
      finalization ??= (async () => {
        const shouldInterrupt = !terminal;
        if (timeout) clearTimeout(timeout);
        if (interruptWait) clearTimeout(interruptWait);
        detachClient();

        if (shouldInterrupt) issueInterrupt();
        terminal = true;
        if (interruptPromise) {
          const remaining = Math.max(
            0,
            (interruptDeadline ?? Date.now()) - Date.now(),
          );
          if (remaining > 0) {
            await Promise.race([
              interruptPromise.catch(() => undefined),
              delay(remaining),
            ]);
          }
        }
        subscription?.close();
        if (toolContext) this.tools.complete(toolContext);

        const cleanupController = new AbortController();
        const callbacks = Promise.allSettled([
          Promise.resolve().then(() => release?.()),
          Promise.resolve().then(() =>
            threadId === undefined
              ? undefined
              : cleanup?.(threadId, cleanupController.signal),
          ),
        ]);
        const settled = await Promise.race([
          callbacks,
          delay(this.#lifecycleWaitMs).then(() => undefined),
        ]);
        if (settled === undefined) {
          cleanupController.abort();
          return new ProxyError(
            502,
            "turn_lifecycle_timeout",
            "Codex turn lifecycle cleanup timed out",
          );
        }
        const [releaseResult, cleanupResult] = settled;
        if (releaseResult.status === "rejected") return releaseResult.reason;
        if (cleanupResult.status === "rejected") return cleanupResult.reason;
        if (generationFailure) return normalizeError(generationFailure);
        return undefined;
      })();
      return finalization;
    };

    try {
      clientSignal?.throwIfAborted();
      threadId = await this.openThread(command, generation, clientSignal);
      this.assertGeneration(generation);
      clientSignal?.throwIfAborted();
      await lifecycle?.opened?.(threadId);
      this.assertGeneration(generation);
      clientSignal?.throwIfAborted();

      const items: ResponseItem[] = [...command.history];
      if (command.instructions !== undefined) {
        items.push({
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: command.instructions }],
        });
      }
      if (items.length > 0) {
        this.assertGeneration(generation);
        await this.#host.threadInjectItems(
          { threadId, items: items as unknown as JsonValue[] },
          clientSignal,
        );
        this.assertGeneration(generation);
      }
      clientSignal?.throwIfAborted();

      subscription = this.#dispatcher.register(threadId, generation);
      const subscriptionFailure = subscription.whenFailed();
      attachClient(clientSignal);
      startTimeout();

      this.assertGeneration(generation);
      const turnStartOutcome = this.#host
        .turnStart(
          {
            threadId,
            input: command.input,
            model: command.model,
            ...(command.effort === undefined ? {} : { effort: command.effort }),
            ...(command.outputSchema === undefined
              ? {}
              : { outputSchema: command.outputSchema }),
          },
          turnStartController.signal,
        )
        .then(
          (response) => {
            this.assertGeneration(generation);
            return { type: "started" as const, response };
          },
          (error: unknown) => ({ type: "failed" as const, error }),
        );
      const start = await Promise.race([
        turnStartOutcome,
        cancelled.then((cause) => ({ type: "cancelled" as const, cause })),
        subscriptionFailure,
      ]);

      if (start.type === "started") {
        turnId = start.response.turn.id;
        subscription.bind(turnId);
        if (cancellationCause) issueInterrupt();
      } else if (start.type === "failed" && !cancellationCause) {
        throw start.error;
      } else {
        const cause =
          start.type === "cancelled" ? start.cause : cancellationCause;
        if (!cause) throw new Error("Missing turn cancellation cause");
        const responseTurnId = turnStartOutcome.then((outcome) => {
          if (outcome.type === "started") return outcome.response.turn.id;
          if (outcome.error instanceof CodexGenerationChangedError) {
            throw outcome.error;
          }
          return pending<string>();
        });
        const knownTurnId = await Promise.race([
          responseTurnId,
          subscription.whenBound(),
          subscriptionFailure,
          delay(this.#interruptWaitMs).then(() => undefined),
        ]);
        this.assertGeneration(generation);
        if (!knownTurnId) throw cancellationError(cause);
        turnId = knownTurnId;
        if (subscription.turnId === undefined) subscription.bind(turnId);
        issueInterrupt();
      }

      await lifecycle?.started?.(threadId, turnId);
      this.assertGeneration(generation);
      clientSignal?.throwIfAborted();
      const activeThreadId = threadId;
      const activeTurnId = turnId;

      if (
        command.dynamicTools &&
        command.dynamicTools.length > 0 &&
        lifecycle?.tool
      ) {
        const toolLifecycle = lifecycle.tool;
        let pendingCalls: ExternalToolCall[] = [];
        let flushScheduled = false;
        const flushCalls = async (): Promise<void> => {
          flushScheduled = false;
          const calls = pendingCalls;
          pendingCalls = [];
          if (calls.length === 0 || cancellationCause) return;
          await toolLifecycle.suspended?.(activeThreadId, activeTurnId);
          if (timeout) clearTimeout(timeout);
          timeout = undefined;
          detachClient();
          for (const call of calls)
            accumulator.emit({ type: "tool.call", call });
          accumulator.complete({
            threadId: activeThreadId,
            turnId: activeTurnId,
            text,
            finishReason: "tool_calls",
            toolCalls: calls,
            ...(usage === undefined ? {} : { usage }),
          });
        };
        toolContext = {
          kind: toolLifecycle.kind,
          ...(toolLifecycle.responseId === undefined
            ? {}
            : { responseId: toolLifecycle.responseId }),
          threadId: activeThreadId,
          turnId: activeTurnId,
          leaseOwner: toolLifecycle.leaseOwner,
          generation,
          toolFingerprint: toolLifecycle.toolFingerprint,
          resume: (nextSignal) => {
            const result = accumulator.resume();
            attachClient(nextSignal);
            startTimeout();
            return result;
          },
          invalidate: async () => {
            requestCancellation("timeout");
            await toolLifecycle.lost?.(activeThreadId, activeTurnId);
          },
        };
        this.tools.attach(toolContext, (call) => {
          pendingCalls.push(call);
          if (flushScheduled) return;
          flushScheduled = true;
          setImmediate(() => {
            void flushCalls().catch((error: unknown) =>
              subscription?.fail(error),
            );
          });
        });
      }

      for await (const event of subscription) {
        this.assertGeneration(generation);
        switch (event.method) {
          case "item/agentMessage/delta":
            accumulator.emit({ type: "text.delta", delta: event.params.delta });
            break;
          case "item/completed":
            if (event.params.item.type === "agentMessage") {
              text = event.params.item.text;
            }
            break;
          case "thread/tokenUsage/updated":
            usage = usageFrom(event);
            accumulator.emit({ type: "usage", usage });
            break;
          case "turn/completed": {
            terminal = true;
            text = completedText(event.params.turn, text);
            const error = cancellationCause
              ? cancellationError(cancellationCause)
              : completedTurnError(event.params.turn);
            const lifecycleError = await finalize();
            if (lifecycleError !== undefined) {
              if (projectLifecycleFailures) {
                accumulator.fail(
                  normalizeError(lifecycleError),
                  normalizeError(lifecycleError),
                );
                return;
              }
              accumulator.fail(lifecycleError, normalizeError(lifecycleError));
              return;
            }
            if (error) {
              accumulator.fail(error, error);
              return;
            }
            const result: TurnResult = {
              threadId,
              turnId,
              text,
              finishReason: "stop",
              ...(usage === undefined ? {} : { usage }),
            };
            accumulator.complete(result);
            return;
          }
        }
      }
    } catch (error) {
      const lifecycleError = await finalize();
      if (lifecycleError !== undefined) {
        if (projectLifecycleFailures) {
          accumulator.fail(
            normalizeError(lifecycleError),
            normalizeError(lifecycleError),
          );
          return;
        }
        accumulator.fail(lifecycleError, normalizeError(lifecycleError));
        return;
      }
      accumulator.fail(normalizeError(error));
    } finally {
      await finalize();
      this.#interrupts.delete(interrupt);
      if (this.#interrupts.size === 0) {
        for (const resolve of this.#idleWaiters) resolve();
        this.#idleWaiters.clear();
      }
    }
  }

  private async openThread(
    command: TurnCommand,
    generation: number,
    signal?: AbortSignal,
  ): Promise<string> {
    this.assertGeneration(generation);
    switch (command.action.type) {
      case "start": {
        const response = await this.#host.threadStart(
          {
            model: command.model,
            cwd: command.cwd ?? this.#emptyWorkingDirectory,
            approvalPolicy: "never",
            sandbox: "read-only",
            baseInstructions: this.#neutralInstructions,
            developerInstructions: null,
            ephemeral: false,
            serviceName: "openai_oauth_proxy",
            environments: [],
            ...(command.dynamicTools === undefined
              ? {}
              : { dynamicTools: command.dynamicTools }),
            selectedCapabilityRoots: [],
          },
          signal,
        );
        return response.thread.id;
      }
      case "resume": {
        const response = await this.#host.threadResume(
          { threadId: command.action.threadId },
          signal,
        );
        return response.thread.id;
      }
      case "fork": {
        const response = await this.#host.threadFork(
          {
            threadId: command.action.threadId,
            lastTurnId: command.action.lastTurnId,
            ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
          },
          signal,
        );
        return response.thread.id;
      }
    }
  }

  private assertGeneration(generation: number): void {
    if (this.#host.generation !== generation) {
      throw new CodexGenerationChangedError();
    }
  }
}
