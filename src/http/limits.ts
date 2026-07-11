import { ProxyError } from "./errors.js";

const MEBIBYTE = 1024 * 1024;

export const MAX_REQUEST_BYTES = 32 * MEBIBYTE;
export const MAX_IMAGE_BYTES = 10 * MEBIBYTE;
export const MAX_TOTAL_IMAGE_BYTES = 24 * MEBIBYTE;
export const MAX_IMAGES = 8;

export function assertRequestSize(encodedBytes: number): void {
  if (encodedBytes > MAX_REQUEST_BYTES) {
    throw new ProxyError(
      413,
      "request_too_large",
      "Request body exceeds the 32 MiB limit",
    );
  }
}
