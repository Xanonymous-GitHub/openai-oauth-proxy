import { pathToFileURL } from "node:url";
import { type ServerType, serve } from "@hono/node-server";
import { Hono } from "hono";
import { createDataApp } from "./app.js";
import { type Config, loadConfig } from "./config.js";

export interface RunningService {
  close(): Promise<void>;
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

export async function start(config: Config): Promise<RunningService> {
  const dataApp = createDataApp({
    health: () => true,
    ready: () => true,
    bifrostToken: config.bifrostProxyToken,
    metricsToken: config.metricsToken,
  });
  const adminApp = new Hono();
  const dataServer = await listen(dataApp, config.dataHost, config.dataPort);
  let adminServer: ServerType;
  try {
    adminServer = await listen(adminApp, config.adminHost, config.adminPort);
  } catch (error) {
    await closeServer(dataServer);
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closePromise) {
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
      closePromise = Promise.all([
        closeServer(dataServer),
        closeServer(adminServer),
      ]).then(() => undefined);
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
