import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type ServerType, serve } from "@hono/node-server";
import { type Env, Hono } from "hono";
import { createAdminApp } from "./admin/app.js";
import { SessionStore } from "./admin/sessions.js";
import { createDataApp } from "./app.js";
import { AccountManager } from "./codex/account.js";
import type { CodexHost } from "./codex/host.js";
import type {
  SupervisorRestartEvent,
  SupervisorRestartListener,
} from "./codex/supervisor.js";
import { createSupervisor } from "./codex/supervisor.js";
import { type Config, loadConfig } from "./config.js";
import { ConversationStore } from "./conversations/store.js";
import {
  type RunningResponseSweeper,
  startResponseSweeper,
} from "./openai/responses.js";
import { TurnCapacity } from "./operations/capacity.js";
import { TurnDrainRegistry } from "./operations/drain.js";
import { type Logger, log } from "./operations/log.js";
import { Metrics } from "./operations/metrics.js";
import { TurnRunner } from "./turns/runner.js";

const EMPTY_WORKING_DIRECTORY = "/tmp/work";
const RESPONSE_OPERATION_DIRECTORY = "/tmp/response-operations";
const NEUTRAL_INSTRUCTIONS =
  "Respond only through supplied text or client function tools. Internal tools and a local repository are unavailable. Follow the requested output format.";
const DRAIN_TIMEOUT_MS = 30_000;

export interface RunningService {
  readonly host: Promise<CodexHost>;
  close(): Promise<void>;
}

interface SupervisorLifecycle {
  start(): Promise<CodexHost>;
  health(): boolean;
  ready(): boolean;
  stop(): Promise<void>;
  onRestart?(listener: SupervisorRestartListener): () => void;
}

interface StartDependencies {
  supervisor?: SupervisorLifecycle;
  capacity?: TurnCapacity;
  metrics?: Metrics;
  logger?: Logger;
  drain?: TurnDrainRegistry;
  drainTimeoutMs?: number;
}

function settlesWithin(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (completed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    void promise.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function listen<E extends Env>(
  app: Hono<E>,
  hostname: string,
  port: number,
): Promise<ServerType> {
  return new Promise((resolve, reject) => {
    const handleError = (error: Error): void => {
      reject(error);
    };
    const server = serve({ fetch: app.fetch, hostname, port }, () => {
      server.off("error", handleError);
      resolve(server);
    });
    server.once("error", handleError);
  });
}

function createLazyHost(resolve: () => CodexHost): CodexHost {
  return new Proxy({} as CodexHost, {
    get(_target, property) {
      const host = resolve();
      const value = Reflect.get(host, property) as unknown;
      return typeof value === "function" ? value.bind(host) : value;
    },
  });
}

export async function start(
  config: Config,
  dependencies: StartDependencies = {},
): Promise<RunningService> {
  const supervisor = dependencies.supervisor ?? createSupervisor({ config });
  const capacity =
    dependencies.capacity ??
    new TurnCapacity(config.maxActiveTurns, config.queueCapacity);
  const metrics = dependencies.metrics ?? new Metrics();
  const drain = dependencies.drain ?? new TurnDrainRegistry();
  const logger = dependencies.logger ?? log;
  const clock = { now: () => Date.now() };
  const conversationStore = ConversationStore.open(
    join(config.dataDir, "proxy.sqlite"),
    clock,
    {
      responseTtlMs: config.responseTtlMs,
      turnLeaseMs: config.turnTimeoutMs,
      toolLeaseMs: config.toolTimeoutMs,
    },
  );
  const unsubscribeRestart = supervisor.onRestart?.(
    (event: SupervisorRestartEvent) =>
      metrics.recordAppServerRestart(event.generation, event.reason),
  );
  let draining = false;
  let host: Promise<CodexHost> | undefined;
  let activeHost: CodexHost | undefined;
  let responseSweeper: RunningResponseSweeper | undefined;
  const lazyHost = createLazyHost(() => {
    if (!activeHost) throw new Error("Codex host not ready");
    return activeHost;
  });
  const turnRunner = new TurnRunner({
    host: lazyHost,
    emptyWorkingDirectory: EMPTY_WORKING_DIRECTORY,
    neutralInstructions: NEUTRAL_INSTRUCTIONS,
    timeoutMs: config.turnTimeoutMs,
    toolTimeoutMs: config.toolTimeoutMs,
  });
  const account = new AccountManager(lazyHost);
  const dataApp = createDataApp({
    health: () => supervisor.health(),
    ready: () => supervisor.ready(),
    accountReady: () => account.ready(),
    draining: () => draining,
    bifrostToken: config.bifrostProxyToken,
    metricsToken: config.metricsToken,
    capacity,
    drain,
    metrics,
    logger,
    busyThreads: () => conversationStore.busyThreads(),
    pendingTools: () => turnRunner.tools.pending,
    expiredTools: () => turnRunner.tools.expired,
    processGeneration: () => activeHost?.generation,
    host: lazyHost,
    chat: {
      runner: turnRunner,
      deleteThread: async (threadId, signal) => {
        await lazyHost.threadDelete({ threadId }, signal);
      },
    },
    responses: {
      runner: turnRunner,
      store: conversationStore,
      clock,
      processGeneration: () => lazyHost.generation,
      operationWorkingDirectory: RESPONSE_OPERATION_DIRECTORY,
      deleteThread: async (threadId, signal) => {
        await lazyHost.threadDelete({ threadId }, signal);
      },
    },
  });
  const adminRoutes = createAdminApp({
    account,
    sessions: new SessionStore(),
    allowedOrigins: new Set([
      `http://127.0.0.1:${config.adminPort}`,
      `http://localhost:${config.adminPort}`,
    ]),
  });
  const adminApp = new Hono();
  adminApp.use("*", async (context, next) => {
    const supplied = context.req.header("x-request-id");
    const requestId =
      supplied !== undefined && /^[A-Za-z0-9_-]{1,128}$/.test(supplied)
        ? supplied
        : `req_${randomUUID()}`;
    const startedAt = performance.now();
    await next();
    context.res.headers.set("x-request-id", requestId);
    const durationMs = performance.now() - startedAt;
    metrics.recordRequest("admin", context.res.status, durationMs / 1_000);
    logger({
      requestId,
      route: "admin",
      status: context.res.status,
      durationMs,
    });
  });
  adminApp.route("/", adminRoutes);
  let dataServer: ServerType;
  try {
    dataServer = await listen(dataApp, config.dataHost, config.dataPort);
  } catch (error) {
    unsubscribeRestart?.();
    await Promise.allSettled([supervisor.stop()]);
    conversationStore.close();
    throw error;
  }
  let adminServer: ServerType;
  try {
    adminServer = await listen(adminApp, config.adminHost, config.adminPort);
  } catch (error) {
    unsubscribeRestart?.();
    await Promise.allSettled([closeServer(dataServer), supervisor.stop()]);
    conversationStore.close();
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closePromise) {
      draining = true;
      capacity.beginDrain();
      drain.beginDrain();
      unsubscribeRestart?.();
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
      closePromise = (async () => {
        let failure: unknown;
        const capture = async (operation: () => void | Promise<void>) => {
          try {
            await operation();
          } catch (error) {
            failure ??= error;
          }
        };
        const drained = await settlesWithin(
          Promise.all([capacity.whenIdle(), drain.whenIdle()]).then(
            () => undefined,
          ),
          dependencies.drainTimeoutMs ?? DRAIN_TIMEOUT_MS,
        );
        if (!drained) {
          drain.abortAll();
          await capture(() => turnRunner.interruptAll());
          capacity.invalidateActive();
          await capture(() => drain.whenIdle());
        }
        await capture(() => responseSweeper?.stop());
        await capture(() => conversationStore.close());
        await capture(() => supervisor.stop());
        const settled = await Promise.allSettled([
          closeServer(dataServer),
          closeServer(adminServer),
        ]);
        for (const result of settled) {
          if (result.status === "rejected") failure ??= result.reason;
        }
        if (failure !== undefined) throw failure;
      })();
    }
    return closePromise;
  };
  const handleSignal = (): void => {
    void close();
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  try {
    host = supervisor.start();
  } catch (error) {
    host = Promise.reject(error);
  }
  void host.then(
    (value) => {
      if (draining) return;
      activeHost = value;
      conversationStore.markContinuationLost(value.generation);
      void account.start();
      responseSweeper = startResponseSweeper({
        store: conversationStore,
        deleteThread: async (threadId) => {
          await value.threadDelete({ threadId });
        },
        host: value,
      });
      void responseSweeper.startup.catch(() => undefined);
    },
    () => undefined,
  );
  void host.catch(() => undefined);

  return { close, host };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await start(loadConfig(process.env));
}
