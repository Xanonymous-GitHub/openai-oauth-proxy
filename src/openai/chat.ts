import { randomBytes } from "node:crypto";
import type { Handler } from "hono";
import { streamSSE } from "hono/streaming";
import { openAIErrorBody, ProxyError } from "../http/errors.js";
import { readJsonBody } from "../http/limits.js";
import type { TurnCapacity } from "../operations/capacity.js";
import type { AdmittedTurn, TurnDrainRegistry } from "../operations/drain.js";
import type { ObserveRequest } from "../operations/telemetry.js";
import type { TokenUsage, TurnCommand, TurnResult } from "../turns/events.js";
import type { TurnLifecycleCallbacks, TurnRunner } from "../turns/runner.js";
import { decodeImages } from "./images.js";
import type { ModelCapabilities, ModelCatalog } from "./models.js";
import { type ChatMessage, parseChatRequest } from "./schemas.js";
import { translateHistory, translateTurnInput } from "./translate.js";

type ModelLookup = Pick<ModelCatalog, "lookup">;

export interface ChatHandlerDependencies {
  models: ModelLookup;
  runner: TurnRunner;
  deleteThread(threadId: string, signal?: AbortSignal): void | Promise<void>;
  release?: () => void | Promise<void>;
  capacity?: Pick<TurnCapacity, "acquire">;
  drain?: Pick<TurnDrainRegistry, "register">;
  observe?: ObserveRequest;
  streamSSE?: typeof streamSSE;
}

interface ChatIdentity {
  id: string;
  created: number;
  model: string;
}

function completionId(): string {
  return `chatcmpl_${randomBytes(24).toString("base64url")}`;
}

function usageBody(usage: TokenUsage): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
  };
}

function assertInitialMessages(
  messages: readonly ChatMessage[],
): asserts messages is readonly Exclude<ChatMessage, { role: "tool" }>[] {
  for (const [index, message] of messages.entries()) {
    if (message.role === "tool") {
      throw ProxyError.public(
        400,
        "unknown_tool_call",
        "Tool output did not match a pending call",
        `messages.${index}`,
      );
    }
    if (message.role === "assistant" && message.tool_calls !== undefined) {
      throw ProxyError.public(
        400,
        "unknown_tool_call",
        "Assistant tool calls require pending tool outputs",
        `messages.${index}.tool_calls`,
      );
    }
  }
}

function toolOutputs(messages: readonly ChatMessage[]) {
  const trailing: Array<Extract<ChatMessage, { role: "tool" }>> = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "tool") break;
    trailing.push(message);
  }
  return trailing.reverse().map((message) => ({
    callId: message.tool_call_id,
    output: message.content,
  }));
}

function imageParts(messages: readonly ChatMessage[]) {
  return messages.flatMap((message) => {
    if (message.role !== "user" || typeof message.content === "string")
      return [];
    return message.content.filter((part) => part.type === "image_url");
  });
}

function chunk(
  identity: ChatIdentity,
  choice: {
    index: 0;
    delta: {
      role?: "assistant";
      content?: string;
      tool_calls?: Array<{
        index: number;
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: "stop" | "tool_calls" | null;
  },
  usage?: TokenUsage,
) {
  return {
    ...identity,
    object: "chat.completion.chunk" as const,
    choices: [choice],
    ...(usage === undefined ? {} : { usage: usageBody(usage) }),
  };
}

function resultMessage(result: TurnResult) {
  if (result.finishReason === "tool_calls") {
    return {
      role: "assistant" as const,
      content: result.text === "" ? null : result.text,
      tool_calls: (result.toolCalls ?? []).map((call) => ({
        id: call.id,
        type: "function" as const,
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      })),
    };
  }
  return { role: "assistant" as const, content: result.text };
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

export function createChatHandler(deps: ChatHandlerDependencies): Handler {
  return async (context) => {
    const request = parseChatRequest(await requestBody(context.req.raw));
    const validatedTools = deps.runner.tools.toDynamicTools(
      request.tools ?? [],
    );
    const dynamicTools = request.tool_choice === "none" ? [] : validatedTools;
    const toolFingerprint = deps.runner.tools.fingerprintDefinitions(
      request.tools ?? [],
    );
    const outputs = toolOutputs(request.messages);

    const images = imageParts(request.messages);
    decodeImages(images);

    let model: ModelCapabilities | undefined;
    try {
      model = await deps.models.lookup(request.model, context.req.raw.signal);
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
    deps.observe?.(context.req.raw, { model: model.id });
    if (images.length > 0 && !model.supportsImage) {
      throw ProxyError.public(
        400,
        "unsupported_image_model",
        `Model ${request.model} does not support image input`,
        "model",
      );
    }
    if (
      request.reasoning_effort !== undefined &&
      !model.supportedReasoningEfforts.includes(request.reasoning_effort)
    ) {
      throw ProxyError.public(
        400,
        "unsupported_reasoning_effort",
        `Model ${request.model} does not support reasoning effort ${request.reasoning_effort}`,
        "reasoning_effort",
      );
    }

    const identity: ChatIdentity = {
      id: completionId(),
      created: Math.floor(Date.now() / 1_000),
      model: model.id,
    };
    const streamController = request.stream ? new AbortController() : undefined;
    let turnSignal = streamController
      ? AbortSignal.any([context.req.raw.signal, streamController.signal])
      : context.req.raw.signal;
    let continuationResult: Promise<TurnResult> | undefined;
    if (outputs.length > 0) {
      const continuation = await deps.runner.tools.continue({
        kind: "chat",
        toolFingerprint,
        results: outputs,
        signal: turnSignal,
      });
      if (continuation.type === "lost") {
        throw ProxyError.public(
          409,
          "proxy_continuation_lost",
          "Tool continuation was lost after a proxy restart",
          "messages",
        );
      }
      if (continuation.type === "incomplete") {
        throw ProxyError.public(
          400,
          "incomplete_tool_outputs",
          `Missing tool outputs: ${continuation.missingCallIds.join(", ")}`,
          "messages",
        );
      }
      continuationResult = continuation.result;
    }

    const lastMessage = request.messages.at(-1);
    if (continuationResult === undefined && lastMessage?.role !== "user") {
      assertInitialMessages(request.messages);
      throw ProxyError.public(
        400,
        "invalid_chat_history",
        "Ordinary Chat requests must end with a user message",
        `messages.${request.messages.length - 1}.role`,
      );
    }
    if (continuationResult === undefined)
      assertInitialMessages(request.messages);
    const command: TurnCommand = {
      action: { type: "start" },
      model: model.id,
      history: translateHistory(request.messages.slice(0, -1)),
      input:
        lastMessage?.role === "user"
          ? translateTurnInput(lastMessage.content)
          : [],
      ...(request.reasoning_effort === undefined
        ? {}
        : { effort: request.reasoning_effort }),
      ...(request.response_format === undefined
        ? {}
        : { outputSchema: request.response_format.json_schema.schema }),
      ...(dynamicTools.length === 0 ? {} : { dynamicTools }),
    };
    const permit =
      continuationResult === undefined
        ? await deps.capacity?.acquire(context.req.raw.signal)
        : undefined;
    let admission: AdmittedTurn | undefined;
    if (permit !== undefined) {
      admission = deps.drain?.register(permit, context.req.raw.signal);
      turnSignal = admission?.signal ?? turnSignal;
      if (streamController) {
        turnSignal = AbortSignal.any([turnSignal, streamController.signal]);
      }
      deps.observe?.(context.req.raw, {
        queueOutcome: permit.queueOutcome ?? "admitted",
      });
    }
    const lifecycle: TurnLifecycleCallbacks = {
      ...(permit === undefined && deps.release === undefined
        ? {}
        : { release: admission?.release ?? permit?.release ?? deps.release }),
      ...(admission === undefined ? {} : { settled: admission.done }),
      cleanup: deps.deleteThread,
      ...(dynamicTools.length === 0
        ? {}
        : {
            tool: {
              kind: "chat" as const,
              leaseOwner: identity.id,
              toolFingerprint,
            },
          }),
    };

    if (!request.stream) {
      try {
        const result = await (continuationResult ??
          deps.runner.run(command, turnSignal, lifecycle));
        if (result.finishReason === "stop") admission?.done();
        return context.json({
          ...identity,
          object: "chat.completion" as const,
          choices: [
            {
              index: 0,
              message: resultMessage(result),
              finish_reason: result.finishReason,
            },
          ],
          ...(result.usage === undefined
            ? {}
            : { usage: usageBody(result.usage) }),
        });
      } catch (error) {
        admission?.done();
        throw error;
      }
    }

    context.header("X-Accel-Buffering", "no");
    const sendStream = deps.streamSSE ?? streamSSE;
    let runnerStarted = false;
    const executeStream = async (
      stream: Parameters<Parameters<typeof sendStream>[1]>[0],
    ) => {
      const streamedToolCallIds: string[] = [];
      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
        deps.observe?.(context.req.raw, {
          streamOutcome: "cancelled",
          errorCode: "request_aborted",
        });
        streamController?.abort();
        deps.runner.tools.invalidateCalls(streamedToolCallIds);
      });
      const writeSSE = async (event: { data: string }): Promise<void> => {
        if (aborted) throw new DOMException("aborted", "AbortError");
        await stream.writeSSE(event);
        if (aborted) throw new DOMException("aborted", "AbortError");
      };

      try {
        const continuationStage = continuationResult
          ? await continuationResult
          : undefined;
        for (const call of continuationStage?.toolCalls ?? []) {
          streamedToolCallIds.push(call.id);
        }
        await writeSSE({
          data: JSON.stringify(
            chunk(identity, {
              index: 0,
              delta: { role: "assistant" },
              finish_reason: null,
            }),
          ),
        });
        turnSignal.throwIfAborted();

        let usage: TokenUsage | undefined;
        let toolIndex = 0;
        const source = continuationStage
          ? (async function* () {
              if (continuationStage.text !== "") {
                yield {
                  type: "text.delta" as const,
                  delta: continuationStage.text,
                };
              }
              for (const call of continuationStage.toolCalls ?? []) {
                yield { type: "tool.call" as const, call };
              }
              yield { type: "completed" as const, result: continuationStage };
            })()
          : (() => {
              runnerStarted = true;
              return deps.runner.stream(command, turnSignal, lifecycle);
            })();
        for await (const event of source) {
          if (event.type === "text.delta") {
            await writeSSE({
              data: JSON.stringify(
                chunk(identity, {
                  index: 0,
                  delta: { content: event.delta },
                  finish_reason: null,
                }),
              ),
            });
          } else if (event.type === "tool.call") {
            if (!streamedToolCallIds.includes(event.call.id)) {
              streamedToolCallIds.push(event.call.id);
            }
            await writeSSE({
              data: JSON.stringify(
                chunk(identity, {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: toolIndex,
                        id: event.call.id,
                        type: "function",
                        function: {
                          name: event.call.name,
                          arguments: JSON.stringify(event.call.arguments),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                }),
              ),
            });
            toolIndex += 1;
          } else if (event.type === "usage") {
            usage = event.usage;
          } else if (event.type === "completed") {
            await writeSSE({
              data: JSON.stringify(
                chunk(
                  identity,
                  {
                    index: 0,
                    delta: {},
                    finish_reason: event.result.finishReason,
                  },
                  event.result.usage ?? usage,
                ),
              ),
            });
            await writeSSE({ data: "[DONE]" });
            deps.observe?.(context.req.raw, { streamOutcome: "completed" });
            if (event.result.finishReason === "stop") admission?.done();
          } else if (event.type === "failed") {
            deps.observe?.(context.req.raw, {
              streamOutcome: "failed",
              errorCode: event.error.code,
            });
            await writeSSE({
              data: JSON.stringify(openAIErrorBody(event.error)),
            });
            admission?.done();
            return;
          }
        }
      } catch (error) {
        streamController?.abort();
        if (!runnerStarted) admission?.done();
        deps.runner.tools.invalidateCalls(streamedToolCallIds);
        if (
          aborted &&
          ((error instanceof DOMException && error.name === "AbortError") ||
            (error instanceof ProxyError && error.code === "request_aborted"))
        ) {
          return;
        }
        deps.observe?.(context.req.raw, {
          streamOutcome: "failed",
          errorCode: openAIErrorBody(error).error.code,
        });
        throw error;
      }
    };
    try {
      return sendStream(context, executeStream);
    } catch (error) {
      admission?.done();
      throw error;
    }
  };
}
