export interface OpenAIErrorBody {
  error: {
    message: string;
    type: "invalid_request_error" | "authentication_error" | "server_error";
    param: string | null;
    code: string;
  };
}

export class ProxyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly param: string | null = null,
  ) {
    super(message);
    this.name = "ProxyError";
  }
}

function errorType(status: number): OpenAIErrorBody["error"]["type"] {
  if (status === 401) return "authentication_error";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
}

function publicMessage(error: ProxyError): string {
  if (error.status < 500) return error.message;
  if (error.status === 502) return "Upstream service error";
  if (error.status === 503) return "Service unavailable";
  if (error.status === 504) return "Request timed out";
  return "Internal server error";
}

export function toOpenAIError(error: unknown, requestId: string): Response {
  const proxyError =
    error instanceof ProxyError
      ? error
      : new ProxyError(500, "internal_error", "Internal server error");
  const body: OpenAIErrorBody = {
    error: {
      message: publicMessage(proxyError),
      type: errorType(proxyError.status),
      param: proxyError.param,
      code: proxyError.code,
    },
  };

  return new Response(JSON.stringify(body), {
    status: proxyError.status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "x-request-id": requestId,
    },
  });
}
