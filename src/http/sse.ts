export function encodeSSE(data: unknown, event?: string): string {
  if (event && /[\r\n]/.test(event)) {
    throw new TypeError("SSE event names cannot contain CR or LF");
  }
  const serialized = JSON.stringify(data);
  if (serialized === undefined) {
    throw new TypeError("SSE data must be JSON serializable");
  }
  return `${event ? `event: ${event}\n` : ""}data: ${serialized}\n\n`;
}

export function encodeSSEDone(): string {
  return "data: [DONE]\n\n";
}

interface AbortableSSEWriter<T> {
  writeSSE(event: T): Promise<void>;
  abort?(): void;
}

export async function writeSSEWithSignal<T>(
  stream: AbortableSSEWriter<T>,
  event: T,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    try {
      stream.abort?.();
    } catch {}
    rejectAbort(
      signal.reason ?? new DOMException("Request aborted", "AbortError"),
    );
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    await Promise.race([stream.writeSSE(event), aborted]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
