import { expect, it } from "vitest";
import { createDataApp } from "../src/app.js";
import { start } from "../src/main.js";

it("exposes minimal probes and rejects unknown v1 routes", async () => {
  let draining = false;
  const app = createDataApp({
    health: () => true,
    ready: () => false,
    draining: () => draining,
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

  draining = true;
  expect((await app.request("/healthz")).status).toBe(500);
  expect((await app.request("/readyz")).status).toBe(503);
});

it("starts two listeners and removes shutdown handlers when closed", async () => {
  const sigintListeners = process.listenerCount("SIGINT");
  const sigtermListeners = process.listenerCount("SIGTERM");
  let starts = 0;
  let stops = 0;
  const supervisor = {
    health: () => true,
    ready: () => true,
    start: async () => {
      starts += 1;
    },
    stop: async () => {
      stops += 1;
    },
  };
  const service = await start(
    {
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
    },
    { supervisor },
  );

  expect(starts).toBe(1);
  expect(process.listenerCount("SIGINT")).toBe(sigintListeners + 1);
  expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners + 1);
  const firstClose = service.close();
  const secondClose = service.close();
  expect(firstClose).toBe(secondClose);
  await firstClose;
  expect(stops).toBe(1);
  expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
  expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
});

it("stops the supervisor when startup fails", async () => {
  let stops = 0;
  const supervisor = {
    health: () => true,
    ready: () => false,
    start: async () => {
      throw new Error("startup failed");
    },
    stop: async () => {
      stops += 1;
    },
  };

  await expect(
    start(
      {
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
      },
      { supervisor },
    ),
  ).rejects.toThrow("startup failed");
  expect(stops).toBe(1);
});
