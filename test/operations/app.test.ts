import { expect, it } from "vitest";
import { createDataApp } from "../../src/app.js";
import { TurnCapacity } from "../../src/operations/capacity.js";
import { Metrics } from "../../src/operations/metrics.js";

const bifrostToken = "b".repeat(32);
const metricsToken = "m".repeat(32);

function createFixture(draining = false) {
  const capacity = new TurnCapacity(4, 32);
  const metrics = new Metrics();
  const operations = {
    busyThreads: 2,
    pendingTools: 3,
    expiredTools: 4,
    processGeneration: 7,
  };
  const app = createDataApp({
    health: () => true,
    ready: () => true,
    accountReady: () => true,
    draining: () => draining,
    bifrostToken,
    metricsToken,
    metrics,
    capacity,
    busyThreads: () => operations.busyThreads,
    pendingTools: () => operations.pendingTools,
    expiredTools: () => operations.expiredTools,
    processGeneration: () => operations.processGeneration,
    host: {
      generation: 1,
      modelList: async () => ({ data: [], nextCursor: null }),
    },
  });
  return { app, capacity, metrics, operations };
}

it("assigns one stable request ID to success and error responses", async () => {
  const { app } = createFixture();
  app.get("/inspect-request-id", (context) =>
    context.text(context.req.header("x-request-id") ?? "missing"),
  );
  const requests = [
    app.request("/healthz"),
    app.request("/v1/models"),
    app.request("/v1/unknown", {
      headers: {
        authorization: `Bearer ${bifrostToken}`,
        "x-request-id": "req_client_123",
      },
    }),
    app.request("/inspect-request-id"),
  ];
  const responses = await Promise.all(requests);

  expect(responses[0]?.headers.get("x-request-id")).toMatch(/^req_/);
  expect(responses[1]?.headers.get("x-request-id")).toMatch(/^req_/);
  expect(responses[2]?.headers.get("x-request-id")).toBe("req_client_123");
  expect(await responses[3]?.text()).toBe(
    responses[3]?.headers.get("x-request-id"),
  );
});

it("authenticates metrics separately and renders live operational state", async () => {
  const { app, capacity, operations } = createFixture();
  const permit = await capacity.acquire();
  await capacity.acquire().then((second) => second.release());

  expect(
    (
      await app.request("/metrics", {
        headers: { authorization: `Bearer ${bifrostToken}` },
      })
    ).status,
  ).toBe(401);
  const response = await app.request("/metrics", {
    headers: { authorization: `Bearer ${metricsToken}` },
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain(
    "text/plain; version=0.0.4",
  );
  const body = await response.text();
  expect(body).toContain("proxy_active_turns 1");
  expect(body).toContain("proxy_queue_depth 0");
  expect(body).toContain("proxy_busy_threads 2");
  expect(body).toContain("proxy_pending_tools 3");
  expect(body).toContain("proxy_expired_tools_total 4");
  expect(body).toContain("proxy_auth_ready 1");

  operations.processGeneration = 8;
  const restarted = await app.request("/metrics", {
    headers: { authorization: `Bearer ${metricsToken}` },
  });
  expect(await restarted.text()).toContain(
    'proxy_app_server_restarts_total{generation="8",reason="generation_change"} 1',
  );
  permit.release();
});

it("rejects authenticated data-plane admission while draining", async () => {
  const { app } = createFixture(true);
  const response = await app.request("/v1/models", {
    headers: { authorization: `Bearer ${bifrostToken}` },
  });

  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    error: { code: "service_unavailable" },
  });
});
