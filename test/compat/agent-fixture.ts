import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { startListeningProxyFixture } from "../integration/proxy-fixture.js";
import { BIFROST_IMAGE } from "./bifrost-fixture.js";

function executable(names: string[]): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function agentBinaryAvailable(agent: "opencode" | "hermes"): boolean {
  return (
    executable(
      agent === "opencode" ? ["opencode"] : ["hermes", "hermes-agent"],
    ) !== undefined
  );
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function run(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<number> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
    if (code !== 0) {
      throw new Error(`Agent command exited ${code}`);
    }
    return code;
  } finally {
    clearTimeout(timer);
  }
}

export async function runAgentSmoke(agent: "opencode" | "hermes") {
  const binary = executable(
    agent === "opencode" ? ["opencode"] : ["hermes", "hermes-agent"],
  );
  if (!binary) {
    throw new Error(`${agent} binary not found`);
  }
  const proxy = await startListeningProxyFixture();
  const port = await availablePort();
  const directory = mkdtempSync(join(tmpdir(), `${agent}-smoke-`));
  const bifrostData = join(directory, "bifrost");
  mkdirSync(join(bifrostData, "logs"), { recursive: true, mode: 0o777 });
  chmodSync(bifrostData, 0o777);
  const upstream = new URL(proxy.baseURL);
  upstream.hostname = "host.docker.internal";
  upstream.pathname = "";
  writeFileSync(
    join(bifrostData, "config.json"),
    JSON.stringify({
      providers: {
        openai: {
          keys: [
            {
              name: "oauth-proxy",
              value: "env.OPENAI_PROXY_TOKEN",
              models: ["*"],
              weight: 1,
            },
          ],
          network_config: {
            base_url: upstream.toString().replace(/\/$/, ""),
            allow_private_network: true,
            max_retries: 0,
          },
        },
      },
    }),
    { mode: 0o666 },
  );
  const container = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--add-host",
      "host.docker.internal:host-gateway",
      "-e",
      `OPENAI_PROXY_TOKEN=${proxy.token}`,
      "-p",
      `127.0.0.1:${port}:8080`,
      "-v",
      `${bifrostData}:/app/data`,
      BIFROST_IMAGE,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  container.stdout.resume();
  container.stderr.resume();
  try {
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (container.exitCode !== null)
        throw new Error("Bifrost exited during agent smoke startup");
      try {
        ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
      } catch {
        // Container is still starting.
      }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error("Bifrost unavailable for agent smoke");
    proxy.armAgentTool(agent === "opencode" ? "bash" : "terminal", {
      command: "printf task15-agent-smoke",
      description: "Run deterministic smoke command",
    });
    let exitCode: number;
    if (agent === "opencode") {
      writeFileSync(
        join(directory, "opencode.json"),
        JSON.stringify({
          provider: {
            fixture: {
              npm: "@ai-sdk/openai-compatible",
              name: "Task 15 Fixture",
              options: {
                baseURL: `http://127.0.0.1:${port}/v1`,
                apiKey: "agent-client-fixture",
              },
              models: {
                "fixture-model": {
                  id: "openai/gpt-5.4",
                  name: "Task 15 Fixture Model",
                },
              },
            },
          },
          permission: { bash: "allow" },
        }),
      );
      try {
        exitCode = await run(
          binary,
          [
            "run",
            "--pure",
            "--format",
            "json",
            "--model",
            "fixture/fixture-model",
            "--dir",
            directory,
            "Use the bash tool once, then finish.",
          ],
          {
            cwd: directory,
            env: {
              ...process.env,
              HOME: directory,
              XDG_CONFIG_HOME: join(directory, "xdg"),
            },
            timeoutMs: 60_000,
          },
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : "OpenCode failed"}; proxy paths=${proxy.requestedPaths.join(",")}`,
        );
      }
    } else {
      writeFileSync(
        join(directory, "config.yaml"),
        `model:\n  default: openai/gpt-5.4\n  provider: custom\n  base_url: http://127.0.0.1:${port}/v1\n  api_key: agent-client-fixture\n`,
      );
      exitCode = await run(
        binary,
        [
          "chat",
          "--quiet",
          "--ignore-rules",
          "--provider",
          "custom",
          "--model",
          "openai/gpt-5.4",
          "--toolsets",
          "terminal",
          "-q",
          "Use the terminal tool once, then finish.",
        ],
        {
          cwd: directory,
          env: { ...process.env, HERMES_HOME: directory },
          timeoutMs: 60_000,
        },
      );
    }
    if (exitCode !== 0) throw new Error(`${agent} smoke command failed`);
    return {
      availability: "passed" as const,
      clientToolCalls: proxy.completedToolCalls.length,
      internalCodexToolEvents: proxy.internalToolEvents,
    };
  } finally {
    container.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => container.once("close", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (container.exitCode === null) container.kill("SIGKILL");
    await proxy.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
