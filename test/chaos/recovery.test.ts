import { describe, expect, it } from "vitest";
import { runRecoveryContract } from "./recovery-fixture.js";

describe("process recovery", () => {
  it("fails active work, removes readiness, recovers, and preserves opaque state", async () => {
    const result = await runRecoveryContract();

    expect(result.activeRequestFailed).toBe(true);
    expect(result.readinessRemoved).toBe(true);
    expect(result.recoveredWithinMs).toBeLessThanOrEqual(35_000);
    expect(result.storedThreadResumed).toBe(true);
    expect(result.toolContinuationCode).toBe("proxy_continuation_lost");
    expect(result.sqlitePreserved).toBe(true);
    expect(result.credentialFilePreserved).toBe(true);
    expect(result.credentialContentRead).toBe(false);
    expect(result.proxyStarts).toBe(2);
  });
});
