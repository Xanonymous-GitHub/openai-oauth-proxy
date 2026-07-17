import { describe, expect, it } from "vitest";
import {
  parseChatRequest,
  parseResponsesRequest,
} from "../../src/openai/schemas.js";
import {
  translateHistory,
  translateTurnInput,
} from "../../src/openai/translate.js";

describe("OpenAI input translation", () => {
  it("preserves message order, roles, parts, and external Chat call IDs", () => {
    const imageUrl = "data:image/png;base64,iVBORw0KGgo=";
    const { messages } = parseChatRequest({
      model: "gpt-5.4",
      messages: [
        { role: "system", content: "system" },
        {
          role: "developer",
          content: [{ type: "text", text: "developer" }],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
        {
          role: "assistant",
          content: "calling",
          tool_calls: [
            {
              id: "call_external_exact",
              type: "function",
              function: { name: "lookup", arguments: '{"id":1}' },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_external_exact",
          content: "found",
        },
        { role: "user", content: "final" },
      ],
    });

    expect(translateHistory(messages.slice(0, -1))).toEqual([
      {
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: "system" }],
      },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "developer" }],
      },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "look" },
          { type: "input_image", image_url: imageUrl },
        ],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "calling" }],
      },
      {
        type: "function_call",
        call_id: "call_external_exact",
        name: "lookup",
        arguments: '{"id":1}',
      },
      {
        type: "function_call_output",
        call_id: "call_external_exact",
        output: "found",
      },
    ]);
  });

  it("turns final user text and images into Codex UserInput", () => {
    const imageUrl = "data:image/webp;base64,UklGRgAAAABXRUJQ";

    expect(
      translateTurnInput([
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: imageUrl, detail: "low" } },
      ]),
    ).toEqual([
      { type: "text", text: "look", text_elements: [] },
      { type: "image", url: imageUrl, detail: "low" },
    ]);
  });

  it("preserves Responses item IDs and external call IDs", () => {
    const request = parseResponsesRequest({
      model: "gpt-5.4",
      input: [
        {
          id: "msg_exact",
          type: "message",
          role: "assistant",
          status: "completed",
          phase: "commentary",
          content: [
            {
              type: "output_text",
              text: "calling",
              annotations: [],
            },
          ],
        },
        {
          type: "function_call",
          id: "fc_item_exact",
          call_id: "call_external_exact",
          name: "lookup",
          arguments: '{"id":1}',
        },
        {
          type: "function_call_output",
          id: "fco_item_exact",
          call_id: "call_external_exact",
          output: "found",
        },
      ],
    });

    if (typeof request.input === "string") throw new Error("expected items");
    expect(translateHistory(request.input)).toEqual([
      {
        type: "message",
        id: "msg_exact",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "calling" }],
      },
      {
        type: "function_call",
        id: "fc_item_exact",
        call_id: "call_external_exact",
        name: "lookup",
        arguments: '{"id":1}',
      },
      {
        type: "function_call_output",
        id: "fco_item_exact",
        call_id: "call_external_exact",
        output: "found",
      },
    ]);
  });

  it("translates Responses final input content", () => {
    const imageUrl = "data:image/jpeg;base64,/9j/";
    expect(
      translateTurnInput([
        { type: "input_text", text: "look" },
        { type: "input_image", image_url: imageUrl },
      ]),
    ).toEqual([
      { type: "text", text: "look", text_elements: [] },
      { type: "image", url: imageUrl },
    ]);
  });
});
