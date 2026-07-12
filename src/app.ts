import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { CodexHost } from "./codex/host.js";
import { authenticateBearer } from "./http/auth.js";
import { ProxyError, toOpenAIError } from "./http/errors.js";
import {
  type ChatHandlerDependencies,
  createChatHandler,
} from "./openai/chat.js";
import { ModelCatalog } from "./openai/models.js";
import {
  createResponsesHandler,
  type ResponsesHandlerDependencies,
} from "./openai/responses.js";

export interface DataAppDependencies {
  health(): boolean;
  ready(): boolean;
  draining(): boolean;
  bifrostToken: string;
  metricsToken: string;
  host: Pick<CodexHost, "generation" | "modelList">;
  chat?: Omit<ChatHandlerDependencies, "models">;
  responses?: Omit<ResponsesHandlerDependencies, "models">;
}

export function createDataApp(deps: DataAppDependencies): Hono {
  const app = new Hono();
  const models = new ModelCatalog(deps.host);

  app.onError((error, context) =>
    toOpenAIError(
      error,
      context.req.header("x-request-id") ?? `req_${randomUUID()}`,
    ),
  );
  app.use("/v1/*", async (context, next) => {
    authenticateBearer(context.req.header("authorization"), deps.bifrostToken);
    await next();
  });
  app.use("/metrics", async (context, next) => {
    authenticateBearer(context.req.header("authorization"), deps.metricsToken);
    await next();
  });

  app.get("/healthz", (context) =>
    deps.health() && !deps.draining()
      ? context.body(null, 200)
      : context.body(null, 500),
  );
  app.get("/readyz", (context) =>
    deps.ready() && !deps.draining()
      ? context.body(null, 200)
      : context.body(null, 503),
  );
  app.get("/v1/models", async (context) => {
    try {
      return context.json(await models.list(context.req.raw.signal));
    } catch {
      throw new ProxyError(
        503,
        "codex_unavailable",
        "Codex model catalog unavailable",
      );
    }
  });
  if (deps.chat) {
    app.post(
      "/v1/chat/completions",
      createChatHandler({ models, ...deps.chat }),
    );
  }
  if (deps.responses) {
    app.post(
      "/v1/responses",
      createResponsesHandler({ models, ...deps.responses }),
    );
  }
  app.all("/v1/*", (context) =>
    context.json(
      {
        error: {
          message: "Unsupported endpoint",
          type: "invalid_request_error",
          param: null,
          code: "unsupported_endpoint",
        },
      },
      404,
    ),
  );

  return app;
}
