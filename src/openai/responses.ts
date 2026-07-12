import { randomBytes, randomUUID } from "node:crypto";
import type { Handler } from "hono";
import { streamSSE } from "hono/streaming";
import type {
  ConversationClock,
  ConversationStore,
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
  deleteThread(threadId: string, signal?: AbortSignal): void | Promise<void>;
}

export interface ProxyResponse {
  id: string;
  object: "response";
  created_at: number;
  status: "completed";
  model: string;
  output: Array<{
    id: string;
    type: "message";
    status: "completed";
    role: "assistant";
    content: Array<{ type: "output_text"; text: string; annotations: [] }>;
  }>;
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
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

function toolSemanticsError(param: string): ProxyError {
  return ProxyError.public(
    400,
    "unsupported_tool_semantics",
    "Function tool turns are not supported yet",
    param,
  );
}

function assertOrdinaryRequest(request: ResponsesRequest): void {
  if (request.tools !== undefined) throw toolSemanticsError("tools");
  if (request.tool_choice !== undefined)
    throw toolSemanticsError("tool_choice");
  if (request.parallel_tool_calls !== undefined) {
    throw toolSemanticsError("parallel_tool_calls");
  }
  if (Array.isArray(request.input)) {
    for (const [index, item] of request.input.entries()) {
      if (!("role" in item)) throw toolSemanticsError(`input.${index}`);
    }
  }
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
    assertOrdinaryRequest(request);
    const split = splitInput(request);
    const model = await validatedModel(deps, request, context.req.raw.signal);
    const requestId =
      context.req.header("x-request-id") ?? `req_${randomUUID()}`;
    const decision = deps.store.decide(request.previous_response_id, requestId);
    if (
      decision.type === "busy" ||
      decision.type === "not_found" ||
      decision.type === "lost"
    ) {
      throw decisionError(decision.type);
    }

    const identity: ResponseIdentity = {
      responseId: opaqueId("resp"),
      messageId: opaqueId("msg"),
      createdAt: Math.floor(deps.clock.now() / 1_000),
      model: model.id,
    };
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
      model: model.id,
      history: translateHistory(split.history),
      input: translateTurnInput(split.input),
      ...(request.instructions === undefined
        ? {}
        : { instructions: request.instructions }),
      ...(request.reasoning?.effort === undefined
        ? {}
        : { effort: request.reasoning.effort }),
      ...(request.text === undefined
        ? {}
        : { outputSchema: request.text.format.schema }),
    };
    const stored = request.store !== false;
    let openedThreadId: string | undefined;
    let leaseThreadId =
      decision.type === "start" ? undefined : decision.threadId;
    let pending = false;
    const lifecycle: TurnLifecycleCallbacks = {
      opened: (threadId) => {
        openedThreadId = threadId;
        if (!stored) return;
        if (decision.type === "start") leaseThreadId = threadId;
        const created = deps.store.beginPending(
          identity.responseId,
          {
            threadId,
            ...(decision.type === "start"
              ? {}
              : { parentResponseId: decision.responseId }),
            ...(decision.type === "fork"
              ? {
                  parentThreadId: decision.threadId,
                  forkedAtTurnId: decision.lastTurnId,
                }
              : {}),
            stored: true,
            processGeneration: deps.processGeneration(),
          },
          decision.type === "start" ? requestId : undefined,
        );
        if (!created) throw decisionError("busy");
        pending = true;
      },
      release: () => {
        if (leaseThreadId !== undefined) {
          deps.store.releaseLease(leaseThreadId, requestId);
        }
      },
      ...(stored ? {} : { cleanup: deps.deleteThread }),
    };

    const abandon = async (): Promise<void> => {
      if (!pending) return;
      if (
        openedThreadId !== undefined &&
        (decision.type === "start" || decision.type === "fork")
      ) {
        await deps.deleteThread(openedThreadId);
      }
      deps.store.abandon(identity.responseId);
      pending = false;
    };

    if (!request.stream) {
      try {
        const result = await deps.runner.run(
          command,
          context.req.raw.signal,
          lifecycle,
        );
        if (stored) {
          deps.store.complete(identity.responseId, result.turnId);
          pending = false;
        }
        return context.json(responseBody(identity, result));
      } catch (error) {
        await abandon();
        throw error;
      }
    }

    context.header("X-Accel-Buffering", "no");
    return streamSSE(context, async (stream) => {
      const controller = new AbortController();
      const signal = AbortSignal.any([
        context.req.raw.signal,
        controller.signal,
      ]);
      stream.onAbort(() => controller.abort());
      let sequenceNumber = 0;
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
        } else if (event.type === "completed") {
          try {
            if (stored) {
              deps.store.complete(identity.responseId, event.result.turnId);
              pending = false;
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
            await stream.writeSSE({
              event: "response.completed",
              data: JSON.stringify({
                type: "response.completed",
                sequence_number: sequenceNumber,
                response: body,
              }),
            });
            sequenceNumber += 1;
          } catch (error) {
            await abandon();
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
          }
          return;
        } else if (event.type === "failed") {
          await abandon();
          const projected = openAIErrorBody(event.error).error;
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
    });
  };
}
