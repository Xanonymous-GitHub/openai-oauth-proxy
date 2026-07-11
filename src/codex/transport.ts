import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { InitializeParams } from "./generated/InitializeParams.js";
import type { InitializeResponse } from "./generated/InitializeResponse.js";
import type { RequestId } from "./generated/RequestId.js";
import type { ServerNotification } from "./generated/ServerNotification.js";
import type { DynamicToolCallParams } from "./generated/v2/DynamicToolCallParams.js";
import type { DynamicToolCallResponse } from "./generated/v2/DynamicToolCallResponse.js";
import type {
  CodexHost,
  HostNotification,
  PendingServerToolCall,
} from "./host.js";

const ALLOWED_CLIENT_METHODS = new Set([
  "initialize",
  "account/read",
  "account/login/start",
  "account/login/cancel",
  "account/logout",
  "model/list",
  "thread/start",
  "thread/resume",
  "thread/fork",
  "thread/inject_items",
  "thread/delete",
  "turn/start",
  "turn/interrupt",
]);

export function assertAllowedClientMethod(method: string): void {
  if (!ALLOWED_CLIENT_METHODS.has(method)) {
    throw new Error("Codex App Server method is not allowed");
  }
}

export class CodexProtocolError extends Error {
  constructor() {
    super("Codex App Server protocol failure");
    this.name = "CodexProtocolError";
  }
}

export class CodexGenerationChangedError extends Error {
  constructor() {
    super("Codex App Server generation changed");
    this.name = "CodexGenerationChangedError";
  }
}

interface TransportOptions {
  input: Readable;
  output: Writable;
  generation: number;
}

export interface CodexTransport {
  readonly host: CodexHost;
  initialize(
    params: InitializeParams,
    signal?: AbortSignal,
  ): Promise<InitializeResponse>;
  initialized(): void;
  invalidateGeneration(): void;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

interface ToolCallState {
  active: boolean;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<{
    resolve(result: IteratorResult<T>): void;
    reject(error: Error): void;
  }> = [];
  #error: Error | undefined;

  push(value: T): void {
    if (this.#error) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.#values.push(value);
  }

  fail(error: Error): void {
    if (this.#error) return;
    this.#error = error;
    this.#values.length = 0;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.#error) return Promise.reject(this.#error);
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
      },
    };
  }
}

class JsonlTransport implements CodexTransport {
  readonly host: CodexHost;
  readonly #output: Writable;
  readonly #generation: number;
  readonly #pending = new Map<RequestId, PendingRequest>();
  readonly #events = new AsyncQueue<HostNotification>();
  readonly #toolCalls = new AsyncQueue<PendingServerToolCall>();
  readonly #pendingTools = new Set<ToolCallState>();
  #nextId = 0;
  #invalidated = false;
  #failed = false;

  constructor({ input, output, generation }: TransportOptions) {
    this.#output = output;
    this.#generation = generation;
    const failProtocol = () => this.protocolFailure();
    input.on("error", failProtocol);
    input.once("close", failProtocol);
    output.on("error", failProtocol);
    this.host = {
      generation,
      accountRead: (refreshToken, signal) =>
        this.request(
          "account/read",
          { refreshToken },
          signal,
        ) as Promise<never>,
      loginStart: (params, signal) =>
        this.request("account/login/start", params, signal) as Promise<never>,
      loginCancel: (params, signal) =>
        this.request("account/login/cancel", params, signal) as Promise<never>,
      logout: (signal) =>
        this.request("account/logout", undefined, signal) as Promise<never>,
      modelList: (params, signal) =>
        this.request("model/list", params, signal) as Promise<never>,
      threadStart: (params, signal) =>
        this.request("thread/start", params, signal) as Promise<never>,
      threadResume: (params, signal) =>
        this.request("thread/resume", params, signal) as Promise<never>,
      threadFork: (params, signal) =>
        this.request("thread/fork", params, signal) as Promise<never>,
      threadInjectItems: (params, signal) =>
        this.request("thread/inject_items", params, signal) as Promise<never>,
      threadDelete: (params, signal) =>
        this.request("thread/delete", params, signal) as Promise<never>,
      turnStart: (params, signal) =>
        this.request("turn/start", params, signal) as Promise<never>,
      turnInterrupt: (params, signal) =>
        this.request("turn/interrupt", params, signal) as Promise<never>,
      events: () => this.#events,
      toolCalls: () => this.#toolCalls,
    };

    const lines = createInterface({
      input,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    void (async () => {
      try {
        for await (const line of lines) {
          if (this.#failed || this.#invalidated) break;
          this.handleLine(line);
        }
      } catch {
        this.protocolFailure();
      } finally {
        this.protocolFailure();
      }
    })();
  }

  initialize(
    params: InitializeParams,
    signal?: AbortSignal,
  ): Promise<InitializeResponse> {
    return this.request(
      "initialize",
      params,
      signal,
    ) as Promise<InitializeResponse>;
  }

  initialized(): void {
    this.write({ method: "initialized", params: {} });
  }

  invalidateGeneration(): void {
    if (this.#invalidated) return;
    this.#invalidated = true;
    const error = new CodexGenerationChangedError();
    this.rejectPending(error);
    for (const tool of this.#pendingTools) tool.active = false;
    this.#pendingTools.clear();
    this.#events.fail(error);
    this.#toolCalls.fail(error);
  }

  private async request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    assertAllowedClientMethod(method);
    if (this.#invalidated) throw new CodexGenerationChangedError();
    if (this.#failed) throw new CodexProtocolError();
    if (signal?.aborted)
      throw new DOMException("The operation was aborted", "AbortError");

    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = signal
        ? () => {
            const pending = this.#pending.get(id);
            if (!pending) return;
            this.#pending.delete(id);
            reject(new DOMException("The operation was aborted", "AbortError"));
          }
        : undefined;
      this.#pending.set(id, { resolve, reject, signal, onAbort });
      if (signal && onAbort)
        signal.addEventListener("abort", onAbort, { once: true });

      try {
        const message =
          params === undefined ? { id, method } : { id, method, params };
        this.write(message);
      } catch {
        this.#pending.delete(id);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        reject(new CodexProtocolError());
      }
    });
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.protocolFailure();
      return;
    }

    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.protocolFailure();
      return;
    }
    const record = message as Record<string, unknown>;
    const hasId =
      typeof record.id === "string" || typeof record.id === "number";
    const hasMethod = typeof record.method === "string";
    const hasResult = Object.hasOwn(record, "result");
    const hasError = Object.hasOwn(record, "error");

    if (hasId && !hasMethod && hasResult !== hasError) {
      this.handleResponse(record.id as RequestId, record);
      return;
    }
    if (hasId && hasMethod) {
      this.handleServerRequest(
        record.id as RequestId,
        record.method as string,
        record.params,
      );
      return;
    }
    if (!hasId && hasMethod) {
      this.#events.push({
        ...(record as unknown as ServerNotification),
        generation: this.#generation,
      });
      return;
    }
    this.protocolFailure();
  }

  private handleResponse(
    id: RequestId,
    message: Record<string, unknown>,
  ): void {
    const pending = this.#pending.get(id);
    if (!pending) {
      this.protocolFailure();
      return;
    }
    this.#pending.delete(id);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    if (Object.hasOwn(message, "error"))
      pending.reject(new CodexProtocolError());
    else pending.resolve(message.result);
  }

  private handleServerRequest(
    id: RequestId,
    method: string,
    params: unknown,
  ): void {
    if (method !== "item/tool/call") {
      this.write({ id, error: { code: -32601, message: "Method not found" } });
      return;
    }

    const state: ToolCallState = { active: true };
    this.#pendingTools.add(state);
    const settle = (message: Record<string, unknown>) => {
      if (!state.active) throw new CodexGenerationChangedError();
      state.active = false;
      this.#pendingTools.delete(state);
      this.write({ id, ...message });
    };
    this.#toolCalls.push({
      generation: this.#generation,
      id,
      params: params as DynamicToolCallParams,
      respond: (result: DynamicToolCallResponse) => settle({ result }),
      reject: (code: number, message: string) =>
        settle({ error: { code, message } }),
    });
  }

  private write(message: unknown): void {
    if (this.#invalidated) throw new CodexGenerationChangedError();
    if (this.#failed) throw new CodexProtocolError();
    this.#output.write(`${JSON.stringify(message)}\n`);
  }

  private protocolFailure(): void {
    if (this.#failed || this.#invalidated) return;
    this.#failed = true;
    const error = new CodexProtocolError();
    this.rejectPending(error);
    for (const tool of this.#pendingTools) tool.active = false;
    this.#pendingTools.clear();
    this.#events.fail(error);
    this.#toolCalls.fail(error);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener("abort", pending.onAbort);
      }
      pending.reject(error);
    }
  }
}

export function createJsonlTransport(
  options: TransportOptions,
): CodexTransport {
  return new JsonlTransport(options);
}
