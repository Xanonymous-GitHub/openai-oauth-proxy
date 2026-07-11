import { pathToFileURL } from "node:url";
import { type ServerType, serve } from "@hono/node-server";
import { Hono } from "hono";
import { createDataApp } from "./app.js";
import { createSupervisor } from "./codex/supervisor.js";
import { type Config, loadConfig } from "./config.js";

export interface RunningService {
  close(): Promise<void>;
}

interface SupervisorLifecycle {
  start(): Promise<unknown>;
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

export async function start(
  config: Config,
  dependencies: StartDependencies = {},
): Promise<RunningService> {
  const supervisor = dependencies.supervisor ?? createSupervisor({ config });
  try {
    await supervisor.start();
  } catch (error) {
    await supervisor.stop();
    throw error;
  }
  let draining = false;
  const dataApp = createDataApp({
    health: () => supervisor.health(),
    ready: () => supervisor.ready(),
    draining: () => draining,
    bifrostToken: config.bifrostProxyToken,
    metricsToken: config.metricsToken,
  });
  const adminApp = new Hono();
  let dataServer: ServerType;
  try {
    dataServer = await listen(dataApp, config.dataHost, config.dataPort);
  } catch (error) {
    await supervisor.stop();
    throw error;
  }
  let adminServer: ServerType;
  try {
    adminServer = await listen(adminApp, config.adminHost, config.adminPort);
  } catch (error) {
    await Promise.all([closeServer(dataServer), supervisor.stop()]);
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closePromise) {
      draining = true;
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
      closePromise = supervisor
        .stop()
        .then(() =>
          Promise.all([closeServer(dataServer), closeServer(adminServer)]).then(
            () => undefined,
          ),
        );
    }
    return closePromise;
  };
  const handleSignal = (): void => {
    void close();
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  return { close };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await start(loadConfig(process.env));
}
