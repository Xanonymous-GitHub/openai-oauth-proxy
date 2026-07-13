import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";

export const BIFROST_IMAGE =
  "maximhq/bifrost:v1.6.3@sha256:95caedb1c368c6d88178c2b98b9238d8a6a62b51d9cb12b6661bf2671ed1aaa4";
const BIFROST_CONFIG_PATH = "deploy/bifrost/config.example.json";

async function availablePort(host = "127.0.0.1"): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.once("error", reject);
  });
}

function completion(
  body: Record<string, unknown>,
  response: ServerResponse,
): void {
  const serialized = JSON.stringify(body);
  if (serialized.includes("error fixture")) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: {
          message: "Fixture upstream error",
          type: "server_error",
          param: null,
          code: "upstream_error",
        },
      }),
    );
    return;
  }
  if (serialized.includes("rate fixture")) {
    response.writeHead(429, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: {
          message: "Fixture rate limit",
          type: "rate_limit_error",
          param: null,
          code: "rate_limit_exceeded",
        },
      }),
    );
    return;
  }
  const tools = Array.isArray(body.tools) && body.tools.length > 0;
  const choice = tools
    ? {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_bifrost_fixture",
              type: "function",
              function: { name: "lookup", arguments: '{"id":"fixture"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      }
    : {
        index: 0,
        message: { role: "assistant", content: "bifrost fixture" },
        finish_reason: "stop",
      };
  if (body.stream === true) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({
        id: "chatcmpl_bifrost",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "bifrost fixture" },
            finish_reason: null,
          },
        ],
      })}\n\ndata: ${JSON.stringify({
        id: "chatcmpl_bifrost",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-5.4",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      id: "chatcmpl_bifrost",
      object: "chat.completion",
      created: 1,
      model: "gpt-5.4",
      choices: [choice],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
}

async function dockerAvailable(): Promise<boolean> {
  const child = spawn("docker", ["info"], { stdio: "ignore" });
  return new Promise((resolve) => {
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

export async function runBifrostContract() {
  if (!(await dockerAvailable())) {
    return {
      availability: "unavailable" as const,
      reason: "Docker unavailable",
    };
  }
  const upstreamPort = await availablePort("0.0.0.0");
  const bifrostPort = await availablePort();
  const upstreamRequests: Array<{
    authorization: string | undefined;
    path: string;
    body: Record<string, unknown>;
  }> = [];
  const upstream = createServer(async (request, response) => {
    if (!request.url?.endsWith("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    const body = await readBody(request);
    upstreamRequests.push({
      authorization: request.headers.authorization,
      path: request.url ?? "",
      body,
    });
    completion(body, response);
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(upstreamPort, "0.0.0.0", resolve);
  });
  const directory = mkdtempSync(join(tmpdir(), "bifrost-contract-"));
  chmodSync(directory, 0o777);
  mkdirSync(join(directory, "logs"), { mode: 0o777 });
  const proxyToken = "p".repeat(32);
  const config = JSON.parse(readFileSync(BIFROST_CONFIG_PATH, "utf8")) as {
    providers: {
      openai: {
        network_config: { base_url: string; max_retries?: number };
      };
    };
  };
  config.providers.openai.network_config.base_url = `http://host.docker.internal:${upstreamPort}`;
  config.providers.openai.network_config.max_retries = 0;
  writeFileSync(join(directory, "config.json"), JSON.stringify(config), {
    mode: 0o666,
  });
  const container = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--add-host",
      "host.docker.internal:host-gateway",
      "-e",
      `OPENAI_PROXY_TOKEN=${proxyToken}`,
      "-p",
      `127.0.0.1:${bifrostPort}:8080`,
      "-v",
      `${directory}:/app/data`,
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
        throw new Error("Bifrost exited during startup");
      try {
        ready = (await fetch(`http://127.0.0.1:${bifrostPort}/health`)).ok;
      } catch {
        // Container is still starting.
      }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error("Bifrost did not become ready");
    const client = new OpenAI({
      apiKey: "bifrost-client-fixture",
      baseURL: `http://127.0.0.1:${bifrostPort}/v1`,
      maxRetries: 0,
    });
    await client.chat.completions.create({
      model: "openai/gpt-5.4",
      messages: [{ role: "user", content: "ordinary fixture" }],
    });
    const stream = await client.chat.completions.create({
      model: "openai/gpt-5.4",
      messages: [{ role: "user", content: "stream fixture" }],
      stream: true,
    });
    let streaming = false;
    for await (const chunk of stream) {
      streaming ||= chunk.choices[0]?.delta.content === "bifrost fixture";
    }
    const tool = await client.chat.completions.create({
      model: "openai/gpt-5.4",
      messages: [{ role: "user", content: "tool fixture" }],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            parameters: {
              type: "object",
              properties: { id: { type: "string" } },
            },
          },
        },
      ],
    });
    let errorStatus = 0;
    try {
      await client.chat.completions.create({
        model: "openai/gpt-5.4",
        messages: [{ role: "user", content: "error fixture" }],
      });
    } catch (error) {
      if (error instanceof OpenAI.APIError) errorStatus = error.status;
    }
    let rateLimitStatus = 0;
    try {
      await client.chat.completions.create({
        model: "openai/gpt-5.4",
        messages: [{ role: "user", content: "rate fixture" }],
      });
    } catch (error) {
      if (error instanceof OpenAI.APIError) rateLimitStatus = error.status;
    }
    return {
      availability: "passed" as const,
      configSource: BIFROST_CONFIG_PATH,
      forwardedModel: upstreamRequests[0]?.body.model,
      authorizationForwarded: upstreamRequests.every(
        (request) => request.authorization === `Bearer ${proxyToken}`,
      ),
      upstreamPaths: upstreamRequests.map((request) => request.path),
      streaming,
      tools: tool.choices[0]?.finish_reason === "tool_calls",
      errorStatus,
      rateLimitStatus,
    };
  } finally {
    container.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => container.once("close", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (container.exitCode === null) container.kill("SIGKILL");
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}
