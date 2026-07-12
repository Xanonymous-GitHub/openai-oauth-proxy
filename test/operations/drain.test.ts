import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import { start } from "../../src/main.js";
import { TurnCapacity } from "../../src/operations/capacity.js";

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
