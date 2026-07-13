import { createDataApp } from "../../src/app.js";
import { fakeModel, fakeModelListResponse } from "../../src/codex/fake.js";
import type { CodexHost } from "../../src/codex/host.js";
import { createLogger } from "../../src/operations/log.js";
import type { TurnRunner } from "../../src/turns/runner.js";

export async function exerciseSecretLogContract() {
  const requestBody = JSON.stringify({
    model: "gpt-5.4",
    messages: [
      {
        role: "user",
        content:
          "private prompt data:image/png;base64,PRIVATE tool-payload Authorization access_token refresh_token id_token auth.json",
      },
    ],
  });
  let logs = "";
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    logs += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    logs += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  const runner = {
    tools: {
      toDynamicTools: () => [],
      fingerprintDefinitions: () => "fixture",
    },
    run: async () => {
      throw new Error(requestBody);
    },
  } as unknown as TurnRunner;
  const host = {
    generation: 1,
    modelList: async () =>
      fakeModelListResponse({
        data: [fakeModel({ id: "gpt-5.4", model: "gpt-5.4" })],
      }),
  } as unknown as CodexHost;
  const app = createDataApp({
    health: () => true,
    ready: () => true,
    accountReady: () => true,
    draining: () => false,
    bifrostToken: "b".repeat(32),
    metricsToken: "m".repeat(32),
    logger: createLogger((line) => process.stdout.write(`${line}\n`)),
    host,
    chat: { runner, deleteThread: async () => undefined },
  });
  try {
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${"b".repeat(32)}`,
        "content-type": "application/json",
      },
      body: `${requestBody} malformed`,
    });
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${"b".repeat(32)}`,
        "content-type": "application/json",
      },
      body: requestBody,
    });
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
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
  ];
  return {
    logs,
    requestBody,
    matches: forbidden.filter((value) => logs.includes(value)),
  };
}
