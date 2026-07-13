import { describe, expect, it } from "vitest";
import {
  runRealAppServerContract,
  validateCapturedFrames,
} from "./real-app-server-fixture.js";

describe("pinned real Codex App Server offline contract", () => {
  it("matches generated messages and completes fixture-provider lifecycle", async () => {
    const result = await runRealAppServerContract();

    expect(result.codexVersion).toBe("0.144.1");
    expect(result.methods).toEqual(
      expect.arrayContaining([
        "initialize",
        "model/list",
        "thread/start",
        "thread/resume",
        "thread/fork",
        "thread/inject_items",
        "thread/delete",
        "turn/start",
        "turn/interrupt",
        "item/tool/call",
      ]),
    );
    expect(result.text).toBe("fixture response");
    expect(result.cancelled).toBe(true);
    expect(result.dynamicToolResult).toBe("fixture tool result");
    expect(result.toolOutputForwarded).toBe(true);
    expect(result.frameCounts).toMatchObject({
      requests: expect.any(Number),
      responses: expect.any(Number),
      notifications: expect.any(Number),
    });
    expect(result.frameCounts.requests).toBeGreaterThan(8);
    expect(result.frameCounts.responses).toBeGreaterThan(8);
    expect(result.frameCounts.notifications).toBeGreaterThan(8);
    expect(result.schemaErrors).toEqual([]);
  });

  it("reports schema failures without echoing captured fixture data", () => {
    const sentinel = "RAW_FRAME_SECRET_SENTINEL";
    expect(() =>
      validateCapturedFrames({
        client: [{ id: 1, method: "thread/start", params: sentinel }],
        server: [],
      }),
    ).toThrowError(/client request thread\/start/i);
    try {
      validateCapturedFrames({
        client: [{ id: 1, method: "thread/start", params: sentinel }],
        server: [],
      });
    } catch (error) {
      expect(String(error)).not.toContain(sentinel);
    }
  });

  it("validates client responses against the originating server request", () => {
    expect(() =>
      validateCapturedFrames({
        server: [
          {
            id: "tool-1",
            method: "item/tool/call",
            params: {
              arguments: {},
              callId: "call-1",
              threadId: "thread-1",
              tool: "fixture_tool",
              turnId: "turn-1",
            },
          },
        ],
        client: [{ id: "tool-1", result: { success: true } }],
      }),
    ).toThrowError(/client response item\/tool\/call .*required/i);
  });
});
