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
import type { TokenUsage, TurnCommand, TurnResult } from "../turns/events.js";
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

export interface ResponseSweepDependencies {
  store: ConversationStore;
  deleteThread(threadId: string): void | Promise<void>;
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
        status: "completed";
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
): Promise<void> {
  const operationCwd = deps.store.lookupOperation(responseId)?.operationCwd;
  const cleanupThreadId = deps.store.loseOperation(responseId);
  try {
    if (cleanupThreadId !== undefined) {
      await deps.deleteThread(cleanupThreadId);
      deps.store.finishAbandonedThread(cleanupThreadId);
    }
  } finally {
    removeOperationDirectory(operationCwd);
  }
}

async function threadsForOperation(
  host: Pick<CodexHost, "threadList">,
  cwd: string,
): Promise<Thread[]> {
  const matches = new Map<string, Thread>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const response = await host.threadList({
      cwd,
      sourceKinds: ["appServer"],
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
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
    await deps.host.threadDelete({ threadId: operation.threadId });
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
): Promise<void> {
  if (deps.host !== undefined) {
    await recoverResponseOperations({ store: deps.store, host: deps.host });
  }
  for (const threadId of deps.store.abandonedThreads()) {
    try {
      await deps.deleteThread(threadId);
    } catch {
      return;
    }
    deps.store.finishAbandonedThread(threadId);
  }
  deps.store.expire();
  for (const threadId of deps.store.deletableLeafThreads()) {
    try {
      await deps.deleteThread(threadId);
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
  const enqueue = (): Promise<void> => {
    if (stopped) return inFlight;
    inFlight = inFlight
      .catch(() => undefined)
      .then(() => sweepExpiredResponses(deps));
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
      }
      await inFlight;
    },
  };
}

function opaqueId(prefix: "resp" | "msg"): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

async function requestBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
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
  if (result.finishReason === "tool_calls") {
    return {
      id: identity.responseId,
      object: "response",
      created_at: identity.createdAt,
      status: "completed",
      model: identity.model,
      output: (result.toolCalls ?? []).map((call) => ({
        id: `fc_${call.id.slice("call_".length)}`,
        type: "function_call" as const,
        status: "completed" as const,
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      })),
      ...(result.usage === undefined ? {} : { usage: usageBody(result.usage) }),
    };
  }
  return {
    id: identity.responseId,
    object: "response",
    created_at: identity.createdAt,
    status: "completed",
    model: identity.model,
    output: [
      {
        id: identity.messageId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: result.text, annotations: [] }],
      },
    ],
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
    const toolFingerprint = deps.runner.tools.fingerprintDefinitions(
      request.tools ?? [],
    );
    const outputs = functionOutputs(request);
    if (outputs.length > 0) {
      if (
        request.previous_response_id === undefined ||
        !Array.isArray(request.input) ||
        request.input.length !== outputs.length
      ) {
        throw ProxyError.public(
          400,
          "invalid_tool_continuation",
          "Function outputs require one pending previous response",
          "input",
        );
      }
      const model = await validatedModel(deps, request, context.req.raw.signal);
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
      const continuation = await deps.runner.tools.continue({
        kind: "responses",
        responseId: request.previous_response_id,
        toolFingerprint,
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
      let result: TurnResult;
      try {
        result = await continuation.result;
      } catch (error) {
        await loseResponseOperation(deps, request.previous_response_id).catch(
          () => undefined,
        );
        throw error;
      }
      const identity: ResponseIdentity = {
        responseId: request.previous_response_id,
        messageId: opaqueId("msg"),
        createdAt: Math.floor(deps.clock.now() / 1_000),
        model: model.id,
      };
      if (result.finishReason === "stop") {
        const operationCwd = deps.store.completeOperation(identity.responseId);
        removeOperationDirectory(operationCwd);
      }
      if (!request.stream) return context.json(responseBody(identity, result));
      const sendStream = deps.streamSSE ?? streamSSE;
      return sendStream(context, async (stream) => {
        let aborted = false;
        const invalidate = (): void => {
          aborted = true;
          if (result.finishReason === "tool_calls") {
            deps.runner.tools.invalidateResponse(identity.responseId);
          }
        };
        stream.onAbort(invalidate);
        const writeSSE = async (
          event: Parameters<typeof stream.writeSSE>[0],
        ): Promise<void> => {
          if (aborted) throw new DOMException("aborted", "AbortError");
          await stream.writeSSE(event);
          if (aborted) throw new DOMException("aborted", "AbortError");
        };
        let sequenceNumber = 0;
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
          if (result.finishReason === "stop") {
            await writeSSE({
              event: "response.output_text.done",
              data: JSON.stringify({
                type: "response.output_text.done",
                sequence_number: sequenceNumber,
                item_id: identity.messageId,
                output_index: 0,
                content_index: 0,
                text: result.text,
                logprobs: [],
              }),
            });
            sequenceNumber += 1;
          }
          for (const [outputIndex, call] of (
            result.toolCalls ?? []
          ).entries()) {
            const item = responseBody(identity, {
              ...result,
              toolCalls: [call],
            }).output[0];
            await writeSSE({
              event: "response.output_item.added",
              data: JSON.stringify({
                type: "response.output_item.added",
                sequence_number: sequenceNumber,
                output_index: outputIndex,
                item,
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
                delta: JSON.stringify(call.arguments),
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
                arguments: JSON.stringify(call.arguments),
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
          }
          await writeSSE({
            event: "response.completed",
            data: JSON.stringify({
              type: "response.completed",
              sequence_number: sequenceNumber,
              response: responseBody(identity, result),
            }),
          });
        } catch (error) {
          invalidate();
          if (
            aborted &&
            error instanceof DOMException &&
            error.name === "AbortError"
          ) {
            return;
          }
          throw error;
        }
      });
    }
    assertOrdinaryRequest(request);
    const split = splitInput(request);
    const model = await validatedModel(deps, request, context.req.raw.signal);
    const history = translateHistory(split.history);
    const input = translateTurnInput(split.input);
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
    mkdirSync(deps.operationWorkingDirectory, { mode: 0o700, recursive: true });
    mkdirSync(operationCwd, { mode: 0o700 });
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
      });
    } catch (error) {
      removeOperationDirectory(operationCwd);
      throw error;
    }
    if (
      decision.type === "busy" ||
      decision.type === "not_found" ||
      decision.type === "lost"
    ) {
      removeOperationDirectory(operationCwd);
      throw decisionError(decision.type);
    }
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
      ...(request.text === undefined
        ? {}
        : { outputSchema: request.text.format.schema }),
      ...(dynamicTools.length === 0 ? {} : { dynamicTools }),
    };
    let openedThreadId: string | undefined;
    const lifecycle: TurnLifecycleCallbacks = {
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
              suspended: () => {
                deps.store.suspendOperation(identity.responseId);
              },
              lost: async () => {
                await loseResponseOperation(deps, identity.responseId);
                finalized = true;
              },
            },
          }),
    };

    let finalized = false;
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
        await deps.deleteThread(threadId);
        cleanupSucceeded = true;
      } catch (error) {
        cleanupError = error;
        throw error;
      }
    };
    const abandon = async (): Promise<void> => {
      if (finalized) return;
      abandonPromise ??= (async () => {
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
      })();
      await abandonPromise;
    };
    const complete = async (result: TurnResult): Promise<void> => {
      if (!stored) await cleanupThread(result.threadId);
      const completedCwd = deps.store.completeOperation(identity.responseId);
      finalized = true;
      removeOperationDirectory(completedCwd);
    };

    if (!request.stream) {
      try {
        upstreamAttempted = true;
        const result = await deps.runner.run(
          command,
          context.req.raw.signal,
          lifecycle,
        );
        if (result.finishReason === "stop") await complete(result);
        return context.json(responseBody(identity, result));
      } catch (error) {
        await abandon();
        throw error;
      }
    }

    context.header("X-Accel-Buffering", "no");
    const sendStream = deps.streamSSE ?? streamSSE;
    const executeStream = async (
      stream: Parameters<Parameters<typeof sendStream>[1]>[0],
    ) => {
      const controller = new AbortController();
      const signal = AbortSignal.any([
        context.req.raw.signal,
        controller.signal,
      ]);
      stream.onAbort(() => controller.abort());
      let sequenceNumber = 0;
      let toolOutputIndex = 0;
      try {
        await stream.writeSSE({
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

        upstreamAttempted = true;
        for await (const event of deps.runner.stream(
          command,
          signal,
          lifecycle,
        )) {
          if (event.type === "text.delta") {
            await stream.writeSSE({
              event: "response.output_text.delta",
              data: JSON.stringify({
                type: "response.output_text.delta",
                sequence_number: sequenceNumber,
                item_id: identity.messageId,
                output_index: 0,
                content_index: 0,
                delta: event.delta,
                logprobs: [],
              }),
            });
            sequenceNumber += 1;
          } else if (event.type === "tool.call") {
            const item = responseBody(identity, {
              threadId: "",
              turnId: "",
              text: "",
              finishReason: "tool_calls",
              toolCalls: [event.call],
            }).output[0];
            await stream.writeSSE({
              event: "response.output_item.added",
              data: JSON.stringify({
                type: "response.output_item.added",
                sequence_number: sequenceNumber,
                output_index: toolOutputIndex,
                item,
              }),
            });
            sequenceNumber += 1;
            await stream.writeSSE({
              event: "response.function_call_arguments.delta",
              data: JSON.stringify({
                type: "response.function_call_arguments.delta",
                sequence_number: sequenceNumber,
                item_id: item?.id,
                output_index: toolOutputIndex,
                delta: JSON.stringify(event.call.arguments),
              }),
            });
            sequenceNumber += 1;
            await stream.writeSSE({
              event: "response.function_call_arguments.done",
              data: JSON.stringify({
                type: "response.function_call_arguments.done",
                sequence_number: sequenceNumber,
                item_id: item?.id,
                output_index: toolOutputIndex,
                arguments: JSON.stringify(event.call.arguments),
              }),
            });
            sequenceNumber += 1;
            await stream.writeSSE({
              event: "response.output_item.done",
              data: JSON.stringify({
                type: "response.output_item.done",
                sequence_number: sequenceNumber,
                output_index: toolOutputIndex,
                item,
              }),
            });
            sequenceNumber += 1;
            toolOutputIndex += 1;
          } else if (event.type === "completed") {
            if (event.result.finishReason === "tool_calls") {
              await stream.writeSSE({
                event: "response.completed",
                data: JSON.stringify({
                  type: "response.completed",
                  sequence_number: sequenceNumber,
                  response: responseBody(identity, event.result),
                }),
              });
              return;
            }
            if (!stored) {
              try {
                await cleanupThread(event.result.threadId);
              } catch (error) {
                await abandon().catch(() => undefined);
                const projected = openAIErrorBody(error).error;
                await stream.writeSSE({
                  event: "error",
                  data: JSON.stringify({
                    type: "error",
                    sequence_number: sequenceNumber,
                    code: projected.code,
                    message: projected.message,
                    param: projected.param,
                  }),
                });
                return;
              }
            }
            const body = responseBody(identity, event.result);
            await stream.writeSSE({
              event: "response.output_text.done",
              data: JSON.stringify({
                type: "response.output_text.done",
                sequence_number: sequenceNumber,
                item_id: identity.messageId,
                output_index: 0,
                content_index: 0,
                text: event.result.text,
                logprobs: [],
              }),
            });
            sequenceNumber += 1;
            await complete(event.result);
            await stream.writeSSE({
              event: "response.completed",
              data: JSON.stringify({
                type: "response.completed",
                sequence_number: sequenceNumber,
                response: body,
              }),
            });
            return;
          } else if (event.type === "failed") {
            let failure: unknown = event.error;
            try {
              await abandon();
            } catch (error) {
              failure = error;
            }
            const projected = openAIErrorBody(failure).error;
            await stream.writeSSE({
              event: "error",
              data: JSON.stringify({
                type: "error",
                sequence_number: sequenceNumber,
                code: projected.code,
                message: projected.message,
                param: projected.param,
              }),
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
        if (dynamicTools.length > 0) {
          deps.runner.tools.invalidateResponse(identity.responseId);
        }
        await abandon().catch(() => undefined);
        throw error;
      }
    };
    try {
      return sendStream(context, executeStream);
    } catch (error) {
      await abandon().catch(() => undefined);
      throw error;
    }
  };
}
