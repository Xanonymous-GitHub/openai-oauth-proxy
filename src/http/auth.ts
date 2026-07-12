import { timingSafeEqual } from "node:crypto";
import { ProxyError } from "./errors.js";

export function authenticateBearer(
  authorization: string | undefined,
  expectedToken: string,
): void {
  const prefix = "Bearer ";
  const suppliedToken = authorization?.startsWith(prefix)
    ? authorization.slice(prefix.length)
    : "";
  const supplied = Buffer.from(suppliedToken);
  const expected = Buffer.from(expectedToken);

  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw ProxyError.public(
      401,
      "invalid_api_key",
      "Missing or invalid bearer token",
    );
  }
}
