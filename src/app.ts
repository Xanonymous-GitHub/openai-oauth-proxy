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
import type { TurnCapacity } from "./operations/capacity.js";
import type { Logger } from "./operations/log.js";
import { type MetricRoute, Metrics } from "./operations/metrics.js";

export interface DataAppDependencies {
  health(): boolean;
  ready(): boolean;
  accountReady(): boolean;
  draining(): boolean;
  bifrostToken: string;
  metricsToken: string;
  capacity?: TurnCapacity;
  metrics?: Metrics;
  logger?: Logger;
  busyThreads?(): number;
  pendingTools?(): number;
  expiredTools?(): number;
  processGeneration?(): number | undefined;
  host: Pick<CodexHost, "generation" | "modelList">;
  chat?: Omit<ChatHandlerDependencies, "models">;
  responses?: Omit<ResponsesHandlerDependencies, "models">;
}

export function createDataApp(deps: DataAppDependencies) {
  const app = new Hono<{
    Variables: { errorCode?: string; requestId: string };
  }>();
  const models = new ModelCatalog(deps.host);
  const metrics = deps.metrics ?? new Metrics();

  const routeFor = (path: string): MetricRoute | undefined => {
    if (path === "/v1/models") return "models";
    if (path === "/v1/chat/completions") return "chat";
    if (path === "/v1/responses") return "responses";
    if (path === "/metrics") return "metrics";
    return undefined;
  };

  app.use("*", async (context, next) => {
    const supplied = context.req.header("x-request-id");
    const requestId =
      supplied !== undefined && /^[A-Za-z0-9_-]{1,128}$/.test(supplied)
        ? supplied
        : `req_${randomUUID()}`;
    const startedAt = performance.now();
    context.set("requestId", requestId);
    context.req.raw.headers.set("x-request-id", requestId);
    await next();
    context.res.headers.set("x-request-id", requestId);

    const route = routeFor(context.req.path);
    if (route !== undefined) {
      const durationMs = performance.now() - startedAt;
      metrics.recordRequest(
        route,
        context.res.status,
        durationMs / 1_000,
        context.get("errorCode"),
      );
      deps.logger?.({
        requestId,
        route,
        status: context.res.status,
        durationMs,
      });
    }
  });

  app.onError((error, context) => {
    if (error instanceof ProxyError) context.set("errorCode", error.code);
    return toOpenAIError(
      error,
      context.get("requestId") ?? `req_${randomUUID()}`,
    );
  });
  app.use("/v1/*", async (context, next) => {
    authenticateBearer(context.req.header("authorization"), deps.bifrostToken);
    if (!deps.ready() || !deps.accountReady()) {
      throw new ProxyError(
        503,
        "authentication_required",
        "Authentication required",
      );
    }
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
    deps.ready() && deps.accountReady() && !deps.draining()
      ? context.body(null, 200)
      : context.body(null, 503),
  );
  app.get("/metrics", (context) => {
    metrics.setActiveTurns(deps.capacity?.active ?? 0);
    metrics.setQueueDepth(deps.capacity?.queued ?? 0);
    metrics.setBusyThreads(deps.busyThreads?.() ?? 0);
    metrics.setPendingTools(deps.pendingTools?.() ?? 0);
    metrics.setExpiredTools(deps.expiredTools?.() ?? 0);
    const processGeneration = deps.processGeneration?.();
    if (processGeneration !== undefined) {
      metrics.observeProcessGeneration(processGeneration);
    }
    metrics.setAuthReady(deps.accountReady());
    return context.text(metrics.render(), 200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
    });
  });
  app.get("/v1/models", async (context) => {
    if (deps.draining()) {
      throw new ProxyError(503, "service_unavailable", "Service unavailable");
    }
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
      createChatHandler({
        models,
        ...(deps.capacity === undefined ? {} : { capacity: deps.capacity }),
        ...deps.chat,
      }),
    );
  }
  if (deps.responses) {
    app.post(
      "/v1/responses",
      createResponsesHandler({
        models,
        ...(deps.capacity === undefined ? {} : { capacity: deps.capacity }),
        ...deps.responses,
      }),
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
