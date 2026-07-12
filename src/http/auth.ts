import { createHash, timingSafeEqual } from "node:crypto";
import { ProxyError } from "./errors.js";

export function authenticateBearer(
  authorization: string | undefined,
  expectedToken: string,
): void {
  const prefix = "Bearer ";
  const suppliedToken = authorization?.startsWith(prefix)
    ? authorization.slice(prefix.length)
    : "";
  const supplied = createHash("sha256").update(suppliedToken).digest();
  const expected = createHash("sha256").update(expectedToken).digest();

  if (!timingSafeEqual(supplied, expected)) {
    throw ProxyError.public(
      401,
      "invalid_api_key",
      "Missing or invalid bearer token",
    );
  }
}
