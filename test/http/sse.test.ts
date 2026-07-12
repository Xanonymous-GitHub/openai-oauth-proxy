import { describe, expect, it } from "vitest";
import { encodeSSE, encodeSSEDone } from "../../src/http/sse.js";

describe("SSE encoding", () => {
  it("encodes unnamed Chat data and omits undefined object fields", () => {
    expect(
      encodeSSE({ id: "chatcmpl_1", optional: undefined, delta: "hello" }),
    ).toBe('data: {"id":"chatcmpl_1","delta":"hello"}\n\n');
  });

  it("encodes a named Responses event", () => {
    expect(
      encodeSSE(
        { type: "response.output_text.delta", delta: "hello" },
        "response.output_text.delta",
      ),
    ).toBe(
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n',
    );
  });

  it("keeps CR and LF inside serialized data instead of creating SSE fields", () => {
    expect(encodeSSE({ delta: "first\r\nsecond\nthird" })).toBe(
      'data: {"delta":"first\\r\\nsecond\\nthird"}\n\n',
    );
  });

  it("rejects event names that could inject SSE fields", () => {
    expect(() => encodeSSE({}, "safe\nevent: injected")).toThrow(
      "SSE event names cannot contain CR or LF",
    );
  });

  it("encodes the Chat completion sentinel without JSON quotes", () => {
    expect(encodeSSEDone()).toBe("data: [DONE]\n\n");
  });
});
