import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const valid = {
  BIFROST_PROXY_TOKEN: "b".repeat(32),
  METRICS_TOKEN: "m".repeat(32),
  DATA_DIR: "/data",
};

describe("loadConfig", () => {
  it("loads bounded defaults", () => {
    expect(loadConfig(valid)).toMatchObject({
      dataPort: 8080,
      adminHost: "127.0.0.1",
      adminPort: 8081,
      maxActiveTurns: 4,
      queueCapacity: 32,
      turnTimeoutMs: 600_000,
      toolTimeoutMs: 900_000,
      responseTtlMs: 604_800_000,
    });
  });

  it.each([
    [{ ...valid, BIFROST_PROXY_TOKEN: "short" }, "BIFROST_PROXY_TOKEN"],
    [{ ...valid, MAX_ACTIVE_TURNS: "17" }, "MAX_ACTIVE_TURNS"],
    [{ ...valid, QUEUE_CAPACITY: "257" }, "QUEUE_CAPACITY"],
  ])("rejects invalid environment", (env, field) => {
    expect(() => loadConfig(env)).toThrow(field);
  });
});
