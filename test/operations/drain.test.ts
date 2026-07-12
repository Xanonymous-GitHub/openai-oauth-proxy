import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import type { SupervisorRestartEvent } from "../../src/codex/supervisor.js";
import type { Config } from "../../src/config.js";
import { start } from "../../src/main.js";
import { createResponsesHandler } from "../../src/openai/responses.js";
import { TurnCapacity } from "../../src/operations/capacity.js";
import { TurnDrainRegistry } from "../../src/operations/drain.js";
import { Metrics } from "../../src/operations/metrics.js";
import type { TurnRunner } from "../../src/turns/runner.js";

const directories = new Set<string>();
afterEach(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
  directories.clear();
});

function config(dataDir: string): Config {
  return {
    dataHost: "0.0.0.0",
    dataPort: 0,
    adminHost: "127.0.0.1",
    adminPort: 0,
    dataDir,
    codexHome: join(dataDir, "codex"),
    codexBin: "codex",
    bifrostProxyToken: "b".repeat(32),
    metricsToken: "m".repeat(32),
    maxActiveTurns: 1,
    queueCapacity: 0,
    turnTimeoutMs: 600_000,
    toolTimeoutMs: 900_000,
    responseTtlMs: 604_800_000,
  };
}

it("stops admission synchronously and force-releases work after the drain deadline", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "forced-drain-"));
  directories.add(dataDir);
  const capacity = new TurnCapacity(1, 0);
  await capacity.acquire();
  const supervisor = {
    health: () => true,
    ready: () => true,
    start: () => new Promise<never>(() => undefined),
    stop: vi.fn(async () => undefined),
  };
  const service = await start(config(dataDir), {
    supervisor,
    capacity,
    drainTimeoutMs: 5,
  });

  const firstClose = service.close();
  const secondClose = service.close();

  expect(firstClose).toBe(secondClose);
  expect(capacity.draining).toBe(true);
  await expect(capacity.acquire()).rejects.toMatchObject({
    status: 503,
    code: "service_unavailable",
  });
  expect(supervisor.stop).not.toHaveBeenCalled();

  await firstClose;
  expect(capacity.active).toBe(0);
  expect(supervisor.stop).toHaveBeenCalledOnce();
});

it("aborts a backpressured admitted stream before post-close runner work", async () => {
  const capacity = new TurnCapacity(1, 0);
  const drain = new TurnDrainRegistry();
  let releaseWrite!: () => void;
  const initialWrite = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let streamCallback: Promise<void> | undefined;
  const releaseLease = vi.fn(() => undefined);
  const store = {
    reserveOperation: vi.fn(() => ({ type: "start" as const })),
    abandonOperation: vi.fn(() => {
      releaseLease();
      return undefined;
    }),
    lookupOperation: vi.fn(() => undefined),
  };
  const runner = {
    tools: {
      toDynamicTools: vi.fn(() => []),
      fingerprintDefinitions: vi.fn(() => "fingerprint"),
      invalidateResponse: vi.fn(),
    },
    stream: vi.fn(() => {
      throw new Error("runner must not start after drain");
    }),
  } as unknown as TurnRunner;
  const operationWorkingDirectory = mkdtempSync(
    join(tmpdir(), "drain-registry-"),
  );
  directories.add(operationWorkingDirectory);
  const app = new Hono();
  app.onError((error) =>
    Response.json(
      { code: (error as { code?: string }).code },
      { status: (error as { status?: number }).status ?? 500 },
    ),
  );
  app.post(
    "/",
    createResponsesHandler({
      models: {
        lookup: vi.fn(async () => ({
          id: "gpt-5.4",
          supportsImage: false,
          supportedReasoningEfforts: [],
        })),
      },
      runner,
      store: store as never,
      clock: { now: () => 1_700_000_000_000 },
      processGeneration: () => 1,
      operationWorkingDirectory,
      deleteThread: vi.fn(),
      capacity,
      drain,
      streamSSE: ((
        _context: unknown,
        callback: (stream: unknown) => Promise<void>,
      ) => {
        streamCallback = callback({
          onAbort() {},
          writeSSE: () => initialWrite,
        });
        return new Response("");
      }) as never,
    }),
  );

  const response = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.4", input: "hello", stream: true }),
  });
  expect(response.status).toBe(200);
  expect(capacity.active).toBe(1);
  expect(store.reserveOperation).toHaveBeenCalledOnce();

  drain.beginDrain();
  drain.abortAll();
  releaseWrite();

  await expect(streamCallback).rejects.toMatchObject({ name: "AbortError" });
  await drain.whenIdle();
  expect(runner.stream).not.toHaveBeenCalled();
  expect(store.abandonOperation).toHaveBeenCalledOnce();
  expect(releaseLease).toHaveBeenCalledOnce();
  expect(capacity.active).toBe(0);
});

it("counts every supervisor restart event before the first metrics scrape", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "restart-metrics-"));
  directories.add(dataDir);
  const metrics = new Metrics();
  let restartListener: ((event: SupervisorRestartEvent) => void) | undefined;
  const supervisor = {
    health: () => true,
    ready: () => true,
    start: () => new Promise<never>(() => undefined),
    stop: vi.fn(async () => undefined),
    onRestart(listener: (event: SupervisorRestartEvent) => void) {
      restartListener = listener;
      return () => {
        restartListener = undefined;
      };
    },
  };
  const service = await start(config(dataDir), { supervisor, metrics });

  restartListener?.({ generation: 2, reason: "recovery" });
  restartListener?.({ generation: 3, reason: "recovery" });

  expect(metrics.render()).toContain(
    'proxy_app_server_restarts_total{generation="2",reason="recovery"} 1',
  );
  expect(metrics.render()).toContain(
    'proxy_app_server_restarts_total{generation="3",reason="recovery"} 1',
  );
  expect(metrics.render()).not.toContain("generation_change");
  await service.close();
});
