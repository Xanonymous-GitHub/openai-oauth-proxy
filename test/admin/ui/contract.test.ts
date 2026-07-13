import { describe, expect, it } from "vitest";
import { parseAdminResponse } from "../../../src/admin/contract.js";

const csrfToken = "c".repeat(43);

describe("parseAdminResponse", () => {
  it.each([
    { type: "checking" },
    { type: "signed_out" },
    { type: "ready", email: null, planType: "plus" },
    {
      type: "login_pending",
      loginId: "login-1",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    },
    { type: "error", code: "authentication_required" },
  ])("accepts account state $type", (state) => {
    expect(parseAdminResponse({ state, csrfToken })).toEqual({
      state,
      csrfToken,
    });
  });

  it("accepts only the sanitized optional error", () => {
    expect(
      parseAdminResponse({
        state: { type: "signed_out" },
        csrfToken,
        error: "authentication_required",
      }),
    ).toMatchObject({ error: "authentication_required" });
    expect(
      parseAdminResponse({
        state: { type: "signed_out" },
        csrfToken,
        error: "refresh-token leaked",
      }),
    ).toBeNull();
  });

  it.each([
    null,
    {},
    { state: { type: "unknown" }, csrfToken },
    { state: { type: "ready", email: 7, planType: "plus" }, csrfToken },
    { state: { type: "ready", email: null, planType: "invalid" }, csrfToken },
    { state: { type: "login_pending" }, csrfToken },
    { state: { type: "signed_out" }, csrfToken: 42 },
  ])("rejects malformed payload %#", (payload) => {
    expect(parseAdminResponse(payload)).toBeNull();
  });
});
