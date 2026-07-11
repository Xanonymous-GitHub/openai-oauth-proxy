import { Hono } from "hono";

export interface DataAppDependencies {
  health(): boolean;
  ready(): boolean;
  draining(): boolean;
  bifrostToken: string;
  metricsToken: string;
}

export function createDataApp(deps: DataAppDependencies): Hono {
  const app = new Hono();

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
