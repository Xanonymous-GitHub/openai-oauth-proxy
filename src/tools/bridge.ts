import { createHash, randomBytes } from "node:crypto";
import type { ReasoningSummary } from "../codex/generated/ReasoningSummary.js";
import type { JsonValue } from "../codex/generated/serde_json/JsonValue.js";
import type { DynamicToolSpec } from "../codex/generated/v2/DynamicToolSpec.js";
import type { CodexHost, PendingServerToolCall } from "../codex/host.js";
import { ProxyError } from "../http/errors.js";
import type { JsonObject } from "../openai/types.js";
import type { ProxyStreamEvent, TurnResult } from "../turns/events.js";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const FAILED_TOOL_TEXT = "Tool execution failed";

type ChatFunctionTool = {
  type: "function";
  function: {
    name: string;
    description?: string | undefined;
    parameters: JsonObject;
  };
};

type ResponsesFunctionTool = {
  type: "function";
  name: string;
  description?: string | undefined;
  parameters: JsonObject;
  strict?: boolean | undefined;
};

export interface ExternalToolCall {
  id: string;
  name: string;
  arguments: JsonValue;
}

export interface ToolBridgeContext {
  kind: "chat" | "responses";
  responseId?: string;
  threadId: string;
  turnId: string;
  leaseOwner: string;
  generation: number;
  toolFingerprint: string;
  toolDefinitions: readonly DynamicToolSpec[];
  reasoningSummary?: ReasoningSummary;
  signal?: AbortSignal;
  finish?(): void;
  resume(signal?: AbortSignal): ResumedToolStage;
  invalidate(): void | Promise<void>;
}

export interface ResumedToolStage {
  result: Promise<TurnResult>;
  events: AsyncIterable<ProxyStreamEvent>;
}

export interface ToolResultInput {
  callId: string;
  output: string;
  success?: boolean;
}

export interface ToolContinuationRequest {
  kind: "chat" | "responses";
  responseId?: string;
  toolFingerprint: string;
  reasoningSummary?: ReasoningSummary | null;
  results: ToolResultInput[];
  signal?: AbortSignal;
}

export type ToolContinuation =
  | {
      type: "continued";
      responseId?: string;
      threadId: string;
      turnId: string;
      result: Promise<TurnResult>;
      events: AsyncIterable<ProxyStreamEvent>;
      signal?: AbortSignal;
      finish?(): void;
    }
  | { type: "incomplete"; missingCallIds: string[] }
  | { type: "lost" };

interface PendingCall {
  external: ExternalToolCall;
  server: PendingServerToolCall;
}

interface PendingTurn {
  context: ToolBridgeContext;
  expiresAt: number;
  calls: Map<string, PendingCall>;
  invalidated: boolean;
  invalidation: Promise<void> | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface ToolBridgeOptions {
  host: CodexHost;
  now?: () => number;
  timeoutMs?: number;
}

type ToolCallListener = (call: ExternalToolCall) => void;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson(
            (value as Record<string, unknown>)[key],
          )}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function externalGeneration(callId: string): number | undefined {
  const match = /^call_g(\d+)_/.exec(callId);
  if (!match) return undefined;
  const generation = Number(match[1]);
  return Number.isSafeInteger(generation) ? generation : undefined;
}

function invalidTool(message: string, param = "tools"): ProxyError {
  return ProxyError.public(400, "invalid_function_tool", message, param);
}

export class ToolBridge {
  readonly #host: CodexHost;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #turns = new Map<ToolBridgeContext, PendingTurn>();
  readonly #calls = new Map<string, PendingTurn>();
  readonly #responses = new Map<string, PendingTurn>();
  readonly #lostCalls = new Map<string, number>();
  readonly #lostResponses = new Map<string, number>();
  readonly #listeners = new Map<
    string,
    { context: ToolBridgeContext; listener: ToolCallListener }
  >();
  readonly #unclaimed = new Map<string, PendingServerToolCall[]>();
  #consuming = false;
  #expired = 0;

  constructor(options: ToolBridgeOptions) {
    this.#host = options.host;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get pending(): number {
    return this.#calls.size;
  }

  get expired(): number {
    return this.#expired;
  }

  toDynamicTools(
    tools: readonly (ChatFunctionTool | ResponsesFunctionTool)[],
  ): DynamicToolSpec[] {
    const names = new Set<string>();
    return tools.map((tool, index) => {
      const definition = "function" in tool ? tool.function : tool;
      const param =
        "function" in tool
          ? `tools.${index}.function.name`
          : `tools.${index}.name`;
      if (
        !TOOL_NAME.test(definition.name) ||
        definition.name === "mcp" ||
        definition.name.startsWith("mcp__")
      ) {
        throw invalidTool(
          `Invalid or reserved function name: ${definition.name}`,
          param,
        );
      }
      if (names.has(definition.name)) {
        throw invalidTool(`Duplicate function name: ${definition.name}`, param);
      }
      names.add(definition.name);
      if (
        definition.parameters === null ||
        Array.isArray(definition.parameters) ||
        typeof definition.parameters !== "object"
      ) {
        throw invalidTool(
          "Function parameters must be a JSON object",
          "function" in tool
            ? `tools.${index}.function.parameters`
            : `tools.${index}.parameters`,
        );
      }
      return {
        type: "function",
        name: definition.name,
        description: definition.description ?? "",
        inputSchema: definition.parameters,
      };
    });
  }

  fingerprint(tools: readonly DynamicToolSpec[]): string {
    return createHash("sha256").update(stableJson(tools)).digest("base64url");
  }

  fingerprintDefinitions(
    tools: readonly (ChatFunctionTool | ResponsesFunctionTool)[],
  ): string {
    return createHash("sha256").update(stableJson(tools)).digest("base64url");
  }

  configuration(
    tools: readonly (ChatFunctionTool | ResponsesFunctionTool)[],
    toolChoice: "auto" | "none",
  ): { canonical: string; fingerprint: string } {
    const effectiveTools = toolChoice === "none" ? [] : tools;
    const canonical = stableJson({ toolChoice, tools: effectiveTools });
    return {
      canonical,
      fingerprint: createHash("sha256").update(canonical).digest("base64url"),
    };
  }

  register(
    call: PendingServerToolCall,
    context: ToolBridgeContext,
  ): ExternalToolCall {
    if (
      call.generation !== context.generation ||
      call.params.threadId !== context.threadId ||
      call.params.turnId !== context.turnId ||
      call.params.namespace !== null ||
      !context.toolDefinitions.some(
        (definition) => definition.name === call.params.tool,
      )
    ) {
      call.reject(-32602, "Tool call did not match the active turn");
      throw new ProxyError(
        502,
        "codex_protocol_error",
        "Codex emitted an invalid dynamic tool call",
      );
    }
    let turn = this.#turns.get(context);
    if (!turn) {
      turn = {
        context,
        expiresAt: this.#now() + this.#timeoutMs,
        calls: new Map(),
        invalidated: false,
        invalidation: undefined,
        timer: undefined,
      };
      this.#turns.set(context, turn);
      if (context.responseId !== undefined) {
        this.#responses.set(context.responseId, turn);
      }
    }
    const external: ExternalToolCall = {
      id: `call_g${context.generation}_${randomBytes(24).toString("base64url")}`,
      name: call.params.tool,
      arguments: call.params.arguments,
    };
    turn.calls.set(external.id, { external, server: call });
    this.#calls.set(external.id, turn);
    this.scheduleExpiry(turn);
    return external;
  }

  attach(context: ToolBridgeContext, listener: ToolCallListener): void {
    const key = this.turnKey(context.threadId, context.turnId);
    if (this.#listeners.has(key)) {
      throw new Error(`Duplicate tool bridge registration for ${key}`);
    }
    this.#listeners.set(key, { context, listener });
    const buffered = this.#unclaimed.get(key);
    this.#unclaimed.delete(key);
    for (const call of buffered ?? []) listener(this.register(call, context));
    this.ensureConsumer();
  }

  detach(context: ToolBridgeContext): void {
    const key = this.turnKey(context.threadId, context.turnId);
    if (this.#listeners.get(key)?.context === context) {
      this.#listeners.delete(key);
    }
  }

  async continue(request: ToolContinuationRequest): Promise<ToolContinuation> {
    const duplicate = new Set<string>();
    for (const result of request.results) {
      if (duplicate.has(result.callId)) {
        throw ProxyError.public(
          400,
          "duplicate_tool_output",
          "Each tool call may have only one output",
          "input",
        );
      }
      duplicate.add(result.callId);
    }

    const turn = this.findTurn(request);
    if (!turn) {
      const oldGeneration = request.results.some((result) => {
        const generation = externalGeneration(result.callId);
        return generation !== undefined && generation !== this.#host.generation;
      });
      const knownLost =
        (request.responseId !== undefined &&
          this.#lostResponses.has(request.responseId)) ||
        request.results.some((result) => this.#lostCalls.has(result.callId));
      if (request.kind === "responses" || oldGeneration || knownLost) {
        return { type: "lost" };
      }
      throw ProxyError.public(
        400,
        "unknown_tool_call",
        "Tool call was not found",
        "messages",
      );
    }
    if (turn.context.generation !== this.#host.generation) {
      this.invalidate(turn);
      return { type: "lost" };
    }
    if (turn.context.toolFingerprint !== request.toolFingerprint) {
      throw ProxyError.public(
        400,
        "tool_definitions_changed",
        "Tool definitions must exactly match the suspended request",
        "tools",
      );
    }
    if (
      "reasoningSummary" in request &&
      request.reasoningSummary !== (turn.context.reasoningSummary ?? null)
    ) {
      throw ProxyError.public(
        400,
        "reasoning_summary_changed",
        "Reasoning summary must match the suspended request",
        "reasoning.summary",
      );
    }

    for (const result of request.results) {
      if (this.#calls.get(result.callId) !== turn) {
        throw ProxyError.public(
          400,
          "unknown_tool_call",
          "Tool call was not found",
          "input",
        );
      }
    }
    const submitted = new Set(request.results.map((result) => result.callId));
    const missingCallIds = [...turn.calls.keys()].filter(
      (callId) => !submitted.has(callId),
    );
    if (missingCallIds.length > 0) {
      return { type: "incomplete", missingCallIds };
    }
    if (submitted.size !== turn.calls.size) {
      throw ProxyError.public(
        400,
        "unknown_tool_call",
        "Tool output set did not match the pending calls",
        "input",
      );
    }

    const nextStage = turn.context.resume(request.signal);
    if (turn.timer) clearTimeout(turn.timer);
    turn.timer = undefined;
    try {
      for (const result of request.results) {
        const pending = turn.calls.get(result.callId);
        if (!pending) continue;
        pending.server.respond({
          success: result.success !== false,
          contentItems: [
            {
              type: "inputText",
              text: result.success === false ? FAILED_TOOL_TEXT : result.output,
            },
          ],
        });
        turn.calls.delete(result.callId);
        this.#calls.delete(result.callId);
      }
    } catch {
      this.invalidate(turn);
      return { type: "lost" };
    }
    return {
      type: "continued",
      ...(turn.context.responseId === undefined
        ? {}
        : { responseId: turn.context.responseId }),
      threadId: turn.context.threadId,
      turnId: turn.context.turnId,
      result: nextStage.result,
      events: nextStage.events,
      ...(turn.context.signal === undefined
        ? {}
        : { signal: turn.context.signal }),
      ...(turn.context.finish === undefined
        ? {}
        : { finish: turn.context.finish }),
    };
  }

  invalidateGeneration(generation: number): void {
    for (const turn of [...this.#turns.values()]) {
      if (turn.context.generation === generation) this.invalidate(turn);
    }
  }

  invalidateAll(): void {
    for (const turn of [...this.#turns.values()]) this.invalidate(turn);
    for (const calls of this.#unclaimed.values()) {
      for (const call of calls) {
        try {
          call.reject(-32000, "Tool continuation lost");
        } catch {
          // The host may already have invalidated the responder.
        }
      }
    }
    this.#unclaimed.clear();
  }

  invalidateResponse(responseId: string): Promise<void> {
    const turn = this.#responses.get(responseId);
    return turn ? this.invalidate(turn) : Promise.resolve();
  }

  invalidateCalls(callIds: readonly string[]): void {
    for (const callId of callIds) {
      const turn = this.#calls.get(callId);
      if (turn) {
        this.invalidate(turn);
        return;
      }
    }
  }

  expire(now = this.#now()): void {
    for (const [callId, expiresAt] of this.#lostCalls) {
      if (expiresAt <= now) this.#lostCalls.delete(callId);
    }
    for (const [responseId, expiresAt] of this.#lostResponses) {
      if (expiresAt <= now) this.#lostResponses.delete(responseId);
    }
    for (const turn of [...this.#turns.values()]) {
      if (turn.calls.size > 0 && turn.expiresAt <= now) {
        this.#expired += turn.calls.size;
        this.invalidate(turn);
      }
    }
  }

  complete(context: ToolBridgeContext): void {
    this.detach(context);
    const turn = this.#turns.get(context);
    if (turn) this.remove(turn);
  }

  private ensureConsumer(): void {
    if (this.#consuming) return;
    this.#consuming = true;
    void this.consume();
  }

  private async consume(): Promise<void> {
    const generation = this.#host.generation;
    try {
      for await (const call of this.#host.toolCalls()) {
        const key = this.turnKey(call.params.threadId, call.params.turnId);
        const registration = this.#listeners.get(key);
        if (registration) {
          registration.listener(this.register(call, registration.context));
        } else {
          const buffered = this.#unclaimed.get(key) ?? [];
          buffered.push(call);
          this.#unclaimed.set(key, buffered);
        }
      }
    } catch {
      // Generation invalidation below rejects every responder with stable semantics.
    } finally {
      this.#consuming = false;
      this.invalidateGeneration(generation);
      for (const calls of this.#unclaimed.values()) {
        for (const call of calls) {
          try {
            call.reject(-32000, "Tool continuation lost");
          } catch {
            // The host may already have invalidated the responder.
          }
        }
      }
      this.#unclaimed.clear();
    }
  }

  private findTurn(request: ToolContinuationRequest): PendingTurn | undefined {
    if (request.kind === "responses" && request.responseId !== undefined) {
      return this.#responses.get(request.responseId);
    }
    const turns = new Set(
      request.results
        .map((result) => this.#calls.get(result.callId))
        .filter((turn): turn is PendingTurn => turn !== undefined),
    );
    return turns.size === 1 ? turns.values().next().value : undefined;
  }

  private invalidate(turn: PendingTurn): Promise<void> {
    if (turn.invalidated) return turn.invalidation ?? Promise.resolve();
    turn.invalidated = true;
    const lostUntil = this.#now() + this.#timeoutMs;
    if (turn.context.responseId !== undefined) {
      this.#lostResponses.set(turn.context.responseId, lostUntil);
    }
    for (const [callId, call] of turn.calls) {
      this.#lostCalls.set(callId, lostUntil);
      try {
        call.server.reject(-32000, "Tool continuation lost");
      } catch {
        // A generation change may already have invalidated the responder.
      }
    }
    this.remove(turn);
    try {
      turn.invalidation = Promise.resolve(turn.context.invalidate()).catch(
        () => undefined,
      );
    } catch {
      turn.invalidation = Promise.resolve();
    }
    return turn.invalidation;
  }

  private remove(turn: PendingTurn): void {
    if (turn.timer) clearTimeout(turn.timer);
    this.#turns.delete(turn.context);
    if (turn.context.responseId !== undefined) {
      this.#responses.delete(turn.context.responseId);
    }
    for (const callId of turn.calls.keys()) this.#calls.delete(callId);
    turn.calls.clear();
  }

  private turnKey(threadId: string, turnId: string): string {
    return `${threadId}\u0000${turnId}`;
  }

  private scheduleExpiry(turn: PendingTurn): void {
    if (turn.timer) clearTimeout(turn.timer);
    turn.expiresAt = this.#now() + this.#timeoutMs;
    turn.timer = setTimeout(() => this.expire(this.#now()), this.#timeoutMs);
    turn.timer.unref?.();
  }
}

const hostBridges = new WeakMap<CodexHost, ToolBridge>();

export function toolBridgeFor(host: CodexHost, timeoutMs?: number): ToolBridge {
  const existing = hostBridges.get(host);
  if (existing) return existing;
  const bridge = new ToolBridge({
    host,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  hostBridges.set(host, bridge);
  return bridge;
}
