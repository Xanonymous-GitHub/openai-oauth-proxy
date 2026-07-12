import { type AddressInfo, createServer } from "node:net";
import { expect, it } from "vitest";
import { createDataApp } from "../src/app.js";
import { start } from "../src/main.js";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function probe(port: number, path: string): Promise<number> {
  try {
    return (await fetch(`http://127.0.0.1:${port}${path}`)).status;
  } catch {
    return 0;
  }
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

it("exposes minimal probes and rejects unknown v1 routes", async () => {
  let draining = false;
  const app = createDataApp({
    health: () => true,
    ready: () => false,
    draining: () => draining,
    bifrostToken: "b".repeat(32),
    metricsToken: "m".repeat(32),
    host: {
      generation: 0,
      modelList: async () => ({ data: [], nextCursor: null }),
    },
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
  const host = new Promise<never>(() => undefined);
  const supervisor = {
    health: () => true,
    ready: () => true,
    start: () => {
      starts += 1;
      return host;
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

it("serves probes during initial recovery and after terminal exhaustion", async () => {
  const dataPort = await availablePort();
  let healthy = true;
  let rejectStart: ((error: Error) => void) | undefined;
  let stops = 0;
  const host = new Promise<never>((_resolve, reject) => {
    rejectStart = reject;
  });
  const supervisor = {
    health: () => healthy,
    ready: () => false,
    start: () => host,
    stop: async () => {
      stops += 1;
    },
  };
  const servicePromise = start(
    {
      dataHost: "0.0.0.0",
      dataPort,
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
  ).catch(() => undefined);

  await nextTurn();
  const initialHealth = await probe(dataPort, "/healthz");
  const initialReadiness = await probe(dataPort, "/readyz");
  healthy = false;
  rejectStart?.(new Error("recovery budget exhausted"));
  await nextTurn();
  const terminalHealth = await probe(dataPort, "/healthz");
  const terminalReadiness = await probe(dataPort, "/readyz");
  const service = await servicePromise;

  expect(initialHealth).toBe(200);
  expect(initialReadiness).toBe(503);
  expect(terminalHealth).toBe(500);
  expect(terminalReadiness).toBe(503);
  expect(service).toBeDefined();
  if (!service) return;
  await expect(service.host).rejects.toThrow("recovery budget exhausted");
  await service.close();
  expect(stops).toBe(1);
});
