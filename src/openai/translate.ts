import type { ResponseItem } from "../codex/generated/ResponseItem.js";
import type { UserInput } from "../codex/generated/v2/UserInput.js";
import type {
  ChatMessage,
  ChatUserContent,
  ResponsesInputItem,
  ResponsesMessageContent,
} from "./schemas.js";

type HistoryItem = ChatMessage | ResponsesInputItem;
type TurnInput = ChatUserContent | ResponsesMessageContent;
type ResponseContent = Extract<
  ResponseItem,
  { type: "message" }
>["content"][number];

function messageContent(
  role: "system" | "developer" | "user" | "assistant",
  content:
    | Exclude<ChatMessage, { role: "tool" }>["content"]
    | ResponsesMessageContent,
): Extract<ResponseItem, { type: "message" }>["content"] {
  if (typeof content === "string") {
    return [
      role === "assistant"
        ? { type: "output_text", text: content }
        : { type: "input_text", text: content },
    ];
  }
  if (content == null) return [];

  return content.map((part): ResponseContent => {
    if (part.type === "text" || part.type === "input_text") {
      return { type: "input_text", text: part.text };
    }
    if (part.type === "output_text") {
      return { type: "output_text", text: part.text };
    }
    if (part.type === "image_url") {
      return {
        type: "input_image",
        image_url: part.image_url.url,
        ...(part.image_url.detail === undefined
          ? {}
          : { detail: part.image_url.detail }),
      };
    }
    return {
      type: "input_image",
      image_url: part.image_url,
      ...(part.detail === undefined ? {} : { detail: part.detail }),
    };
  });
}

export function translateHistory(
  messages: readonly HistoryItem[],
): ResponseItem[] {
  const translated: ResponseItem[] = [];

  for (const message of messages) {
    if ("role" in message) {
      if (message.role === "tool") {
        translated.push({
          type: "function_call_output",
          call_id: message.tool_call_id,
          output: message.content,
        });
        continue;
      }

      const content = messageContent(message.role, message.content);
      if (content.length > 0) {
        translated.push({ type: "message", role: message.role, content });
      }
      if (message.role === "assistant" && "tool_calls" in message) {
        for (const call of message.tool_calls ?? []) {
          translated.push({
            type: "function_call",
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          });
        }
      }
      continue;
    }

    if (message.type === "function_call") {
      translated.push({
        type: "function_call",
        ...(message.id === undefined ? {} : { id: message.id }),
        call_id: message.call_id,
        name: message.name,
        arguments: message.arguments,
      });
    } else {
      translated.push({
        type: "function_call_output",
        ...(message.id === undefined ? {} : { id: message.id }),
        call_id: message.call_id,
        output: message.output,
      });
    }
  }

  return translated;
}

export function translateTurnInput(input: TurnInput): UserInput[] {
  if (typeof input === "string") {
    return [{ type: "text", text: input, text_elements: [] }];
  }

  return input.map((part): UserInput => {
    if (part.type === "text" || part.type === "input_text") {
      return { type: "text", text: part.text, text_elements: [] };
    }
    if (part.type === "output_text") {
      return { type: "text", text: part.text, text_elements: [] };
    }
    if (part.type === "image_url") {
      return {
        type: "image",
        url: part.image_url.url,
        ...(part.image_url.detail === undefined
          ? {}
          : { detail: part.image_url.detail }),
      };
    }
    return {
      type: "image",
      url: part.image_url,
      ...(part.detail === undefined ? {} : { detail: part.detail }),
    };
  });
}
