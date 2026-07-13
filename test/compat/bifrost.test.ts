import { describe, expect, it } from "vitest";
import { BIFROST_IMAGE, runBifrostContract } from "./bifrost-fixture.js";

describe("real Bifrost compatibility", () => {
  it("pins a stable multiarch digest and forwards the OpenAI contract", async () => {
    expect(BIFROST_IMAGE).toMatch(
      /^maximhq\/bifrost:v\d+\.\d+\.\d+@sha256:[a-f0-9]{64}$/,
    );
    const result = await runBifrostContract();
    expect(result.availability).toBe("passed");
    expect(result.configSource).toBe("deploy/bifrost/config.example.json");
    expect(result.forwardedModel).toBe("gpt-5.4");
    expect(result.authorizationForwarded).toBe(true);
    expect(result.upstreamPaths).toEqual([
      "/v1/chat/completions",
      "/v1/chat/completions",
      "/v1/chat/completions",
      "/v1/chat/completions",
      "/v1/chat/completions",
    ]);
    expect(result.streaming).toBe(true);
    expect(result.tools).toBe(true);
    expect(result.error).toEqual({
      status: 500,
      type: "server_error",
      code: "upstream_error",
      message: "500 Fixture upstream error",
    });
    expect(result.rateLimit).toEqual({
      status: 429,
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
      message: "429 Fixture rate limit",
    });
    expect(result.imagePlatforms).toEqual(["linux/amd64", "linux/arm64"]);
  }, 120_000);
});
