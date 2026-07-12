import { describe, expect, it, vi } from "vitest";
import { createLogger, type LogEvent } from "../../src/operations/log.js";

describe("structured logger", () => {
  it("serializes only the compile-time whitelist", () => {
    const write = vi.fn();
    const log = createLogger(write);
    const secrets = {
      prompt: "private prompt",
      image: "data:image/png;base64,private-image",
      toolArguments: "private arguments",
      toolResult: "private result",
      authorization: "Bearer private-authorization",
      rawEvent: "private raw event",
      accessToken: "access-token-private",
      refreshToken: "refresh-token-private",
      idToken: "id-token-private",
    };
    const event = {
      requestId: "req_safe",
      route: "responses",
      model: "gpt-safe",
      status: 502,
      durationMs: 12,
      errorCode: "codex_host_error",
      streamOutcome: "failed",
      queueOutcome: "admitted",
      leaseOutcome: "released",
      processGeneration: 4,
      restartReason: "crash",
      ...secrets,
    } as unknown as LogEvent;

    log(event);

    expect(write).toHaveBeenCalledOnce();
    const output = String(write.mock.calls[0]?.[0]);
    expect(JSON.parse(output)).toEqual({
      requestId: "req_safe",
      route: "responses",
      model: "gpt-safe",
      status: 502,
      durationMs: 12,
      errorCode: "codex_host_error",
      streamOutcome: "failed",
      queueOutcome: "admitted",
      leaseOutcome: "released",
      processGeneration: 4,
      restartReason: "crash",
    });
    for (const secret of Object.values(secrets)) {
      expect(output).not.toContain(secret);
    }
  });

  it("does not allow request bodies in the logger type", () => {
    const event: LogEvent = {
      requestId: "req_safe",
      route: "chat",
      status: 200,
      durationMs: 1,
      // @ts-expect-error request bodies are intentionally not loggable
      body: { messages: [{ content: "secret" }] },
    };
    expect(event.requestId).toBe("req_safe");
  });
});
