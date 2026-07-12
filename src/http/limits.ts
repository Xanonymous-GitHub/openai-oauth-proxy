import { ProxyError } from "./errors.js";

const MEBIBYTE = 1024 * 1024;

export const MAX_REQUEST_BYTES = 32 * MEBIBYTE;
export const MAX_IMAGE_BYTES = 10 * MEBIBYTE;
export const MAX_TOTAL_IMAGE_BYTES = 24 * MEBIBYTE;
export const MAX_IMAGES = 8;

export function assertRequestSize(encodedBytes: number): void {
  if (encodedBytes > MAX_REQUEST_BYTES) {
    throw ProxyError.public(
      413,
      "request_too_large",
      "Request body exceeds the 32 MiB limit",
    );
  }
}

function contentLength(request: Request): number | undefined {
  const value = request.headers.get("content-length");
  if (value === null) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw ProxyError.public(
      400,
      "invalid_content_length",
      "Content-Length must be a non-negative integer",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw ProxyError.public(
      400,
      "invalid_content_length",
      "Content-Length must be a non-negative integer",
    );
  }
  return parsed;
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const declaredLength = contentLength(request);
  if (declaredLength !== undefined) assertRequestSize(declaredLength);

  const source = request.body;
  if (source === null) return new Response().json();
  const reader = source.getReader();
  let encodedBytes = 0;
  const counted = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        encodedBytes += next.value.byteLength;
        if (encodedBytes > MAX_REQUEST_BYTES) {
          const error = ProxyError.public(
            413,
            "request_too_large",
            "Request body exceeds the 32 MiB limit",
          );
          void reader.cancel(error).catch(() => undefined);
          controller.error(error);
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(counted).json();
}
