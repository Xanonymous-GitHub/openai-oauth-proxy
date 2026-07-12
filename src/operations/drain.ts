import { ProxyError } from "../http/errors.js";
import type { Permit } from "./capacity.js";

export interface AdmittedTurn {
  readonly signal: AbortSignal;
  release(): void;
  done(): void;
}

interface Entry {
  controller: AbortController;
  release(): void;
  done(): void;
}

function unavailable(): ProxyError {
  return new ProxyError(503, "service_unavailable", "Service unavailable");
}

export class TurnDrainRegistry {
  readonly #entries = new Set<Entry>();
  readonly #idleWaiters = new Set<() => void>();
  #draining = false;

  register(permit: Permit, requestSignal?: AbortSignal): AdmittedTurn {
    if (this.#draining) {
      permit.release();
      throw unavailable();
    }

    const controller = new AbortController();
    const signal = requestSignal
      ? AbortSignal.any([requestSignal, controller.signal])
      : controller.signal;
    let permitReleased = false;
    let finished = false;
    let entry: Entry;
    const release = (): void => {
      if (permitReleased) return;
      permitReleased = true;
      permit.release();
    };
    const done = (): void => {
      if (finished) return;
      finished = true;
      release();
      this.#entries.delete(entry);
      this.resolveIdle();
    };
    entry = { controller, release, done };
    this.#entries.add(entry);
    return { signal, release, done };
  }

  beginDrain(): void {
    this.#draining = true;
  }

  abortAll(): void {
    for (const entry of this.#entries) entry.controller.abort();
  }

  whenIdle(): Promise<void> {
    if (this.#entries.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.add(resolve));
  }

  private resolveIdle(): void {
    if (this.#entries.size !== 0) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }
}
