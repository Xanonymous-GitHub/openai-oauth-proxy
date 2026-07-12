import type { ResponseItem } from "../codex/generated/ResponseItem.js";
import type { JsonValue } from "../codex/generated/serde_json/JsonValue.js";
import type { UserInput } from "../codex/generated/v2/UserInput.js";
import type { CodexHost, HostNotification } from "../codex/host.js";
import { CodexGenerationChangedError } from "../codex/transport.js";
import type { ProxyError } from "../http/errors.js";

export type ThreadAction =
  | { type: "start" }
  | { type: "resume"; threadId: string }
  | { type: "fork"; threadId: string; lastTurnId: string };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TurnCommand {
  action: ThreadAction;
  cwd?: string;
  model: string;
  history: ResponseItem[];
  input: UserInput[];
  instructions?: string;
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  outputSchema?: JsonValue;
}

export interface TurnResult {
  threadId: string;
  turnId: string;
  text: string;
  finishReason: "stop";
  usage?: TokenUsage;
}

export type ProxyStreamEvent =
  | { type: "text.delta"; delta: string }
  | { type: "usage"; usage: TokenUsage }
  | { type: "completed"; result: TurnResult }
  | { type: "failed"; error: ProxyError };

type EventWaiter = {
  resolve(value: IteratorResult<HostNotification>): void;
  reject(error: unknown): void;
};

export class TurnEventSubscription implements AsyncIterable<HostNotification> {
  readonly #events: HostNotification[] = [];
  readonly #waiters: EventWaiter[] = [];
  readonly #bound: Promise<string>;
  readonly #failed: Promise<never>;
  #resolveBound!: (turnId: string) => void;
  #rejectFailed!: (error: unknown) => void;
  #failure: unknown;
  #closed = false;
  turnId?: string;

  constructor(
    readonly threadId: string,
    readonly generation: number,
    private readonly dispatcher: HostEventDispatcher,
  ) {
    this.#bound = new Promise((resolve) => {
      this.#resolveBound = resolve;
    });
    this.#failed = new Promise((_, reject) => {
      this.#rejectFailed = reject;
    });
    void this.#failed.catch(() => undefined);
  }

  bind(turnId: string): void {
    this.dispatcher.bind(this, turnId);
  }

  whenBound(): Promise<string> {
    return this.turnId === undefined
      ? this.#bound
      : Promise.resolve(this.turnId);
  }

  whenFailed(): Promise<never> {
    return this.#failed;
  }

  setTurnId(turnId: string): void {
    this.turnId = turnId;
    this.#resolveBound(turnId);
  }

  push(event: HostNotification): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: event });
    else this.#events.push(event);
  }

  fail(error: unknown): void {
    if (this.#closed || this.#failure !== undefined) return;
    this.#failure = error;
    this.#events.length = 0;
    this.#rejectFailed(error);
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.dispatcher.remove(this);
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<HostNotification> {
    return {
      next: async () => {
        const event = this.#events.shift();
        if (event) return { done: false, value: event };
        if (this.#failure !== undefined) throw this.#failure;
        if (this.#closed) return { done: true, value: undefined };
        return new Promise((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
      },
      return: async () => {
        this.close();
        return { done: true, value: undefined };
      },
    };
  }
}

function eventIdentity(
  event: HostNotification,
): { threadId: string; turnId: string } | undefined {
  switch (event.method) {
    case "item/agentMessage/delta":
    case "item/completed":
    case "thread/tokenUsage/updated":
      return {
        threadId: event.params.threadId,
        turnId: event.params.turnId,
      };
    case "turn/completed":
      return {
        threadId: event.params.threadId,
        turnId: event.params.turn.id,
      };
    default:
      return undefined;
  }
}

export class HostEventDispatcher {
  readonly #active = new Map<string, TurnEventSubscription>();
  readonly #pending = new Map<string, Set<TurnEventSubscription>>();
  readonly #host: CodexHost;
  #consuming = false;

  constructor(host: CodexHost) {
    this.#host = host;
  }

  register(threadId: string, generation: number): TurnEventSubscription {
    const subscription = new TurnEventSubscription(threadId, generation, this);
    const pending = this.#pending.get(threadId) ?? new Set();
    pending.add(subscription);
    this.#pending.set(threadId, pending);
    if (this.#host.generation !== generation) {
      subscription.fail(new CodexGenerationChangedError());
      return subscription;
    }
    this.ensureConsumer();
    return subscription;
  }

  bind(subscription: TurnEventSubscription, turnId: string): void {
    if (subscription.turnId !== undefined && subscription.turnId !== turnId) {
      throw new Error(
        `Turn notification ID ${subscription.turnId} did not match turn/start ID ${turnId}`,
      );
    }
    const key = this.key(subscription.threadId, turnId);
    const existing = this.#active.get(key);
    if (existing && existing !== subscription) {
      throw new Error(`Duplicate turn event registration for ${key}`);
    }
    subscription.setTurnId(turnId);
    this.removePending(subscription);
    this.#active.set(key, subscription);
  }

  remove(subscription: TurnEventSubscription): void {
    this.removePending(subscription);
    if (subscription.turnId !== undefined) {
      const key = this.key(subscription.threadId, subscription.turnId);
      if (this.#active.get(key) === subscription) this.#active.delete(key);
    }
  }

  private ensureConsumer(): void {
    if (this.#consuming) return;
    this.#consuming = true;
    void this.consume();
  }

  private async consume(): Promise<void> {
    let failure: unknown = new Error("Codex host event stream ended");
    try {
      for await (const event of this.#host.events()) this.dispatch(event);
    } catch (error) {
      failure = error;
    } finally {
      this.#consuming = false;
      const subscriptions = new Set([
        ...this.#active.values(),
        ...[...this.#pending.values()].flatMap((pending) => [...pending]),
      ]);
      for (const subscription of subscriptions) subscription.fail(failure);
    }
  }

  private dispatch(event: HostNotification): void {
    const identity = eventIdentity(event);
    if (!identity) return;

    const exact = this.#active.get(
      this.key(identity.threadId, identity.turnId),
    );
    if (exact) {
      if (event.generation !== exact.generation) {
        exact.fail(new CodexGenerationChangedError());
        return;
      }
      exact.push(event);
      return;
    }

    const pending = this.#pending.get(identity.threadId);
    if (pending?.size !== 1) return;
    const subscription = pending.values().next().value;
    if (!subscription) return;
    if (event.generation !== subscription.generation) {
      subscription.fail(new CodexGenerationChangedError());
      return;
    }
    this.bind(subscription, identity.turnId);
    subscription.push(event);
  }

  private removePending(subscription: TurnEventSubscription): void {
    const pending = this.#pending.get(subscription.threadId);
    pending?.delete(subscription);
    if (pending?.size === 0) this.#pending.delete(subscription.threadId);
  }

  private key(threadId: string, turnId: string): string {
    return `${threadId}\u0000${turnId}`;
  }
}

const hostDispatchers = new WeakMap<CodexHost, HostEventDispatcher>();

export function eventDispatcherFor(host: CodexHost): HostEventDispatcher {
  const existing = hostDispatchers.get(host);
  if (existing) return existing;
  const dispatcher = new HostEventDispatcher(host);
  hostDispatchers.set(host, dispatcher);
  return dispatcher;
}
