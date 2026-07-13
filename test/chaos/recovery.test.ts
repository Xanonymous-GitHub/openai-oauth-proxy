import { describe, expect, it } from "vitest";
import { runRecoveryContract } from "./recovery-fixture.js";

describe("process recovery", () => {
  it("fails active work, removes readiness, recovers, and preserves opaque state", async () => {
    const result = await runRecoveryContract();

    expect(result.activeRequestFailed).toBe(true);
    expect(result.streamedDeltaBeforeCrash).toBe(true);
    expect(result.readinessRemoved).toBe(true);
    expect(result.recoveredWithinMs).toBeLessThanOrEqual(35_000);
    expect(result.storedThreadResumed).toBe(true);
    expect(result.toolContinuationCode).toBe("proxy_continuation_lost");
    expect(result.sqlitePreserved).toBe(true);
    expect(result.credentialFilePreserved).toBe(true);
    expect(result.credentialContentRead).toBe(false);
    expect(result.proxyStarts).toBe(2);
  }, 120_000);

  it("closes a started proxy child when an intermediate check fails", async () => {
    let childPid: number | undefined;
    await expect(
      runRecoveryContract({
        afterFirstProxyStart(pid) {
          childPid = pid;
          throw new Error("induced intermediate failure");
        },
      }),
    ).rejects.toThrow("induced intermediate failure");

    expect(childPid).toBeDefined();
    expect(() => process.kill(childPid as number, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
  }, 120_000);
});
