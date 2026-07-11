import { expect, it } from "vitest";
import { createDataApp } from "../src/app.js";
import { start } from "../src/main.js";

it("exposes minimal probes and rejects unknown v1 routes", async () => {
  const app = createDataApp({
    health: () => true,
    ready: () => false,
    bifrostToken: "b".repeat(32),
    metricsToken: "m".repeat(32),
  });
  expect((await app.request("/healthz")).status).toBe(200);
  expect((await app.request("/readyz")).status).toBe(503);
  const missing = await app.request("/v1/embeddings", {
    headers: { authorization: `Bearer ${"b".repeat(32)}` },
  });
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({
    error: { type: "invalid_request_error", code: "unsupported_endpoint" },
  });
});

it("starts two listeners and removes shutdown handlers when closed", async () => {
  const sigintListeners = process.listenerCount("SIGINT");
  const sigtermListeners = process.listenerCount("SIGTERM");
  const service = await start({
    dataHost: "0.0.0.0",
    dataPort: 0,
    adminHost: "127.0.0.1",
    adminPort: 0,
    dataDir: "/data",
    codexHome: "/data/codex",
    codexBin: "codex",
    bifrostProxyToken: "b".repeat(32),
    metricsToken: "m".repeat(32),
    maxActiveTurns: 4,
    queueCapacity: 32,
    turnTimeoutMs: 600_000,
    toolTimeoutMs: 900_000,
    responseTtlMs: 604_800_000,
  });

  expect(process.listenerCount("SIGINT")).toBe(sigintListeners + 1);
  expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners + 1);
  await service.close();
  expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
  expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
});
