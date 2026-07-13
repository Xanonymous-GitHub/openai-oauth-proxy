import type { AccountState } from "../codex/account.js";
import type { PlanType } from "../codex/generated/PlanType.js";

const PLAN_TYPES: ReadonlySet<string> = new Set<PlanType>([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_usage_based",
  "business",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "unknown",
]);

export interface AdminResponse {
  state: AccountState;
  csrfToken: string;
  error?: "authentication_required";
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function accountState(value: unknown): AccountState | null {
  if (!record(value) || typeof value.type !== "string") return null;
  if (value.type === "checking" || value.type === "signed_out") {
    return { type: value.type };
  }
  if (
    value.type === "ready" &&
    (typeof value.email === "string" || value.email === null) &&
    typeof value.planType === "string" &&
    PLAN_TYPES.has(value.planType)
  ) {
    return {
      type: value.type,
      email: value.email,
      planType: value.planType as PlanType,
    };
  }
  if (
    value.type === "login_pending" &&
    typeof value.loginId === "string" &&
    typeof value.verificationUrl === "string" &&
    typeof value.userCode === "string"
  ) {
    return {
      type: value.type,
      loginId: value.loginId,
      verificationUrl: value.verificationUrl,
      userCode: value.userCode,
    };
  }
  if (value.type === "error" && value.code === "authentication_required") {
    return { type: value.type, code: value.code };
  }
  return null;
}

export function parseAdminResponse(value: unknown): AdminResponse | null {
  if (!record(value) || typeof value.csrfToken !== "string") return null;
  if (
    value.error !== undefined &&
    value.error !== "authentication_required"
  ) {
    return null;
  }
  const state = accountState(value.state);
  if (!state) return null;
  return value.error === "authentication_required"
    ? { state, csrfToken: value.csrfToken, error: value.error }
    : { state, csrfToken: value.csrfToken };
}
