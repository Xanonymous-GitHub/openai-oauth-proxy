import { z } from "zod";

export interface Config {
  dataHost: "0.0.0.0";
  dataPort: number;
  adminHost: "127.0.0.1" | "0.0.0.0";
  adminPort: number;
  dataDir: string;
  codexHome: string;
  codexBin: string;
  bifrostProxyToken: string;
  metricsToken: string;
  maxActiveTurns: number;
  queueCapacity: number;
  turnTimeoutMs: number;
  toolTimeoutMs: number;
  responseTtlMs: number;
}

const boundedInteger = (fallback: number, minimum: number, maximum: number) =>
  z.coerce.number().int().min(minimum).max(maximum).default(fallback);

const envSchema = z.strictObject({
  DATA_PORT: boundedInteger(8080, 1, 65_535),
  ADMIN_HOST: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"),
  ADMIN_PORT: boundedInteger(8081, 1, 65_535),
  DATA_DIR: z.string().min(1),
  CODEX_HOME: z.string().min(1).optional(),
  CODEX_BIN: z.string().min(1).default("codex"),
  BIFROST_PROXY_TOKEN: z.string().min(32),
  METRICS_TOKEN: z.string().min(32),
  MAX_ACTIVE_TURNS: boundedInteger(4, 1, 16),
  QUEUE_CAPACITY: boundedInteger(32, 0, 256),
  TURN_TIMEOUT_MS: boundedInteger(600_000, 1_000, 3_600_000),
  TOOL_TIMEOUT_MS: boundedInteger(900_000, 1_000, 3_600_000),
  RESPONSE_TTL_MS: boundedInteger(604_800_000, 60_000, 2_592_000_000),
});

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = envSchema.parse({
    DATA_PORT: env.DATA_PORT,
    ADMIN_HOST: env.ADMIN_HOST,
    ADMIN_PORT: env.ADMIN_PORT,
    DATA_DIR: env.DATA_DIR,
    CODEX_HOME: env.CODEX_HOME,
    CODEX_BIN: env.CODEX_BIN,
    BIFROST_PROXY_TOKEN: env.BIFROST_PROXY_TOKEN,
    METRICS_TOKEN: env.METRICS_TOKEN,
    MAX_ACTIVE_TURNS: env.MAX_ACTIVE_TURNS,
    QUEUE_CAPACITY: env.QUEUE_CAPACITY,
    TURN_TIMEOUT_MS: env.TURN_TIMEOUT_MS,
    TOOL_TIMEOUT_MS: env.TOOL_TIMEOUT_MS,
    RESPONSE_TTL_MS: env.RESPONSE_TTL_MS,
  });

  return {
    dataHost: "0.0.0.0",
    dataPort: parsed.DATA_PORT,
    adminHost: parsed.ADMIN_HOST,
    adminPort: parsed.ADMIN_PORT,
    dataDir: parsed.DATA_DIR,
    codexHome: parsed.CODEX_HOME ?? `${parsed.DATA_DIR}/codex`,
    codexBin: parsed.CODEX_BIN,
    bifrostProxyToken: parsed.BIFROST_PROXY_TOKEN,
    metricsToken: parsed.METRICS_TOKEN,
    maxActiveTurns: parsed.MAX_ACTIVE_TURNS,
    queueCapacity: parsed.QUEUE_CAPACITY,
    turnTimeoutMs: parsed.TURN_TIMEOUT_MS,
    toolTimeoutMs: parsed.TOOL_TIMEOUT_MS,
    responseTtlMs: parsed.RESPONSE_TTL_MS,
  };
}
