import { describe, expect, it, vi } from "vitest";
import { MAX_REQUEST_BYTES, readJsonBody } from "../../src/http/limits.js";

function streamingRequest(
  chunks: Uint8Array[],
  headers?: Record<string, string>,
): {
  pulls: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  request: Request;
} {
  const pulls = vi.fn();
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls();
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const request = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return { pulls, cancel, request };
}

describe("readJsonBody", () => {
  it("rejects an oversized Content-Length before reading the body", async () => {
    const fixture = streamingRequest([new TextEncoder().encode("{}")], {
      "content-length": String(MAX_REQUEST_BYTES + 1),
    });

    await expect(readJsonBody(fixture.request)).rejects.toMatchObject({
      status: 413,
      code: "request_too_large",
    });
    expect(fixture.pulls).not.toHaveBeenCalled();
  });

  it.each([
    "-1",
    "+1",
    "1.5",
    "1, 2",
  ])("rejects malformed Content-Length %j before reading the body", async (contentLength) => {
    const fixture = streamingRequest([new TextEncoder().encode("{}")], {
      "content-length": contentLength,
    });

    await expect(readJsonBody(fixture.request)).rejects.toMatchObject({
      status: 400,
      code: "invalid_content_length",
    });
    expect(fixture.pulls).not.toHaveBeenCalled();
  });

  it("cancels a chunked body as soon as byte 32 MiB plus one arrives", async () => {
    const fixture = streamingRequest([
      new Uint8Array(MAX_REQUEST_BYTES),
      new Uint8Array([0x7b]),
    ]);

    await expect(readJsonBody(fixture.request)).rejects.toMatchObject({
      status: 413,
      code: "request_too_large",
    });
    expect(fixture.cancel).toHaveBeenCalledOnce();
    expect(fixture.pulls).toHaveBeenCalledTimes(2);
  });

  it("preserves the 413 when cancelling the oversized source rejects", async () => {
    const fixture = streamingRequest([
      new Uint8Array(MAX_REQUEST_BYTES),
      new Uint8Array([0x7b]),
    ]);
    fixture.cancel.mockRejectedValueOnce(new Error("cancel failed"));

    await expect(readJsonBody(fixture.request)).rejects.toMatchObject({
      status: 413,
      code: "request_too_large",
    });
  });

  it("parses an in-limit body through the counting stream", async () => {
    const fixture = streamingRequest([new TextEncoder().encode('{"ok":true}')]);

    await expect(readJsonBody(fixture.request)).resolves.toEqual({ ok: true });
    expect(fixture.cancel).not.toHaveBeenCalled();
  });
});
