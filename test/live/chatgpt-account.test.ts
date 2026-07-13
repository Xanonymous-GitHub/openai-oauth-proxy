import { describe, expect, it } from "vitest";
import { runLiveAccountContract } from "./live-account-fixture.js";

const enabled = process.env.LIVE_CHATGPT_TESTS === "1";
const codexHome = process.env.LIVE_CHATGPT_CODEX_HOME;
const live = enabled && codexHome ? describe.sequential : describe.skip;

live("live ChatGPT account (consumes subscription capacity)", () => {
  it("refreshes account state, lists models, runs text, and checks device schema", async () => {
    const result = await runLiveAccountContract(codexHome as string);
    expect(result.accountType).toBe("chatgpt");
    expect(result.models).toBeGreaterThan(0);
    expect(result.text).not.toBe("");
    expect(result.deviceLoginType).toBe("chatgptDeviceCode");
  });
});

if (enabled && !codexHome) {
  it("requires LIVE_CHATGPT_CODEX_HOME when live tests are enabled", () => {
    throw new Error(
      "LIVE_CHATGPT_CODEX_HOME must point to a pre-authenticated CODEX_HOME",
    );
  });
}
