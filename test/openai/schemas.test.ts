import { describe, expect, it } from "vitest";
import { authenticateBearer } from "../../src/http/auth.js";
import { ProxyError, toOpenAIError } from "../../src/http/errors.js";
import { assertRequestSize, MAX_REQUEST_BYTES } from "../../src/http/limits.js";
import {
  parseChatRequest,
  parseResponsesRequest,
} from "../../src/openai/schemas.js";

const chatRequest = {
  model: "gpt-5.4",
  messages: [{ role: "user" as const, content: "hello" }],
};

describe("parseChatRequest", () => {
  it("accepts supported roles, content, tools, and output format", () => {
    const request = {
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
            {
              type: "image_url",
              image_url: {
                url: "data:image/png;base64,iVBORw0KGgo=",
                detail: "auto",
              },
            },
          ],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_external_1",
              type: "function",
              function: { name: "lookup", arguments: '{"id":1}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_external_1", content: "found" },
        { role: "user", content: "continue" },
      ],
      stream: true,
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Look up a record",
            parameters: {
              type: "object",
              properties: { id: { type: "number" } },
            },
          },
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning_effort: "high",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          strict: true,
          schema: { type: "object" },
        },
      },
    };

    expect(parseChatRequest(request)).toEqual(request);
  });

  it("maps an unsupported top-level field to its exact parameter", () => {
    expect(() =>
      parseChatRequest({ ...chatRequest, temperature: 0.2 }),
    ).toThrowError(
      expect.objectContaining({
        code: "unsupported_field",
        param: "temperature",
        status: 400,
      }),
    );
  });

  it("maps an unsupported nested field to its exact parameter", () => {
    expect(() =>
      parseChatRequest({
        ...chatRequest,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              {
                type: "image_url",
                image_url: {
                  url: "data:image/png;base64,iVBORw0KGgo=",
                  extra: true,
                },
              },
            ],
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "unsupported_field",
        param: "messages.0.content.1.image_url.extra",
      }),
    );
  });

  it.each([
    [
      "remote images",
      {
        ...chatRequest,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: "https://example.com/a.png" },
              },
            ],
          },
        ],
      },
      "messages.0.content.0.image_url.url",
    ],
    [
      "file IDs",
      {
        ...chatRequest,
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "file_123" } }],
          },
        ],
      },
      "messages.0.content.0.image_url.url",
    ],
    ["sampling fields", { ...chatRequest, top_p: 0.9 }, "top_p"],
    [
      "forced function selection",
      {
        ...chatRequest,
        tool_choice: { type: "function", function: { name: "lookup" } },
      },
      "tool_choice",
    ],
    [
      "Platform built-in tools",
      {
        ...chatRequest,
        tools: [{ type: "web_search_preview" }],
      },
      "tools.0.type",
    ],
    ["audio", { ...chatRequest, modalities: ["text", "audio"] }, "modalities"],
    [
      "disabled parallel calls",
      {
        ...chatRequest,
        parallel_tool_calls: false,
      },
      "parallel_tool_calls",
    ],
  ])("rejects %s", (_name, request, param) => {
    expect(() => parseChatRequest(request)).toThrowError(
      expect.objectContaining({ status: 400, param }),
    );
  });

  it.each([
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ])("accepts syntactic reasoning effort %s", (reasoning_effort) => {
    expect(
      parseChatRequest({ ...chatRequest, reasoning_effort }).reasoning_effort,
    ).toBe(reasoning_effort);
  });

  it("rejects an unknown reasoning effort", () => {
    expect(() =>
      parseChatRequest({ ...chatRequest, reasoning_effort: "extreme" }),
    ).toThrowError(expect.objectContaining({ param: "reasoning_effort" }));
  });
});

describe("parseResponsesRequest", () => {
  it("retains instructions and supported structured input", () => {
    const request = {
      model: "gpt-5.4",
      instructions: "Answer tersely",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "look" },
            {
              type: "input_image",
              image_url: "data:image/jpeg;base64,/9j/",
              detail: "high",
            },
          ],
        },
        {
          type: "function_call",
          id: "fc_item_1",
          call_id: "call_external_2",
          name: "lookup",
          arguments: '{"id":2}',
        },
        {
          type: "function_call_output",
          id: "fco_item_1",
          call_id: "call_external_2",
          output: "found",
        },
      ],
      stream: false,
      store: true,
      previous_response_id: "resp_previous",
      reasoning: { effort: "minimal" },
      text: {
        format: {
          type: "json_schema",
          name: "answer",
          description: "An answer",
          strict: true,
          schema: { type: "object" },
        },
      },
      tools: [
        {
          type: "function",
          function: { name: "lookup", parameters: { type: "object" } },
        },
      ],
      tool_choice: "none",
      parallel_tool_calls: true,
    };

    expect(parseResponsesRequest(request)).toEqual(request);
  });

  it.each([
    [
      "background mode",
      { model: "gpt-5.4", input: "hi", background: true },
      "background",
    ],
    [
      "remote image",
      {
        model: "gpt-5.4",
        input: [
          {
            role: "user",
            content: [
              { type: "input_image", image_url: "https://example.com/a.png" },
            ],
          },
        ],
      },
      "input.0.content.0.image_url",
    ],
    [
      "file ID",
      {
        model: "gpt-5.4",
        input: [
          {
            role: "user",
            content: [{ type: "input_image", file_id: "file_123" }],
          },
        ],
      },
      "input.0.content.0.file_id",
    ],
    [
      "built-in tool",
      {
        model: "gpt-5.4",
        input: "hi",
        tools: [{ type: "file_search", vector_store_ids: ["vs_1"] }],
      },
      "tools.0.type",
    ],
    [
      "audio",
      { model: "gpt-5.4", input: "hi", modalities: ["audio"] },
      "modalities",
    ],
  ])("rejects %s", (_name, request, param) => {
    expect(() => parseResponsesRequest(request)).toThrowError(
      expect.objectContaining({ status: 400, param }),
    );
  });

  it("rejects store=false with tools", () => {
    expect(() =>
      parseResponsesRequest({
        model: "gpt-5.4",
        input: "hi",
        store: false,
        tools: [
          {
            type: "function",
            function: { name: "lookup", parameters: { type: "object" } },
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "store_required_for_tools",
        param: "store",
        status: 400,
      }),
    );
  });
});

describe("shared HTTP boundary", () => {
  it("authenticates only the exact bearer token without exposing it", () => {
    const token = "s".repeat(32);

    expect(() => authenticateBearer(`Bearer ${token}`, token)).not.toThrow();
    expect(() => authenticateBearer(`Bearer ${token}x`, token)).toThrowError(
      expect.objectContaining({ code: "invalid_api_key", status: 401 }),
    );
    try {
      authenticateBearer(undefined, token);
    } catch (error) {
      expect(String(error)).not.toContain(token);
    }
  });

  it("rejects known oversized requests with the stable body-limit code", () => {
    expect(() => assertRequestSize(MAX_REQUEST_BYTES + 1)).toThrowError(
      expect.objectContaining({
        code: "request_too_large",
        param: null,
        status: 413,
      }),
    );
  });

  it("renders proxy errors and sanitizes unknown errors", async () => {
    const response = toOpenAIError(
      new ProxyError(400, "invalid_request", "Bad field", "model"),
      "req_123",
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBe("req_123");
    expect(await response.json()).toEqual({
      error: {
        message: "Bad field",
        type: "invalid_request_error",
        param: "model",
        code: "invalid_request",
      },
    });

    const secret = "Bearer secret-token /data/codex/auth.json";
    const unknown = toOpenAIError(new Error(secret), "req_456");
    expect(unknown.status).toBe(500);
    expect(JSON.stringify(await unknown.json())).not.toContain(secret);
    expect(unknown.headers.get("x-request-id")).toBe("req_456");

    const upstream = toOpenAIError(
      new ProxyError(502, "upstream_protocol_error", secret),
      "req_789",
    );
    expect(JSON.stringify(await upstream.json())).not.toContain(secret);
  });
});
