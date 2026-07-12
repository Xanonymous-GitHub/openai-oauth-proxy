import { ProxyError } from "../http/errors.js";

export interface Permit {
  readonly queueOutcome?: "admitted" | "queued";
  release(): void;
}

interface Waiter {
  signal: AbortSignal | undefined;
  resolve(permit: Permit): void;
  reject(error: ProxyError): void;
  onAbort(): void;
}

function unavailable(): ProxyError {
  return new ProxyError(503, "service_unavailable", "Service unavailable");
}

export class TurnCapacity {
  readonly #maxActive: number;
  readonly #queueCapacity: number;
  readonly #waiters: Waiter[] = [];
  readonly #idleWaiters = new Set<() => void>();
  readonly #permits = new Set<Permit>();
  #draining = false;

  constructor(maxActive = 4, queueCapacity = 32) {
    if (!Number.isSafeInteger(maxActive) || maxActive < 1) {
      throw new RangeError("maxActive must be a positive integer");
    }
    if (!Number.isSafeInteger(queueCapacity) || queueCapacity < 0) {
      throw new RangeError("queueCapacity must be a non-negative integer");
    }
    this.#maxActive = maxActive;
    this.#queueCapacity = queueCapacity;
  }

  get active(): number {
    return this.#permits.size;
  }

  get queued(): number {
    return this.#waiters.length;
  }

  get draining(): boolean {
    return this.#draining;
  }

  acquire(signal?: AbortSignal): Promise<Permit> {
    if (this.#draining) return Promise.reject(unavailable());
    if (signal?.aborted) {
      return Promise.reject(
        new ProxyError(499, "request_aborted", "Request aborted"),
      );
    }
    if (this.#permits.size < this.#maxActive) {
      return Promise.resolve(this.createPermit("admitted"));
    }
    if (this.#waiters.length >= this.#queueCapacity) {
      return Promise.reject(
        ProxyError.public(429, "queue_full", "Turn queue is full"),
      );
    }

    return new Promise<Permit>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.#waiters.indexOf(waiter);
          if (index < 0) return;
          this.#waiters.splice(index, 1);
          signal?.removeEventListener("abort", waiter.onAbort);
          reject(new ProxyError(499, "request_aborted", "Request aborted"));
        },
      };
      this.#waiters.push(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  beginDrain(): void {
    if (this.#draining) return;
    this.#draining = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.reject(unavailable());
    }
    this.resolveIdle();
  }

  whenIdle(): Promise<void> {
    if (this.#permits.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.add(resolve));
  }

  invalidateActive(): void {
    for (const permit of [...this.#permits]) permit.release();
  }

  private createPermit(queueOutcome: "admitted" | "queued"): Permit {
    let permit: Permit;
    permit = {
      queueOutcome,
      release: () => {
        if (!this.#permits.delete(permit)) return;
        this.admitNext();
        this.resolveIdle();
      },
    };
    this.#permits.add(permit);
    return permit;
  }

  private admitNext(): void {
    if (this.#draining || this.#permits.size >= this.#maxActive) return;
    const waiter = this.#waiters.shift();
    if (!waiter) return;
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    waiter.resolve(this.createPermit("queued"));
  }

  private resolveIdle(): void {
    if (this.#permits.size !== 0) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }
}
