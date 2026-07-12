import { randomBytes } from "node:crypto";
import type { Handler } from "hono";
import { streamSSE } from "hono/streaming";
import { openAIErrorBody, ProxyError } from "../http/errors.js";
import type { TokenUsage, TurnCommand } from "../turns/events.js";
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

function toolSemanticsError(param: string): ProxyError {
  return ProxyError.public(
    400,
    "unsupported_tool_semantics",
    "Function tool turns are not supported yet",
    param,
  );
}

function assertOrdinaryMessages(
  messages: readonly ChatMessage[],
): asserts messages is readonly Exclude<ChatMessage, { role: "tool" }>[] {
  for (const [index, message] of messages.entries()) {
    if (message.role === "tool") {
      throw toolSemanticsError(`messages.${index}`);
    }
    if (message.role === "assistant" && message.tool_calls !== undefined) {
      throw toolSemanticsError(`messages.${index}.tool_calls`);
    }
  }
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
    delta: { role?: "assistant"; content?: string };
    finish_reason: "stop" | null;
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

export function createChatHandler(deps: ChatHandlerDependencies): Handler {
  return async (context) => {
    const request = parseChatRequest(await requestBody(context.req.raw));
    if (request.tools !== undefined) throw toolSemanticsError("tools");
    if (request.tool_choice !== undefined)
      throw toolSemanticsError("tool_choice");
    if (request.parallel_tool_calls !== undefined) {
      throw toolSemanticsError("parallel_tool_calls");
    }
    assertOrdinaryMessages(request.messages);

    const lastMessage = request.messages.at(-1);
    if (lastMessage?.role !== "user") {
      throw ProxyError.public(
        400,
        "invalid_chat_history",
        "Ordinary Chat requests must end with a user message",
        `messages.${request.messages.length - 1}.role`,
      );
    }

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
    const command: TurnCommand = {
      action: { type: "start" },
      model: model.id,
      history: translateHistory(request.messages.slice(0, -1)),
      input: translateTurnInput(lastMessage.content),
      ...(request.reasoning_effort === undefined
        ? {}
        : { effort: request.reasoning_effort }),
      ...(request.response_format === undefined
        ? {}
        : { outputSchema: request.response_format.json_schema.schema }),
    };
    const lifecycle: TurnLifecycleCallbacks = {
      ...(deps.release === undefined ? {} : { release: deps.release }),
      cleanup: deps.deleteThread,
    };

    if (!request.stream) {
      const result = await deps.runner.run(
        command,
        context.req.raw.signal,
        lifecycle,
      );
      return context.json({
        ...identity,
        object: "chat.completion" as const,
        choices: [
          {
            index: 0,
            message: { role: "assistant" as const, content: result.text },
            finish_reason: result.finishReason,
          },
        ],
        ...(result.usage === undefined
          ? {}
          : { usage: usageBody(result.usage) }),
      });
    }

    context.header("X-Accel-Buffering", "no");
    return streamSSE(context, async (stream) => {
      const controller = new AbortController();
      const signal = AbortSignal.any([
        context.req.raw.signal,
        controller.signal,
      ]);
      stream.onAbort(() => controller.abort());

      await stream.writeSSE({
        data: JSON.stringify(
          chunk(identity, {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
          }),
        ),
      });

      let usage: TokenUsage | undefined;
      for await (const event of deps.runner.stream(
        command,
        signal,
        lifecycle,
      )) {
        if (event.type === "text.delta") {
          await stream.writeSSE({
            data: JSON.stringify(
              chunk(identity, {
                index: 0,
                delta: { content: event.delta },
                finish_reason: null,
              }),
            ),
          });
        } else if (event.type === "usage") {
          usage = event.usage;
        } else if (event.type === "completed") {
          await stream.writeSSE({
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
          await stream.writeSSE({ data: "[DONE]" });
        } else {
          await stream.writeSSE({
            data: JSON.stringify(openAIErrorBody(event.error)),
          });
          return;
        }
      }
    });
  };
}
