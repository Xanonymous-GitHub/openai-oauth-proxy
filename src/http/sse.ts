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
