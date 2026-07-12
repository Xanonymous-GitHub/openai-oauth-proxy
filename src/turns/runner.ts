import type { ResponseItem } from "../codex/generated/ResponseItem.js";
import type { JsonValue } from "../codex/generated/serde_json/JsonValue.js";
import type { Turn } from "../codex/generated/v2/Turn.js";
import type { CodexHost, HostNotification } from "../codex/host.js";
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
const neverAbortSignal = new AbortController().signal;

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
  if (error instanceof DOMException && error.name === "AbortError") {
    return cancellationError("abort");
  }
  return new ProxyError(502, "codex_host_error", "Codex host request failed");
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
    let threadId: string | undefined;
    let turnId: string | undefined;
    let subscription: TurnEventSubscription | undefined;
    let terminal = false;
    let cancellationCause: CancellationCause | undefined;
    let interruptPromise: Promise<void> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let interruptWait: ReturnType<typeof setTimeout> | undefined;

    const requestInterrupt = (cause: CancellationCause): void => {
      if (
        terminal ||
        cancellationCause ||
        !threadId ||
        !turnId ||
        !subscription
      ) {
        return;
      }
      cancellationCause = cause;
      interruptPromise = this.#host
        .turnInterrupt({ threadId, turnId })
        .then(() => {
          if (terminal) return;
          interruptWait = setTimeout(() => {
            subscription?.fail(cancellationError(cause));
          }, this.#interruptWaitMs);
          interruptWait.unref?.();
        })
        .catch((error: unknown) => {
          subscription?.fail(error);
        });
    };
    const onAbort = (): void => requestInterrupt("abort");

    try {
      signal?.throwIfAborted();
      threadId = await this.openThread(command, signal ?? neverAbortSignal);
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
        await this.#host.threadInjectItems(
          { threadId, items: items as unknown as JsonValue[] },
          signal ?? neverAbortSignal,
        );
      }
      signal?.throwIfAborted();

      subscription = this.#dispatcher.register(threadId);
      const started = await this.#host.turnStart(
        {
          threadId,
          input: command.input,
          model: command.model,
          ...(command.effort === undefined ? {} : { effort: command.effort }),
          ...(command.outputSchema === undefined
            ? {}
            : { outputSchema: command.outputSchema }),
        },
        neverAbortSignal,
      );
      turnId = started.turn.id;
      subscription.bind(turnId);

      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      timeout = setTimeout(() => requestInterrupt("timeout"), this.#timeoutMs);
      timeout.unref?.();

      let text = "";
      let usage: TokenUsage | undefined;
      for await (const event of subscription) {
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
      yield { type: "failed", error: normalizeError(error) };
    } finally {
      const shouldInterrupt = !terminal;
      terminal = true;
      if (timeout) clearTimeout(timeout);
      if (interruptWait) clearTimeout(interruptWait);
      signal?.removeEventListener("abort", onAbort);

      if (
        shouldInterrupt &&
        threadId &&
        turnId &&
        !interruptPromise &&
        subscription
      ) {
        interruptPromise = this.#host
          .turnInterrupt({ threadId, turnId })
          .then(() => undefined);
      }
      await interruptPromise?.catch(() => undefined);
      subscription?.close();

      const callbacks: Array<void | Promise<void>> = [];
      if (this.#release) callbacks.push(this.#release());
      if (this.#cleanup && threadId) callbacks.push(this.#cleanup(threadId));
      await Promise.all(callbacks);
    }
  }

  private async openThread(
    command: TurnCommand,
    signal: AbortSignal,
  ): Promise<string> {
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
          },
          signal,
        );
        return response.thread.id;
      }
    }
  }
}
