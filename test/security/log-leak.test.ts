import { describe, expect, it } from "vitest";
import { exerciseSecretLogContract } from "./log-leak-fixture.js";

describe("secret-free process logs", () => {
  it("emits zero prompt, image, tool, auth, token, event, or credential-path matches", async () => {
    const result = await exerciseSecretLogContract();

    expect(result.matches).toEqual([]);
    expect(result.logs).not.toContain(result.requestBody);
    expect(result.childClosed).toBe(true);
    for (const sentinel of result.upstreamSentinels) {
      expect(result.logs).not.toContain(sentinel);
    }
  });
});
