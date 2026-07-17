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

  it("allows exposing the admin listener for a host-loopback Docker port", () => {
    expect(loadConfig({ ...valid, ADMIN_HOST: "0.0.0.0" }).adminHost).toBe(
      "0.0.0.0",
    );
  });

  it("allows one exact HTTPS admin origin", () => {
    expect(
      loadConfig({
        ...valid,
        ADMIN_ORIGIN: "https://openai-proxy-admin.example.ts.net",
      }).adminOrigin,
    ).toBe("https://openai-proxy-admin.example.ts.net");
  });

  it.each([
    [{ ...valid, BIFROST_PROXY_TOKEN: "short" }, "BIFROST_PROXY_TOKEN"],
    [{ ...valid, MAX_ACTIVE_TURNS: "17" }, "MAX_ACTIVE_TURNS"],
    [{ ...valid, QUEUE_CAPACITY: "257" }, "QUEUE_CAPACITY"],
    [{ ...valid, ADMIN_ORIGIN: "http://admin.example.com" }, "ADMIN_ORIGIN"],
    [
      { ...valid, ADMIN_ORIGIN: "https://admin.example.com/path" },
      "ADMIN_ORIGIN",
    ],
  ])("rejects invalid environment", (env, field) => {
    expect(() => loadConfig(env)).toThrow(field);
  });
});
