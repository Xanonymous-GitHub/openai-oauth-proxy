import type { ResponseItem } from "../codex/generated/ResponseItem.js";
import type { JsonValue } from "../codex/generated/serde_json/JsonValue.js";
import type { Turn } from "../codex/generated/v2/Turn.js";
import type { CodexHost, HostNotification } from "../codex/host.js";
import { CodexGenerationChangedError } from "../codex/transport.js";
import { ProxyError } from "../http/errors.js";
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

type LifecycleCallback = () => void | Promise<void>;
type CleanupCallback = (threadId: string) => void | Promise<void>;

export interface TurnRunnerOptions {
  host: CodexHost;
  emptyWorkingDirectory: string;
  neutralInstructions: string;
  timeoutMs?: number;
  interruptWaitMs?: number;
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
  readonly #release: LifecycleCallback | undefined;
  readonly #cleanup: CleanupCallback | undefined;
  readonly #dispatcher;

  constructor(options: TurnRunnerOptions) {
    this.#host = options.host;
    this.#emptyWorkingDirectory = options.emptyWorkingDirectory;
    this.#neutralInstructions = options.neutralInstructions;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#interruptWaitMs =
      options.interruptWaitMs ?? DEFAULT_INTERRUPT_WAIT_MS;
    this.#release = options.release;
    this.#cleanup = options.cleanup;
    this.#dispatcher = eventDispatcherFor(options.host);
  }

  async run(command: TurnCommand, signal?: AbortSignal): Promise<TurnResult> {
    for await (const event of this.stream(command, signal)) {
      if (event.type === "completed") return event.result;
      if (event.type === "failed") throw event.error;
    }
    throw new ProxyError(
      502,
      "codex_protocol_error",
      "Codex event stream ended before turn completion",
    );
  }

  async *stream(
    command: TurnCommand,
    signal?: AbortSignal,
  ): AsyncIterable<ProxyStreamEvent> {
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
      interruptPromise = this.#host
        .turnInterrupt({ threadId, turnId: knownTurnId })
        .then(() => {
          this.assertGeneration(generation);
          if (terminal) return;
          interruptWait = setTimeout(() => {
            subscription?.fail(cancellationError(cancellationCause ?? "abort"));
          }, this.#interruptWaitMs);
          interruptWait.unref?.();
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
      turnStartController.abort();
      resolveCancellation(cause);
      issueInterrupt();
    };
    const onAbort = (): void => requestCancellation("abort");
    let finalization: Promise<unknown | undefined> | undefined;
    const finalize = (): Promise<unknown | undefined> => {
      finalization ??= (async () => {
        const shouldInterrupt = !terminal;
        if (timeout) clearTimeout(timeout);
        if (interruptWait) clearTimeout(interruptWait);
        signal?.removeEventListener("abort", onAbort);

        if (shouldInterrupt) issueInterrupt();
        terminal = true;
        if (interruptPromise) {
          await Promise.race([
            interruptPromise.catch(() => undefined),
            delay(this.#interruptWaitMs),
          ]);
        }
        subscription?.close();

        const [release, cleanup] = await Promise.allSettled([
          Promise.resolve().then(() => this.#release?.()),
          Promise.resolve().then(() =>
            threadId === undefined ? undefined : this.#cleanup?.(threadId),
          ),
        ]);
        if (generationFailure) return generationFailure;
        if (release.status === "rejected") return release.reason;
        if (cleanup.status === "rejected") return cleanup.reason;
        return undefined;
      })();
      return finalization;
    };

    try {
      signal?.throwIfAborted();
      threadId = await this.openThread(command, generation, signal);
      signal?.throwIfAborted();

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
          signal,
        );
        this.assertGeneration(generation);
      }
      signal?.throwIfAborted();

      subscription = this.#dispatcher.register(threadId, generation);
      const subscriptionFailure = subscription.whenFailed();
      signal?.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(
        () => requestCancellation("timeout"),
        this.#timeoutMs,
      );
      timeout.unref?.();
      if (signal?.aborted) onAbort();

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

      let text = "";
      let usage: TokenUsage | undefined;
      for await (const event of subscription) {
        this.assertGeneration(generation);
        switch (event.method) {
          case "item/agentMessage/delta":
            yield { type: "text.delta", delta: event.params.delta };
            break;
          case "item/completed":
            if (event.params.item.type === "agentMessage") {
              text = event.params.item.text;
            }
            break;
          case "thread/tokenUsage/updated":
            usage = usageFrom(event);
            yield { type: "usage", usage };
            break;
          case "turn/completed": {
            terminal = true;
            text = completedText(event.params.turn, text);
            const error = cancellationCause
              ? cancellationError(cancellationCause)
              : completedTurnError(event.params.turn);
            const lifecycleError = await finalize();
            if (lifecycleError !== undefined) throw lifecycleError;
            if (error) {
              yield { type: "failed", error };
              return;
            }
            const result: TurnResult = {
              threadId,
              turnId,
              text,
              finishReason: "stop",
              ...(usage === undefined ? {} : { usage }),
            };
            yield { type: "completed", result };
            return;
          }
        }
      }
    } catch (error) {
      const lifecycleError = await finalize();
      if (lifecycleError !== undefined) throw lifecycleError;
      yield { type: "failed", error: normalizeError(error) };
    } finally {
      await finalize();
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
            cwd: this.#emptyWorkingDirectory,
            approvalPolicy: "never",
            sandbox: "read-only",
            baseInstructions: this.#neutralInstructions,
            developerInstructions: null,
            ephemeral: false,
            serviceName: "openai_oauth_proxy",
            environments: [],
            selectedCapabilityRoots: [],
          },
          signal,
        );
        this.assertGeneration(generation);
        return response.thread.id;
      }
      case "resume": {
        const response = await this.#host.threadResume(
          { threadId: command.action.threadId },
          signal,
        );
        this.assertGeneration(generation);
        return response.thread.id;
      }
      case "fork": {
        const response = await this.#host.threadFork(
          {
            threadId: command.action.threadId,
            lastTurnId: command.action.lastTurnId,
          },
          signal,
        );
        this.assertGeneration(generation);
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
