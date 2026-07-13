import { describe, expect, it } from "vitest";
import { runRealAppServerContract } from "./real-app-server-fixture.js";

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
    expect(result.schemaErrors).toEqual([]);
  });
});
