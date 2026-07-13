import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function terminateChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await closed;
  }
}

export async function exerciseSecretLogContract() {
  const directory = mkdtempSync(join(tmpdir(), "proxy-log-contract-"));
  const data = join(directory, "data");
  const codexHome = join(data, "codex");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(codexHome, "auth.json"), "opaque credential fixture", {
    mode: 0o600,
  });
  const rawEventSentinel = "RAW_APP_SERVER_EVENT_SENTINEL_15";
  const childStderrSentinel = "APP_SERVER_STDERR_SENTINEL_15";
  const upstreamSentinels = [
    "UPSTREAM_CREDENTIAL_SENTINEL_15",
    "/private/upstream/path/sentinel-15",
    "X-Upstream-Secret: HEADER_SENTINEL_15",
    "UPSTREAM_BODY_SENTINEL_15",
  ];
  const script = join(directory, "raw-events.json");
  writeFileSync(
    script,
    JSON.stringify([
      {
        method: "rawResponseItem/completed",
        params: {
          threadId: "thread-secret",
          turnId: "turn-secret",
          item: { type: "fixture", payload: rawEventSentinel },
        },
      },
    ]),
  );
  const codexLauncher = join(directory, "fake-codex");
  writeFileSync(
    codexLauncher,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolve("test/fixtures/fake-app-server.mjs"))} "$@"\n`,
    { mode: 0o700 },
  );
  chmodSync(codexLauncher, 0o700);
  execFileSync("bun", ["run", "build"], { stdio: "ignore" });
  const dataPort = await availablePort();
  const adminPort = await availablePort();
  let logs = "";
  const child = spawn(process.execPath, [resolve("dist/main.js")], {
    env: {
      ...process.env,
      DATA_DIR: data,
      DATA_PORT: String(dataPort),
      ADMIN_PORT: String(adminPort),
      CODEX_BIN: codexLauncher,
      BIFROST_PROXY_TOKEN: "b".repeat(32),
      METRICS_TOKEN: "m".repeat(32),
      FAKE_CODEX_SCRIPT: script,
      FAKE_CODEX_STDERR_SENTINEL: childStderrSentinel,
      FAKE_CODEX_AUTOCOMPLETE: "1",
      FAKE_CODEX_TURN_ERROR: upstreamSentinels.join(" | "),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk: Buffer) => {
    logs += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    logs += chunk.toString();
  });
  const origin = `http://127.0.0.1:${dataPort}`;
  const deadline = Date.now() + 15_000;
  let requestBody = "";
  const forbidden = [
    "private prompt",
    "data:image/",
    "tool-payload",
    "Authorization",
    "access_token",
    "refresh_token",
    "id_token",
    "auth.json",
    "Bearer bbbbbbbb",
    rawEventSentinel,
    childStderrSentinel,
    ...upstreamSentinels,
  ];
  try {
    try {
      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error(`Log fixture proxy exited (${child.exitCode})`);
        }
        try {
          if ((await fetch(`${origin}/readyz`)).ok) break;
        } catch {
          // Child is still starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      requestBody = JSON.stringify({
        model: "gpt-5.2-codex",
        messages: [
          {
            role: "user",
            content:
              "private prompt data:image/png;base64,PRIVATE tool-payload Authorization access_token refresh_token id_token auth.json",
          },
        ],
      });
      const headers = {
        authorization: `Bearer ${"b".repeat(32)}`,
        "content-type": "application/json",
      };
      await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: `${requestBody} malformed`,
      });
      const upstreamFailure = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: requestBody,
      });
      if (upstreamFailure.ok) {
        throw new Error("Sentinel upstream failure unexpectedly succeeded");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      await terminateChild(child);
    }
    return {
      logs,
      requestBody,
      matches: forbidden.filter((value) => logs.includes(value)),
      upstreamSentinels,
      childClosed: child.exitCode !== null || child.signalCode !== null,
    };
  } finally {
    await terminateChild(child);
    rmSync(directory, { recursive: true, force: true });
  }
}
