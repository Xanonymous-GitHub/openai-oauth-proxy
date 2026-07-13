import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_REQUEST_BYTES } from "../../src/http/limits.js";
import { createChatHandler } from "../../src/openai/chat.js";
import type { ModelCapabilities } from "../../src/openai/models.js";
import { createResponsesHandler } from "../../src/openai/responses.js";
import type { TurnResult } from "../../src/turns/events.js";
import type {
  TurnLifecycleCallbacks,
  TurnRunner,
} from "../../src/turns/runner.js";

const directories = new Set<string>();
afterEach(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
  directories.clear();
});

const model: ModelCapabilities = {
  id: "gpt-5.4",
  supportsImage: false,
  supportedReasoningEfforts: ["low"],
};

function fakeRunner(
  sequence: string[],
  result: TurnResult = {
    threadId: "thread-1",
    turnId: "turn-1",
    text: "ok",
    finishReason: "stop",
  },
): TurnRunner {
  const runner = {
    tools: {
      toDynamicTools: vi.fn(() => []),
      fingerprintDefinitions: vi.fn(() => "fingerprint"),
      configuration: vi.fn(() => ({
        canonical: "tools",
        fingerprint: "fingerprint",
      })),
      continue: vi.fn(),
    },
    run: vi.fn(
      async (
        _command: unknown,
        _signal: AbortSignal,
        lifecycle?: TurnLifecycleCallbacks,
      ) => {
        sequence.push("run");
        await lifecycle?.opened?.(result.threadId);
        await lifecycle?.started?.(result.threadId, result.turnId);
        await lifecycle?.release?.();
        return result;
      },
    ),
  };
  return runner as unknown as TurnRunner;
}

describe("turn admission ordering", () => {
  it("validates and model-checks Chat before acquiring, then releases terminal work", async () => {
    const sequence: string[] = [];
    const release = vi.fn(() => sequence.push("release"));
    const acquire = vi.fn(async () => {
      sequence.push("acquire");
      return { release };
    });
    const lookup = vi.fn(async () => {
      sequence.push("model");
      return model;
    });
    const app = new Hono();
    app.onError((error) =>
      Response.json(
        { code: (error as { code?: string }).code },
        { status: (error as { status?: number }).status ?? 500 },
      ),
    );
    app.post(
      "/",
      createChatHandler({
        models: { lookup },
        runner: fakeRunner(sequence),
        capacity: { acquire },
        deleteThread: vi.fn(),
      }),
    );

    const invalid = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.4", messages: [] }),
    });
    expect(invalid.status).toBe(400);
    expect(acquire).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();

    const valid = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(valid.status).toBe(200);
    expect(sequence).toEqual(["model", "acquire", "run", "release"]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("enforces Content-Length before parsing Chat", async () => {
    const lookup = vi.fn(async () => model);
    const app = new Hono();
    app.onError((error) =>
      Response.json(
        { code: (error as { code?: string }).code },
        { status: (error as { status?: number }).status ?? 500 },
      ),
    );
    app.post(
      "/",
      createChatHandler({
        models: { lookup },
        runner: fakeRunner([]),
        deleteThread: vi.fn(),
      }),
    );

    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_REQUEST_BYTES + 1),
      },
      body: "{}",
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ code: "request_too_large" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("acquires Responses capacity before reservation and releases a rejected reservation", async () => {
    const sequence: string[] = [];
    const release = vi.fn(() => sequence.push("release"));
    const acquire = vi.fn(async () => {
      sequence.push("acquire");
      return { release };
    });
    const operationWorkingDirectory = mkdtempSync(
      join(tmpdir(), "admission-operations-"),
    );
    directories.add(operationWorkingDirectory);
    const store = {
      reserveOperation: vi.fn(() => {
        sequence.push("reserve");
        return { type: "busy" as const };
      }),
    };
    const app = new Hono();
    app.onError((error) =>
      Response.json(
        { code: (error as { code?: string }).code },
        { status: (error as { status?: number }).status ?? 500 },
      ),
    );
    app.post(
      "/",
      createResponsesHandler({
        models: { lookup: vi.fn(async () => model) },
        runner: fakeRunner(sequence),
        capacity: { acquire },
        store: store as never,
        clock: { now: () => 1_700_000_000_000 },
        processGeneration: () => 1,
        operationWorkingDirectory,
        deleteThread: vi.fn(),
      }),
    );

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.4", input: "hello" }),
    });

    expect(response.status).toBe(409);
    expect(sequence).toEqual(["acquire", "reserve", "release"]);
    expect(release).toHaveBeenCalledOnce();
  });
});
