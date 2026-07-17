import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Handler } from "hono";
import { streamSSE } from "hono/streaming";
import type { Thread } from "../codex/generated/v2/Thread.js";
import type { CodexHost } from "../codex/host.js";
import type {
  ConversationClock,
  ConversationStore,
  OperationDecision,
} from "../conversations/store.js";
import { openAIErrorBody, ProxyError } from "../http/errors.js";
import { readJsonBody } from "../http/limits.js";
import { writeSSEWithSignal } from "../http/sse.js";
import type { Permit, TurnCapacity } from "../operations/capacity.js";
import type { AdmittedTurn, TurnDrainRegistry } from "../operations/drain.js";
import type { ObserveRequest } from "../operations/telemetry.js";
import type {
  ProxyStreamEvent,
  ReasoningSummaryItem,
  TokenUsage,
  TurnCommand,
  TurnResult,
} from "../turns/events.js";
import type { TurnLifecycleCallbacks, TurnRunner } from "../turns/runner.js";
import { decodeImages } from "./images.js";
import type { ModelCapabilities, ModelCatalog } from "./models.js";
import {
  parseResponsesRequest,
  type ResponsesInputItem,
  type ResponsesRequest,
} from "./schemas.js";
import { translateHistory, translateTurnInput } from "./translate.js";

type ModelLookup = Pick<ModelCatalog, "lookup">;
const SWEEP_INTERVAL_MS = 60 * 60 * 1_000;
const SWEEP_RPC_TIMEOUT_MS = 30_000;

export interface ResponseSweepDependencies {
  store: ConversationStore;
  deleteThread(threadId: string, signal?: AbortSignal): void | Promise<void>;
  host?: Pick<CodexHost, "threadList" | "threadDelete">;
}

export interface ResponseSweepTimers {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(timer: unknown): void;
}

export interface RunningResponseSweeper {
  startup: Promise<void>;
  stop(): Promise<void>;
}

export interface ResponsesHandlerDependencies {
  models: ModelLookup;
  runner: TurnRunner;
  store: ConversationStore;
  clock: ConversationClock;
  processGeneration(): number;
  operationWorkingDirectory: string;
  deleteThread(threadId: string, signal?: AbortSignal): void | Promise<void>;
  streamSSE?: typeof streamSSE;
  capacity?: Pick<TurnCapacity, "acquire">;
  drain?: Pick<TurnDrainRegistry, "register">;
  observe?: ObserveRequest;
}

export interface ProxyResponse {
  id: string;
  object: "response";
  created_at: number;
  status: "completed";
  model: string;
  output: Array<
    | {
        id: string;
        type: "message";
        status: "in_progress" | "completed";
        role: "assistant";
        content: Array<{ type: "output_text"; text: string; annotations: [] }>;
      }
    | {
        id: string;
        type: "function_call";
        status: "completed";
        call_id: string;
        name: string;
        arguments: string;
      }
    | {
        id: string;
        type: "reasoning";
        status: "in_progress" | "completed";
        summary: Array<{ type: "summary_text"; text: string }>;
      }
  >;
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
}

interface ResponseRecoveryDependencies {
  store: ConversationStore;
  host: Pick<CodexHost, "threadList" | "threadDelete">;
}

function removeOperationDirectory(cwd: string | undefined): void {
  if (cwd !== undefined) rmSync(cwd, { recursive: true, force: true });
}

async function loseResponseOperation(
  deps: Pick<ResponsesHandlerDependencies, "store" | "deleteThread">,
  responseId: string,
  signal?: AbortSignal,
): Promise<void> {
  const operationCwd = deps.store.lookupOperation(responseId)?.operationCwd;
  const cleanupThreadId = deps.store.loseOperation(responseId);
  try {
    if (cleanupThreadId !== undefined) {
      await deps.deleteThread(cleanupThreadId, signal);
      deps.store.finishAbandonedThread(cleanupThreadId);
    }
  } finally {
    removeOperationDirectory(operationCwd);
  }
}

async function threadsForOperation(
  host: Pick<CodexHost, "threadList">,
  cwd: string,
  signal: AbortSignal,
): Promise<Thread[]> {
  const matches = new Map<string, Thread>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const response = await abortable(
      host.threadList(
        {
          cwd,
          sourceKinds: ["appServer"],
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal,
      ),
      signal,
    );
    for (const thread of response.data) {
      if (thread.cwd === cwd) matches.set(thread.id, thread);
    }
    if (matches.size > 1 || response.nextCursor === null) break;
    if (cursors.has(response.nextCursor)) break;
    cursors.add(response.nextCursor);
    cursor = response.nextCursor;
  } while (cursor !== undefined);
  return [...matches.values()];
}

export async function recoverResponseOperations(
  deps: ResponseRecoveryDependencies,
  signal = AbortSignal.timeout(SWEEP_RPC_TIMEOUT_MS),
): Promise<void> {
  for (const operation of deps.store.recoveryOperations()) {
    if (operation.action === "resume") {
      deps.store.abandonOperation(operation.responseId);
      continue;
    }
    if (operation.threadId === undefined) {
      if (operation.operationCwd === undefined) continue;
      const matches = await threadsForOperation(
        deps.host,
        operation.operationCwd,
        signal,
      );
      if (matches.length !== 1) continue;
      const thread = matches[0];
      if (thread === undefined) continue;
      deps.store.attachOperation(operation.responseId, thread.id);
    }
    deps.store.abandonOperation(operation.responseId);
  }

  for (const operation of deps.store.abandonedOperations()) {
    if (operation.threadId === undefined) continue;
    await abortable(
      deps.host.threadDelete({ threadId: operation.threadId }, signal),
      signal,
    );
    deps.store.finishAbandonedOperation(operation.responseId);
    removeOperationDirectory(operation.operationCwd);
  }
}

interface ResponseIdentity {
  responseId: string;
  messageId: string;
  createdAt: number;
  model: string;
}

export async function sweepExpiredResponses(
  deps: ResponseSweepDependencies,
  signal = AbortSignal.timeout(SWEEP_RPC_TIMEOUT_MS),
): Promise<void> {
  if (deps.host !== undefined) {
    await recoverResponseOperations(
      { store: deps.store, host: deps.host },
      signal,
    );
  }
  for (const threadId of deps.store.abandonedThreads()) {
    try {
      await abortable(
        Promise.resolve(deps.deleteThread(threadId, signal)),
        signal,
      );
    } catch {
      return;
    }
    deps.store.finishAbandonedThread(threadId);
  }
  deps.store.expire();
  for (const threadId of deps.store.deletableLeafThreads()) {
    try {
      await abortable(
        Promise.resolve(deps.deleteThread(threadId, signal)),
        signal,
      );
    } catch {
      // An ancestor delete is recursive, so stop until this leaf succeeds.
      return;
    }
    deps.store.removeThread(threadId);
  }
}

export function startResponseSweeper(
  deps: ResponseSweepDependencies & { timers?: ResponseSweepTimers },
): RunningResponseSweeper {
  const timers = deps.timers ?? {
    setInterval: (callback: () => void, milliseconds: number) =>
      setInterval(callback, milliseconds),
    clearInterval: (timer: unknown) =>
      clearInterval(timer as ReturnType<typeof setInterval>),
  };
  let stopped = false;
  let inFlight = Promise.resolve();
  const controller = new AbortController();
  const enqueue = (): Promise<void> => {
    if (stopped) return inFlight;
    inFlight = inFlight
      .catch(() => undefined)
      .then(() =>
        sweepExpiredResponses(
          deps,
          AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(SWEEP_RPC_TIMEOUT_MS),
          ]),
        ),
      );
    return inFlight;
  };
  const startup = enqueue();
  const timer = timers.setInterval(() => {
    void enqueue().catch(() => undefined);
  }, SWEEP_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();

  return {
    startup,
    async stop() {
      if (!stopped) {
        stopped = true;
        timers.clearInterval(timer);
        controller.abort();
      }
      await inFlight.catch(() => undefined);
    },
  };
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function opaqueId(prefix: "resp" | "msg"): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

function reasoningId(itemId: string): string {
  return `rs_${itemId}`;
}

function reasoningResponseItem(
  item: ReasoningSummaryItem,
  status: "in_progress" | "completed",
): Extract<ProxyResponse["output"][number], { type: "reasoning" }> {
  return {
    id: reasoningId(item.id),
    type: "reasoning",
    status,
    summary: item.summary.map((text) => ({ type: "summary_text", text })),
  };
}

function messageResponseItem(
  identity: ResponseIdentity,
  text: string,
  status: "in_progress" | "completed",
): Extract<ProxyResponse["output"][number], { type: "message" }> {
  return {
    id: identity.messageId,
    type: "message",
    status,
    role: "assistant",
    content:
      status === "in_progress"
        ? []
        : [{ type: "output_text", text, annotations: [] }],
  };
}

interface OutputStreamState {
  nextOutputIndex: number;
  messageOutputIndex?: number;
  reasoning: Map<string, { outputIndex: number; parts: Set<number> }>;
}

interface ProjectedStreamEvent {
  type: string;
  [key: string]: unknown;
}

function createOutputStreamState(): OutputStreamState {
  return { nextOutputIndex: 0, reasoning: new Map() };
}

function messageOutputIndex(state: OutputStreamState): number {
  state.messageOutputIndex ??= state.nextOutputIndex++;
  return state.messageOutputIndex;
}

function messageStartEvents(
  identity: ResponseIdentity,
  state: OutputStreamState,
): ProjectedStreamEvent[] {
  if (state.messageOutputIndex !== undefined) return [];
  const outputIndex = messageOutputIndex(state);
  return [
    {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: messageResponseItem(identity, "", "in_progress"),
    },
    {
      type: "response.content_part.added",
      item_id: identity.messageId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [], logprobs: [] },
    },
  ];
}

function messageDoneEvents(
  identity: ResponseIdentity,
  text: string,
  state: OutputStreamState,
): ProjectedStreamEvent[] {
  const outputIndex = messageOutputIndex(state);
  return [
    {
      type: "response.content_part.done",
      item_id: identity.messageId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text, annotations: [], logprobs: [] },
    },
    {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: messageResponseItem(identity, text, "completed"),
    },
  ];
}

function messageCompletionEvents(
  identity: ResponseIdentity,
  text: string,
  state: OutputStreamState,
): ProjectedStreamEvent[] {
  const outputIndex = messageOutputIndex(state);
  return [
    {
      type: "response.output_text.done",
      item_id: identity.messageId,
      output_index: outputIndex,
      content_index: 0,
      text,
      logprobs: [],
    },
    ...messageDoneEvents(identity, text, state),
  ];
}

async function writeProjectedStreamEvents(
  writeSSE: (event: { event?: string; data: string }) => Promise<void>,
  events: ProjectedStreamEvent[],
  sequenceNumber: number,
): Promise<number> {
  let nextSequenceNumber = sequenceNumber;
  for (const event of events) {
    await writeSSE({
      event: event.type,
      data: JSON.stringify({
        ...event,
        sequence_number: nextSequenceNumber,
      }),
    });
    nextSequenceNumber += 1;
  }
  return nextSequenceNumber;
}

function reasoningStreamEvents(
  event: ProxyStreamEvent,
  state: OutputStreamState,
): ProjectedStreamEvent[] {
  if (
    event.type !== "reasoning.summary_part.added" &&
    event.type !== "reasoning.summary_text.delta" &&
    event.type !== "reasoning.completed"
  ) {
    return [];
  }
  const itemId = reasoningId(
    event.type === "reasoning.completed" ? event.item.id : event.itemId,
  );
  let itemState = state.reasoning.get(itemId);
  const projected: ProjectedStreamEvent[] = [];
  if (itemState === undefined) {
    itemState = { outputIndex: state.nextOutputIndex++, parts: new Set() };
    state.reasoning.set(itemId, itemState);
    projected.push({
      type: "response.output_item.added",
      output_index: itemState.outputIndex,
      item: {
        id: itemId,
        type: "reasoning",
        status: "in_progress",
        summary: [],
      },
    });
  }

  const addPart = (summaryIndex: number): void => {
    if (itemState.parts.has(summaryIndex)) return;
    itemState.parts.add(summaryIndex);
    projected.push({
      type: "response.reasoning_summary_part.added",
      item_id: itemId,
      output_index: itemState.outputIndex,
      summary_index: summaryIndex,
      part: { type: "summary_text", text: "" },
    });
  };

  if (event.type === "reasoning.summary_part.added") {
    addPart(event.summaryIndex);
  } else if (event.type === "reasoning.summary_text.delta") {
    addPart(event.summaryIndex);
    projected.push({
      type: "response.reasoning_summary_text.delta",
      item_id: itemId,
      output_index: itemState.outputIndex,
      summary_index: event.summaryIndex,
      delta: event.delta,
    });
  } else if (event.type === "reasoning.completed") {
    for (const [summaryIndex, text] of event.item.summary.entries()) {
      addPart(summaryIndex);
      projected.push(
        {
          type: "response.reasoning_summary_text.done",
          item_id: itemId,
          output_index: itemState.outputIndex,
          summary_index: summaryIndex,
          text,
        },
        {
          type: "response.reasoning_summary_part.done",
          item_id: itemId,
          output_index: itemState.outputIndex,
          summary_index: summaryIndex,
          part: { type: "summary_text", text },
        },
      );
    }
    projected.push({
      type: "response.output_item.done",
      output_index: itemState.outputIndex,
      item: reasoningResponseItem(event.item, "completed"),
    });
  }
  return projected;
}

async function requestBody(request: Request): Promise<unknown> {
  try {
    return await readJsonBody(request);
  } catch (error) {
    if (error instanceof ProxyError) throw error;
    throw ProxyError.public(
      400,
      "invalid_json",
      "Request body must be valid JSON",
    );
  }
}

function assertOrdinaryRequest(request: ResponsesRequest): void {
  if (Array.isArray(request.input)) {
    for (const [index, item] of request.input.entries()) {
      if (!("role" in item)) {
        throw ProxyError.public(
          400,
          "unknown_tool_call",
          "Function call input did not match a pending response",
          `input.${index}`,
        );
      }
    }
  }
}

function functionOutputs(request: ResponsesRequest) {
  if (!Array.isArray(request.input)) return [];
  return request.input
    .filter(
      (
        item,
      ): item is Extract<
        ResponsesInputItem,
        { type: "function_call_output" }
      > => "type" in item && item.type === "function_call_output",
    )
    .map((item) => ({ callId: item.call_id, output: item.output }));
}

function splitInput(request: ResponsesRequest): {
  history: ResponsesInputItem[];
  input: Parameters<typeof translateTurnInput>[0];
} {
  if (typeof request.input === "string") {
    return { history: [], input: request.input };
  }
  const last = request.input.at(-1);
  if (!last || !("role" in last) || last.role !== "user") {
    throw ProxyError.public(
      400,
      "invalid_response_input",
      "Ordinary Responses input must end with a user message",
      "input",
    );
  }
  return { history: request.input.slice(0, -1), input: last.content };
}

function imageParts(request: ResponsesRequest) {
  if (typeof request.input === "string") return [];
  return request.input.flatMap((item) => {
    if (
      !("role" in item) ||
      item.role !== "user" ||
      typeof item.content === "string"
    ) {
      return [];
    }
    return item.content.filter((part) => part.type === "input_image");
  });
}

async function validatedModel(
  deps: ResponsesHandlerDependencies,
  request: ResponsesRequest,
  signal: AbortSignal,
): Promise<ModelCapabilities> {
  const images = imageParts(request);
  decodeImages(images);
  let model: ModelCapabilities | undefined;
  try {
    model = await deps.models.lookup(request.model, signal);
  } catch {
    throw new ProxyError(
      503,
      "codex_unavailable",
      "Codex model catalog unavailable",
    );
  }
  if (!model) {
    throw ProxyError.public(
      404,
      "model_not_found",
      `Model not found: ${request.model}`,
      "model",
    );
  }
  if (images.length > 0 && !model.supportsImage) {
    throw ProxyError.public(
      400,
      "unsupported_image_model",
      `Model ${request.model} does not support image input`,
      "model",
    );
  }
  const effort = request.reasoning?.effort;
  if (
    effort !== undefined &&
    !model.supportedReasoningEfforts.includes(effort)
  ) {
    throw ProxyError.public(
      400,
      "unsupported_reasoning_effort",
      `Model ${request.model} does not support reasoning effort ${effort}`,
      "reasoning.effort",
    );
  }
  return model;
}

function responseBody(
  identity: ResponseIdentity,
  result: TurnResult,
): ProxyResponse {
  const reasoning = new Map(
    (result.reasoning ?? []).map((item) => [
      item.id,
      reasoningResponseItem(item, "completed"),
    ]),
  );
  const output: ProxyResponse["output"] = [];
  const projectedReasoning = new Set<string>();
  let projectedMessage = false;
  for (const item of result.outputOrder ?? []) {
    if (item.type === "reasoning") {
      const projected = reasoning.get(item.id);
      if (projected !== undefined) {
        output.push(projected);
        projectedReasoning.add(item.id);
      }
    } else if (
      !projectedMessage &&
      (result.finishReason === "stop" || result.text !== "")
    ) {
      output.push(messageResponseItem(identity, result.text, "completed"));
      projectedMessage = true;
    }
  }
  for (const [id, item] of reasoning) {
    if (!projectedReasoning.has(id)) output.push(item);
  }
  if (result.finishReason === "tool_calls") {
    if (!projectedMessage && result.text !== "") {
      output.push(messageResponseItem(identity, result.text, "completed"));
    }
    output.push(
      ...(result.toolCalls ?? []).map((call) => ({
        id: `fc_${call.id.slice("call_".length)}`,
        type: "function_call" as const,
        status: "completed" as const,
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      })),
    );
    return {
      id: identity.responseId,
      object: "response",
      created_at: identity.createdAt,
      status: "completed",
      model: identity.model,
      output,
      ...(result.usage === undefined ? {} : { usage: usageBody(result.usage) }),
    };
  }
  if (!projectedMessage) {
    output.push(messageResponseItem(identity, result.text, "completed"));
  }
  return {
    id: identity.responseId,
    object: "response",
    created_at: identity.createdAt,
    status: "completed",
    model: identity.model,
    output,
    ...(result.usage === undefined ? {} : { usage: usageBody(result.usage) }),
  };
}

function usageBody(usage: TokenUsage): NonNullable<ProxyResponse["usage"]> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
  };
}

function decisionError(type: "busy" | "not_found" | "lost"): ProxyError {
  if (type === "not_found") {
    return ProxyError.public(
      404,
      "response_not_found",
      "Previous response was not found",
      "previous_response_id",
    );
  }
  if (type === "lost") {
    return ProxyError.public(
      409,
      "proxy_continuation_lost",
      "Response continuation was lost after a proxy restart",
      "previous_response_id",
    );
  }
  return ProxyError.public(
    409,
    "thread_busy",
    "Response thread already has an active continuation",
    "previous_response_id",
  );
}

export function createResponsesHandler(
  deps: ResponsesHandlerDependencies,
): Handler {
  return async (context) => {
    const request = parseResponsesRequest(await requestBody(context.req.raw));
    const validatedTools = deps.runner.tools.toDynamicTools(
      request.tools ?? [],
    );
    const dynamicTools = request.tool_choice === "none" ? [] : validatedTools;
    const toolConfiguration = deps.runner.tools.configuration(
      request.tools ?? [],
      request.tool_choice ?? "auto",
    );
    const toolFingerprint = toolConfiguration.fingerprint;
    const outputs = functionOutputs(request);
    if (outputs.length > 0) {
      const statelessContinuation =
        request.previous_response_id === undefined && request.store === false;
      if (
        !Array.isArray(request.input) ||
        (request.previous_response_id === undefined &&
          !statelessContinuation) ||
        (request.previous_response_id !== undefined &&
          request.input.length !== outputs.length)
      ) {
        throw ProxyError.public(
          400,
          "invalid_tool_continuation",
          "Function outputs require one pending previous response",
          "input",
        );
      }
      const model = await validatedModel(deps, request, context.req.raw.signal);
      deps.observe?.(context.req.raw, { model: model.id });
      if (request.previous_response_id !== undefined) {
        const mapping = deps.store.lookup(request.previous_response_id);
        if (!mapping) throw decisionError("not_found");
        if (mapping.state === "lost") throw decisionError("lost");
        if (mapping.state !== "pending") {
          throw ProxyError.public(
            400,
            "unknown_tool_call",
            "Response has no pending function calls",
            "previous_response_id",
          );
        }
      }
      deps.observe?.(context.req.raw, { leaseOutcome: "acquired" });
      const continuation = await deps.runner.tools.continue({
        kind: "responses",
        ...(request.previous_response_id === undefined
          ? {}
          : { responseId: request.previous_response_id }),
        toolFingerprint,
        ...(request.reasoning !== undefined && "summary" in request.reasoning
          ? { reasoningSummary: request.reasoning.summary ?? null }
          : {}),
        results: outputs,
        signal: context.req.raw.signal,
      });
      if (continuation.type === "lost") throw decisionError("lost");
      if (continuation.type === "incomplete") {
        throw ProxyError.public(
          400,
          "incomplete_tool_outputs",
          `Missing tool outputs: ${continuation.missingCallIds.join(", ")}`,
          "input",
        );
      }
      if (continuation.responseId === undefined) throw decisionError("lost");
      const pendingOperation = deps.store.lookupOperation(
        continuation.responseId,
      );
      if (pendingOperation?.state !== "active") {
        throw decisionError("lost");
      }
      const cleanupSignal = continuation.signal
        ? AbortSignal.any([context.req.raw.signal, continuation.signal])
        : context.req.raw.signal;
      let continuationFinished = false;
      const finishContinuation = (): void => {
        if (continuationFinished) return;
        continuationFinished = true;
        continuation.finish?.();
      };
      let leaseReleased = false;
      const observeLeaseReleased = (): void => {
        if (leaseReleased) return;
        leaseReleased = true;
        deps.observe?.(context.req.raw, { leaseOutcome: "released" });
      };
      let durablyCommitted = false;
      const identity: ResponseIdentity = {
        responseId: continuation.responseId,
        messageId: opaqueId("msg"),
        createdAt: Math.floor(deps.clock.now() / 1_000),
        model: model.id,
      };
      const completeContinuation = async (
        result: TurnResult,
      ): Promise<void> => {
        if (result.finishReason !== "stop") return;
        try {
          if (!pendingOperation.stored) {
            await deps.deleteThread(result.threadId, cleanupSignal);
          }
          const operationCwd = deps.store.completeOperation(
            identity.responseId,
          );
          durablyCommitted = true;
          removeOperationDirectory(operationCwd);
          observeLeaseReleased();
        } catch (error) {
          try {
            await loseResponseOperation(
              deps,
              identity.responseId,
              cleanupSignal,
            );
            observeLeaseReleased();
          } finally {
            finishContinuation();
          }
          throw error;
        }
      };
      if (!request.stream) {
        let result: TurnResult;
        try {
          result = await continuation.result;
        } catch (error) {
          try {
            await loseResponseOperation(
              deps,
              identity.responseId,
              cleanupSignal,
            );
            observeLeaseReleased();
          } finally {
            finishContinuation();
          }
          throw error;
        }
        await completeContinuation(result);
        try {
          return context.json(responseBody(identity, result));
        } finally {
          if (result.finishReason === "stop") finishContinuation();
        }
      }
      const sendStream = deps.streamSSE ?? streamSSE;
      const streamCleanup = Promise.withResolvers<void>();
      deps.observe?.(context.req.raw, { streamCleanup: streamCleanup.promise });
      let ownerSettlement: Promise<void> | undefined;
      const settleOwnedContinuation = (): Promise<void> => {
        if (ownerSettlement) return ownerSettlement;
        ownerSettlement = (async () => {
          try {
            void deps.runner.tools
              .invalidateResponse(identity.responseId)
              .catch(() => undefined);
          } catch {
            // The durable operation below remains the cleanup authority.
          }
          try {
            if (!durablyCommitted) {
              await loseResponseOperation(
                deps,
                identity.responseId,
                cleanupSignal,
              );
            }
          } catch {
            // loseOperation records any undeleted thread for later reconciliation.
          } finally {
            observeLeaseReleased();
            finishContinuation();
          }
        })();
        return ownerSettlement;
      };
      const executeStream = async (
        stream: Parameters<Parameters<typeof sendStream>[1]>[0],
      ) => {
        const controller = new AbortController();
        const signal = continuation.signal
          ? AbortSignal.any([
              context.req.raw.signal,
              continuation.signal,
              controller.signal,
            ])
          : AbortSignal.any([context.req.raw.signal, controller.signal]);
        let aborted = false;
        let invalidation: Promise<void> | undefined;
        const invalidate = (): Promise<void> => {
          if (invalidation) return invalidation;
          aborted = true;
          deps.observe?.(context.req.raw, {
            streamOutcome: "cancelled",
            errorCode: "request_aborted",
          });
          controller.abort();
          invalidation = settleOwnedContinuation();
          return invalidation;
        };
        stream.onAbort(invalidate);
        const writeSSE = async (
          event: Parameters<typeof stream.writeSSE>[0],
        ): Promise<void> => {
          await writeSSEWithSignal(stream, event, signal);
        };
        let sequenceNumber = 0;
        const outputState = createOutputStreamState();
        try {
          await writeSSE({
            event: "response.created",
            data: JSON.stringify({
              type: "response.created",
              sequence_number: sequenceNumber,
              response: {
                id: identity.responseId,
                object: "response",
                created_at: identity.createdAt,
                status: "in_progress",
                model: identity.model,
                output: [],
              },
            }),
          });
          sequenceNumber += 1;
          for await (const event of continuation.events) {
            const reasoningEvents = reasoningStreamEvents(event, outputState);
            if (reasoningEvents.length > 0) {
              sequenceNumber = await writeProjectedStreamEvents(
                writeSSE,
                reasoningEvents,
                sequenceNumber,
              );
            } else if (event.type === "text.delta") {
              sequenceNumber = await writeProjectedStreamEvents(
                writeSSE,
                messageStartEvents(identity, outputState),
                sequenceNumber,
              );
              const outputIndex = messageOutputIndex(outputState);
              await writeSSE({
                event: "response.output_text.delta",
                data: JSON.stringify({
                  type: "response.output_text.delta",
                  sequence_number: sequenceNumber,
                  item_id: identity.messageId,
                  output_index: outputIndex,
                  content_index: 0,
                  delta: event.delta,
                  logprobs: [],
                }),
              });
              sequenceNumber += 1;
            } else if (event.type === "tool.call") {
              const outputIndex = outputState.nextOutputIndex++;
              const item = responseBody(identity, {
                threadId: continuation.threadId,
                turnId: continuation.turnId,
                text: "",
                finishReason: "tool_calls",
                toolCalls: [event.call],
              }).output[0];
              const addedItem =
                item?.type === "function_call"
                  ? { ...item, arguments: "" }
                  : item;
              await writeSSE({
                event: "response.output_item.added",
                data: JSON.stringify({
                  type: "response.output_item.added",
                  sequence_number: sequenceNumber,
                  output_index: outputIndex,
                  item: addedItem,
                }),
              });
              sequenceNumber += 1;
              await writeSSE({
                event: "response.function_call_arguments.delta",
                data: JSON.stringify({
                  type: "response.function_call_arguments.delta",
                  sequence_number: sequenceNumber,
                  item_id: item?.id,
                  output_index: outputIndex,
                  delta: JSON.stringify(event.call.arguments),
                }),
              });
              sequenceNumber += 1;
              await writeSSE({
                event: "response.function_call_arguments.done",
                data: JSON.stringify({
                  type: "response.function_call_arguments.done",
                  sequence_number: sequenceNumber,
                  item_id: item?.id,
                  output_index: outputIndex,
                  arguments: JSON.stringify(event.call.arguments),
                }),
              });
              sequenceNumber += 1;
              await writeSSE({
                event: "response.output_item.done",
                data: JSON.stringify({
                  type: "response.output_item.done",
                  sequence_number: sequenceNumber,
                  output_index: outputIndex,
                  item,
                }),
              });
              sequenceNumber += 1;
            } else if (event.type === "completed") {
              if (
                event.result.finishReason === "stop" ||
                outputState.messageOutputIndex !== undefined
              ) {
                if (event.result.finishReason === "stop") {
                  sequenceNumber = await writeProjectedStreamEvents(
                    writeSSE,
                    messageStartEvents(identity, outputState),
                    sequenceNumber,
                  );
                }
                sequenceNumber = await writeProjectedStreamEvents(
                  writeSSE,
                  messageCompletionEvents(
                    identity,
                    event.result.text,
                    outputState,
                  ),
                  sequenceNumber,
                );
              }
              if (event.result.finishReason === "stop") {
                await completeContinuation(event.result);
              }
              await writeSSE({
                event: "response.completed",
                data: JSON.stringify({
                  type: "response.completed",
                  sequence_number: sequenceNumber,
                  response: responseBody(identity, event.result),
                }),
              });
              deps.observe?.(context.req.raw, { streamOutcome: "completed" });
              if (event.result.finishReason === "stop") finishContinuation();
              return;
            } else if (event.type === "failed") {
              await settleOwnedContinuation();
              const projected = openAIErrorBody(event.error).error;
              await writeSSE({
                event: "error",
                data: JSON.stringify({
                  type: "error",
                  sequence_number: sequenceNumber,
                  code: projected.code,
                  message: projected.message,
                  param: projected.param,
                }),
              });
              deps.observe?.(context.req.raw, {
                streamOutcome: "failed",
                errorCode: projected.code,
              });
              return;
            }
          }
          throw new ProxyError(
            502,
            "codex_protocol_error",
            "Codex event stream ended before turn completion",
          );
        } catch (error) {
          await invalidate();
          if (
            aborted &&
            error instanceof DOMException &&
            error.name === "AbortError"
          ) {
            return;
          }
          deps.observe?.(context.req.raw, {
            streamOutcome: "failed",
            errorCode: openAIErrorBody(error).error.code,
          });
          throw error;
        } finally {
          streamCleanup.resolve();
        }
      };
      try {
        return sendStream(context, executeStream);
      } catch (error) {
        streamCleanup.resolve();
        await settleOwnedContinuation();
        throw error;
      }
    }
    assertOrdinaryRequest(request);
    if (request.previous_response_id !== undefined) {
      const configuration = deps.store.continuationToolConfiguration(
        request.previous_response_id,
        toolConfiguration,
      );
      if (configuration === "mismatch") {
        throw ProxyError.public(
          400,
          "tool_definitions_changed",
          "Tools and tool_choice must exactly match the previous response",
          "tools",
        );
      }
      if (configuration !== "match") throw decisionError(configuration);
    }
    const split = splitInput(request);
    const model = await validatedModel(deps, request, context.req.raw.signal);
    deps.observe?.(context.req.raw, { model: model.id });
    const history = translateHistory(split.history);
    const input = translateTurnInput(split.input);
    let permit: Permit | undefined = await deps.capacity?.acquire(
      context.req.raw.signal,
    );
    let admission: AdmittedTurn | undefined;
    if (permit !== undefined) {
      admission = deps.drain?.register(permit, context.req.raw.signal);
      deps.observe?.(context.req.raw, {
        queueOutcome: permit.queueOutcome ?? "admitted",
      });
    }
    const releasePermit = (): void => {
      if (admission) admission.release();
      else permit?.release();
      permit = undefined;
    };
    let admissionFinished = false;
    const finishAdmission = (): void => {
      if (admissionFinished) return;
      admissionFinished = true;
      admission?.done();
    };
    const turnSignal = admission?.signal ?? context.req.raw.signal;
    try {
      turnSignal.throwIfAborted();
    } catch (error) {
      finishAdmission();
      throw error;
    }
    const identity: ResponseIdentity = {
      responseId: opaqueId("resp"),
      messageId: opaqueId("msg"),
      createdAt: Math.floor(deps.clock.now() / 1_000),
      model: model.id,
    };
    const requestId =
      context.req.header("x-request-id") ?? `req_${randomUUID()}`;
    const stored = request.store !== false;
    const operationCwd = join(
      deps.operationWorkingDirectory,
      identity.responseId,
    );
    try {
      mkdirSync(deps.operationWorkingDirectory, {
        mode: 0o700,
        recursive: true,
      });
      mkdirSync(operationCwd, { mode: 0o700 });
    } catch (error) {
      finishAdmission();
      releasePermit();
      throw error;
    }
    let decision: OperationDecision;
    try {
      decision = deps.store.reserveOperation({
        responseId: identity.responseId,
        ...(request.previous_response_id === undefined
          ? {}
          : { previousResponseId: request.previous_response_id }),
        ownerRequestId: requestId,
        stored,
        processGeneration: deps.processGeneration(),
        operationCwd,
        toolConfiguration,
      });
    } catch (error) {
      removeOperationDirectory(operationCwd);
      finishAdmission();
      releasePermit();
      throw error;
    }
    if (
      decision.type === "busy" ||
      decision.type === "not_found" ||
      decision.type === "lost" ||
      decision.type === "tools_changed"
    ) {
      removeOperationDirectory(operationCwd);
      if (decision.type === "busy") {
        deps.observe?.(context.req.raw, { leaseOutcome: "busy" });
      }
      finishAdmission();
      releasePermit();
      if (decision.type === "tools_changed") {
        throw ProxyError.public(
          400,
          "tool_definitions_changed",
          "Tools and tool_choice must exactly match the previous response",
          "tools",
        );
      }
      throw decisionError(decision.type);
    }
    deps.observe?.(context.req.raw, { leaseOutcome: "acquired" });
    if (decision.type === "resume") removeOperationDirectory(operationCwd);

    const command: TurnCommand = {
      action:
        decision.type === "start"
          ? { type: "start" }
          : decision.type === "resume"
            ? { type: "resume", threadId: decision.threadId }
            : {
                type: "fork",
                threadId: decision.threadId,
                lastTurnId: decision.lastTurnId,
              },
      ...(decision.type === "resume" ? {} : { cwd: operationCwd }),
      model: model.id,
      history,
      input,
      ...(request.instructions === undefined
        ? {}
        : { instructions: request.instructions }),
      ...(request.reasoning?.effort === undefined
        ? {}
        : { effort: request.reasoning.effort }),
      ...(request.reasoning?.summary == null
        ? {}
        : { summary: request.reasoning.summary }),
      ...(request.text?.format?.type !== "json_schema"
        ? {}
        : { outputSchema: request.text.format.schema }),
      ...(dynamicTools.length === 0 ? {} : { dynamicTools }),
    };
    let openedThreadId: string | undefined;
    const lifecycle: TurnLifecycleCallbacks = {
      ...(permit === undefined ? {} : { release: releasePermit }),
      opened: (threadId) => {
        openedThreadId = threadId;
        deps.store.attachOperation(identity.responseId, threadId);
      },
      started: (_threadId, turnId) => {
        deps.store.attachOperationTurn(identity.responseId, turnId);
      },
      ...(dynamicTools.length === 0
        ? {}
        : {
            tool: {
              kind: "responses" as const,
              responseId: identity.responseId,
              leaseOwner: requestId,
              toolFingerprint,
              ...(admission === undefined
                ? {}
                : {
                    signal: admission.signal,
                    finish: finishAdmission,
                  }),
              suspended: () => {
                deps.store.suspendOperation(identity.responseId);
              },
              lost: async () => {
                try {
                  await loseResponseOperation(
                    deps,
                    identity.responseId,
                    turnSignal,
                  );
                  finalized = true;
                  deps.observe?.(context.req.raw, {
                    leaseOutcome: "released",
                  });
                } finally {
                  cleanupSettled = true;
                  finishAdmission();
                }
              },
            },
          }),
    };

    let finalized = false;
    let cleanupSettled = false;
    let cleanupAttempted = false;
    let cleanupSucceeded = false;
    let cleanupError: unknown;
    let abandonPromise: Promise<void> | undefined;
    let upstreamAttempted = false;
    const cleanupThread = async (threadId: string): Promise<void> => {
      if (cleanupAttempted) {
        if (cleanupError !== undefined) throw cleanupError;
        return;
      }
      cleanupAttempted = true;
      try {
        await deps.deleteThread(threadId, turnSignal);
        cleanupSucceeded = true;
      } catch (error) {
        cleanupError = error;
        throw error;
      }
    };
    const abandon = async (): Promise<void> => {
      if (finalized) return;
      abandonPromise ??= (async () => {
        try {
          const durableThreadId = deps.store.abandonOperation(
            identity.responseId,
            openedThreadId,
            upstreamAttempted,
          );
          const threadId =
            durableThreadId ??
            (decision.type === "start" || decision.type === "fork"
              ? openedThreadId
              : undefined);
          if (threadId !== undefined) {
            if (!cleanupAttempted) await cleanupThread(threadId);
            if (cleanupSucceeded) {
              deps.store.finishAbandonedThread(threadId);
              removeOperationDirectory(operationCwd);
            }
          } else if (decision.type === "start" || decision.type === "fork") {
            if (deps.store.lookupOperation(identity.responseId) === undefined) {
              removeOperationDirectory(operationCwd);
            }
          }
          finalized = true;
          deps.observe?.(context.req.raw, { leaseOutcome: "released" });
        } finally {
          cleanupSettled = true;
        }
      })();
      await abandonPromise;
    };
    const complete = async (result: TurnResult): Promise<void> => {
      try {
        if (!stored) await cleanupThread(result.threadId);
        const completedCwd = deps.store.completeOperation(identity.responseId);
        finalized = true;
        removeOperationDirectory(completedCwd);
        deps.observe?.(context.req.raw, { leaseOutcome: "released" });
      } finally {
        cleanupSettled = true;
      }
    };

    if (!request.stream) {
      try {
        upstreamAttempted = true;
        const result = await deps.runner.run(command, turnSignal, lifecycle);
        if (result.finishReason === "stop") {
          await complete(result);
        }
        return context.json(responseBody(identity, result));
      } catch (error) {
        await abandon();
        throw error;
      } finally {
        if (cleanupSettled) finishAdmission();
      }
    }

    context.header("X-Accel-Buffering", "no");
    const sendStream = deps.streamSSE ?? streamSSE;
    const streamCleanup = Promise.withResolvers<void>();
    deps.observe?.(context.req.raw, { streamCleanup: streamCleanup.promise });
    const executeStream = async (
      stream: Parameters<Parameters<typeof sendStream>[1]>[0],
    ) => {
      const controller = new AbortController();
      const signal = AbortSignal.any([turnSignal, controller.signal]);
      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
        deps.observe?.(context.req.raw, {
          streamOutcome: "cancelled",
          errorCode: "request_aborted",
        });
        controller.abort();
      });
      let sequenceNumber = 0;
      const outputState = createOutputStreamState();
      const writeSSE = (
        event: Parameters<typeof stream.writeSSE>[0],
      ): Promise<void> => writeSSEWithSignal(stream, event, signal);
      try {
        await writeSSE({
          event: "response.created",
          data: JSON.stringify({
            type: "response.created",
            sequence_number: sequenceNumber,
            response: {
              id: identity.responseId,
              object: "response",
              created_at: identity.createdAt,
              status: "in_progress",
              model: identity.model,
              output: [],
            },
          }),
        });
        signal.throwIfAborted();
        sequenceNumber += 1;

        upstreamAttempted = true;
        for await (const event of deps.runner.stream(
          command,
          signal,
          lifecycle,
        )) {
          const reasoningEvents = reasoningStreamEvents(event, outputState);
          if (reasoningEvents.length > 0) {
            sequenceNumber = await writeProjectedStreamEvents(
              writeSSE,
              reasoningEvents,
              sequenceNumber,
            );
          } else if (event.type === "text.delta") {
            sequenceNumber = await writeProjectedStreamEvents(
              writeSSE,
              messageStartEvents(identity, outputState),
              sequenceNumber,
            );
            const outputIndex = messageOutputIndex(outputState);
            await writeSSE({
              event: "response.output_text.delta",
              data: JSON.stringify({
                type: "response.output_text.delta",
                sequence_number: sequenceNumber,
                item_id: identity.messageId,
                output_index: outputIndex,
                content_index: 0,
                delta: event.delta,
                logprobs: [],
              }),
            });
            sequenceNumber += 1;
          } else if (event.type === "tool.call") {
            const outputIndex = outputState.nextOutputIndex++;
            const item = responseBody(identity, {
              threadId: "",
              turnId: "",
              text: "",
              finishReason: "tool_calls",
              toolCalls: [event.call],
            }).output[0];
            const addedItem =
              item?.type === "function_call"
                ? { ...item, arguments: "" }
                : item;
            await writeSSE({
              event: "response.output_item.added",
              data: JSON.stringify({
                type: "response.output_item.added",
                sequence_number: sequenceNumber,
                output_index: outputIndex,
                item: addedItem,
              }),
            });
            sequenceNumber += 1;
            await writeSSE({
              event: "response.function_call_arguments.delta",
              data: JSON.stringify({
                type: "response.function_call_arguments.delta",
                sequence_number: sequenceNumber,
                item_id: item?.id,
                output_index: outputIndex,
                delta: JSON.stringify(event.call.arguments),
              }),
            });
            sequenceNumber += 1;
            await writeSSE({
              event: "response.function_call_arguments.done",
              data: JSON.stringify({
                type: "response.function_call_arguments.done",
                sequence_number: sequenceNumber,
                item_id: item?.id,
                output_index: outputIndex,
                arguments: JSON.stringify(event.call.arguments),
              }),
            });
            sequenceNumber += 1;
            await writeSSE({
              event: "response.output_item.done",
              data: JSON.stringify({
                type: "response.output_item.done",
                sequence_number: sequenceNumber,
                output_index: outputIndex,
                item,
              }),
            });
            sequenceNumber += 1;
          } else if (event.type === "completed") {
            if (event.result.finishReason === "tool_calls") {
              if (outputState.messageOutputIndex !== undefined) {
                sequenceNumber = await writeProjectedStreamEvents(
                  writeSSE,
                  messageCompletionEvents(
                    identity,
                    event.result.text,
                    outputState,
                  ),
                  sequenceNumber,
                );
              }
              await writeSSE({
                event: "response.completed",
                data: JSON.stringify({
                  type: "response.completed",
                  sequence_number: sequenceNumber,
                  response: responseBody(identity, event.result),
                }),
              });
              deps.observe?.(context.req.raw, {
                streamOutcome: "completed",
              });
              return;
            }
            if (!stored) {
              try {
                await cleanupThread(event.result.threadId);
              } catch (error) {
                await abandon().catch(() => undefined);
                const projected = openAIErrorBody(error).error;
                await writeSSE({
                  event: "error",
                  data: JSON.stringify({
                    type: "error",
                    sequence_number: sequenceNumber,
                    code: projected.code,
                    message: projected.message,
                    param: projected.param,
                  }),
                });
                deps.observe?.(context.req.raw, {
                  streamOutcome: "failed",
                  errorCode: projected.code,
                });
                return;
              }
            }
            const body = responseBody(identity, event.result);
            sequenceNumber = await writeProjectedStreamEvents(
              writeSSE,
              messageStartEvents(identity, outputState),
              sequenceNumber,
            );
            sequenceNumber = await writeProjectedStreamEvents(
              writeSSE,
              messageCompletionEvents(identity, event.result.text, outputState),
              sequenceNumber,
            );
            await complete(event.result);
            await writeSSE({
              event: "response.completed",
              data: JSON.stringify({
                type: "response.completed",
                sequence_number: sequenceNumber,
                response: body,
              }),
            });
            deps.observe?.(context.req.raw, { streamOutcome: "completed" });
            return;
          } else if (event.type === "failed") {
            let failure: unknown = event.error;
            try {
              await abandon();
            } catch (error) {
              failure = error;
            }
            const projected = openAIErrorBody(failure).error;
            await writeSSE({
              event: "error",
              data: JSON.stringify({
                type: "error",
                sequence_number: sequenceNumber,
                code: projected.code,
                message: projected.message,
                param: projected.param,
              }),
            });
            deps.observe?.(context.req.raw, {
              streamOutcome: "failed",
              errorCode: projected.code,
            });
            return;
          }
        }
        throw new ProxyError(
          502,
          "codex_protocol_error",
          "Codex event stream ended before turn completion",
        );
      } catch (error) {
        controller.abort();
        if (!upstreamAttempted) releasePermit();
        if (dynamicTools.length > 0) {
          await deps.runner.tools.invalidateResponse(identity.responseId);
        }
        await abandon().catch(() => undefined);
        if (
          aborted &&
          error instanceof DOMException &&
          error.name === "AbortError"
        ) {
          return;
        }
        deps.observe?.(context.req.raw, {
          streamOutcome:
            signal.aborted && context.req.raw.signal.aborted
              ? "cancelled"
              : "failed",
          errorCode:
            signal.aborted && context.req.raw.signal.aborted
              ? "request_aborted"
              : openAIErrorBody(error).error.code,
        });
        throw error;
      } finally {
        if (cleanupSettled) finishAdmission();
        streamCleanup.resolve();
      }
    };
    try {
      return sendStream(context, executeStream);
    } catch (error) {
      if (!upstreamAttempted) releasePermit();
      await abandon().catch(() => undefined);
      if (cleanupSettled) finishAdmission();
      streamCleanup.resolve();
      throw error;
    }
  };
}
