import { describe, expect, it } from "vitest";
import { agentBinaryAvailable, runAgentSmoke } from "./agent-fixture.js";

describe("agent-client smoke contracts", () => {
  for (const agent of ["opencode", "hermes"] as const) {
    const available = agentBinaryAvailable(agent);
    const required = process.env.REQUIRE_EXTERNAL_AGENTS === "1";
    if (!available && required) {
      it(`${agent} external binary is installed`, () => {
        throw new Error(
          `${agent} binary is required when REQUIRE_EXTERNAL_AGENTS=1`,
        );
      });
      continue;
    }
    const test = available ? it : it.skip;
    test(available
      ? `${agent} executes a client-side function loop`
      : `${agent} unavailable: external binary not found on PATH`, async () => {
      const result = await runAgentSmoke(agent);
      expect(result).toMatchObject({
        availability: "passed",
        clientToolCalls: 1,
        internalCodexToolEvents: 0,
      });
    }, 120_000);
  }
});
