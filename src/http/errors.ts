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
    readonly isPublic = false,
  ) {
    super(message);
    this.name = "ProxyError";
  }

  static public(
    status: number,
    code: string,
    message: string,
    param: string | null = null,
  ): ProxyError {
    return new ProxyError(status, code, message, param, true);
  }
}

function errorType(status: number): OpenAIErrorBody["error"]["type"] {
  if (status === 401) return "authentication_error";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
}

function publicMessage(error: ProxyError): string {
  if (error.isPublic) return error.message;
  if (error.status === 400) return "Invalid request";
  if (error.status === 401) return "Authentication failed";
  if (error.status === 404) return "Resource not found";
  if (error.status === 409) return "Request conflict";
  if (error.status === 413) return "Request too large";
  if (error.status === 429) return "Rate limit exceeded";
  if (error.status === 502) return "Upstream service error";
  if (error.status === 503) return "Service unavailable";
  if (error.status === 504) return "Request timed out";
  return "Internal server error";
}

export function toOpenAIError(error: unknown, requestId: string): Response {
  const body = openAIErrorBody(error);

  return new Response(JSON.stringify(body), {
    status: error instanceof ProxyError ? error.status : 500,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "x-request-id": requestId,
    },
  });
}

export function openAIErrorBody(error: unknown): OpenAIErrorBody {
  const proxyError =
    error instanceof ProxyError
      ? error
      : new ProxyError(500, "internal_error", "Internal server error");
  return {
    error: {
      message: publicMessage(proxyError),
      type: errorType(proxyError.status),
      param: proxyError.isPublic ? proxyError.param : null,
      code: proxyError.code,
    },
  };
}
