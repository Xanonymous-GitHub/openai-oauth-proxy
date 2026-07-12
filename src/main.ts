import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type ServerType, serve } from "@hono/node-server";
import { Hono } from "hono";
import { createDataApp } from "./app.js";
import type { CodexHost } from "./codex/host.js";
import { createSupervisor } from "./codex/supervisor.js";
import { type Config, loadConfig } from "./config.js";
import { ConversationStore } from "./conversations/store.js";
import {
  type RunningResponseSweeper,
  startResponseSweeper,
} from "./openai/responses.js";
import { TurnRunner } from "./turns/runner.js";

const EMPTY_WORKING_DIRECTORY = "/tmp/work";
const NEUTRAL_INSTRUCTIONS =
  "Respond only through supplied text or client function tools. Internal tools and a local repository are unavailable. Follow the requested output format.";

export interface RunningService {
  readonly host: Promise<CodexHost>;
  close(): Promise<void>;
}

interface SupervisorLifecycle {
  start(): Promise<CodexHost>;
  health(): boolean;
  ready(): boolean;
  stop(): Promise<void>;
}

interface StartDependencies {
  supervisor?: SupervisorLifecycle;
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

function listen(
  app: Hono,
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
  });
  const dataApp = createDataApp({
    health: () => supervisor.health(),
    ready: () => supervisor.ready(),
    draining: () => draining,
    bifrostToken: config.bifrostProxyToken,
    metricsToken: config.metricsToken,
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
      deleteThread: async (threadId, signal) => {
        await lazyHost.threadDelete({ threadId }, signal);
      },
    },
  });
  const adminApp = new Hono();
  let dataServer: ServerType;
  try {
    dataServer = await listen(dataApp, config.dataHost, config.dataPort);
  } catch (error) {
    await Promise.allSettled([supervisor.stop()]);
    conversationStore.close();
    throw error;
  }
  let adminServer: ServerType;
  try {
    adminServer = await listen(adminApp, config.adminHost, config.adminPort);
  } catch (error) {
    await Promise.allSettled([closeServer(dataServer), supervisor.stop()]);
    conversationStore.close();
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closePromise) {
      draining = true;
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
      closePromise = (async () => {
        let failure: unknown;
        try {
          await responseSweeper?.stop();
        } catch (error) {
          failure = error;
        }
        const settled = await Promise.allSettled([
          supervisor.stop(),
          closeServer(dataServer),
          closeServer(adminServer),
        ]);
        conversationStore.close();
        if (failure !== undefined) throw failure;
        for (const result of settled) {
          if (result.status === "rejected") throw result.reason;
        }
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
      responseSweeper = startResponseSweeper({
        store: conversationStore,
        deleteThread: async (threadId) => {
          await value.threadDelete({ threadId });
        },
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
