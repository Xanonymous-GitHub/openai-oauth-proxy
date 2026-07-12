import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { createDataApp } from "../src/app.js";
import {
  fakeModel,
  fakeModelListResponse,
  fakeThreadStartResponse,
  fakeTurn,
} from "../src/codex/fake.js";
import type { CodexHost, HostNotification } from "../src/codex/host.js";
import { ConversationStore } from "../src/conversations/store.js";
import { start } from "../src/main.js";
import { recoverResponseOperations } from "../src/openai/responses.js";
import { TurnCapacity } from "../src/operations/capacity.js";

const testDataDir = mkdtempSync(join(tmpdir(), "app-start-"));

afterAll(() => rmSync(testDataDir, { recursive: true, force: true }));

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function probe(port: number, path: string): Promise<number> {
  try {
    return (await fetch(`http://127.0.0.1:${port}${path}`)).status;
  } catch {
    return 0;
  }
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class EventQueue implements AsyncIterable<HostNotification> {
  readonly #values: HostNotification[] = [];
  readonly #waiters: Array<{
    resolve(value: IteratorResult<HostNotification>): void;
  }> = [];

  push(event: Omit<HostNotification, "generation">): void {
    const value = { ...event, generation: 1 } as HostNotification;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.#values.push(value);
  }

  [Symbol.asyncIterator](): AsyncIterator<HostNotification> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value) return { done: false, value };
        return new Promise((resolve) => this.#waiters.push({ resolve }));
      },
    };
  }
}

it("exposes minimal probes and rejects unknown v1 routes", async () => {
  let draining = false;
  let ready = false;
  let accountReady = false;
  const app = createDataApp({
    health: () => true,
    ready: () => ready,
    accountReady: () => accountReady,
    draining: () => draining,
    bifrostToken: "b".repeat(32),
    metricsToken: "m".repeat(32),
    host: {
      generation: 0,
      modelList: async () => ({ data: [], nextCursor: null }),
    },
  });
  expect((await app.request("/healthz")).status).toBe(200);
  expect((await app.request("/readyz")).status).toBe(503);
  const unavailable = await app.request("/v1/models", {
    headers: { authorization: `Bearer ${"b".repeat(32)}` },
  });
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({
    error: {
      message: "Service unavailable",
      type: "server_error",
      param: null,
      code: "authentication_required",
    },
  });
  const unauthenticated = await app.request("/v1/models");
  expect(unauthenticated.status).toBe(401);
  ready = true;
  accountReady = true;
  const missing = await app.request("/v1/embeddings", {
    headers: { authorization: `Bearer ${"b".repeat(32)}` },
  });
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({
    error: { type: "invalid_request_error", code: "unsupported_endpoint" },
  });

  draining = true;
  expect((await app.request("/healthz")).status).toBe(500);
  expect((await app.request("/readyz")).status).toBe(503);
});

it("serves the admin app, not the data app, on the admin listener", async () => {
  let adminPort = await availablePort();
  while (adminPort === 8081) adminPort = await availablePort();
  const supervisor = {
    health: () => true,
    ready: () => false,
    start: () => new Promise<never>(() => undefined),
    stop: async () => undefined,
  };
  const service = await start(
    {
      dataHost: "0.0.0.0",
      dataPort: 0,
      adminHost: "127.0.0.1",
      adminPort,
      dataDir: testDataDir,
      codexHome: join(testDataDir, "codex"),
      codexBin: "codex",
      bifrostProxyToken: "b".repeat(32),
      metricsToken: "m".repeat(32),
      maxActiveTurns: 4,
      queueCapacity: 32,
      turnTimeoutMs: 600_000,
      toolTimeoutMs: 900_000,
      responseTtlMs: 604_800_000,
    },
    { supervisor },
  );

  try {
    const page = await fetch(`http://127.0.0.1:${adminPort}/`);
    const dataRoute = await fetch(`http://127.0.0.1:${adminPort}/healthz`);
    expect(page.status).toBe(200);
    expect(page.headers.get("x-request-id")).toMatch(/^req_/);
    expect(await page.text()).toContain("Codex authentication");
    expect(dataRoute.status).toBe(404);

    const state = await fetch(`http://127.0.0.1:${adminPort}/api/state`);
    const cookie = state.headers.get("set-cookie")?.split(";", 1)[0];
    const { csrfToken } = (await state.json()) as { csrfToken: string };
    expect(cookie).toBeDefined();
    if (!cookie) return;
    const refresh = (origin: string) =>
      fetch(`http://127.0.0.1:${adminPort}/api/refresh`, {
        method: "POST",
        headers: {
          cookie,
          origin,
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: "{}",
      });

    expect((await refresh("http://127.0.0.1:8081")).status).toBe(403);
    expect((await refresh(`http://0.0.0.0:${adminPort}`)).status).toBe(403);
    expect((await refresh(`http://127.0.0.1:${adminPort}`)).status).toBe(200);
    expect((await refresh(`http://localhost:${adminPort}`)).status).toBe(200);
  } finally {
    await service.close();
  }
});

it("starts two listeners and removes shutdown handlers when closed", async () => {
  const databasePath = join(testDataDir, "proxy.sqlite");
  writeFileSync(databasePath, "", { flag: "a" });
  chmodSync(databasePath, 0o666);
  const sigintListeners = process.listenerCount("SIGINT");
  const sigtermListeners = process.listenerCount("SIGTERM");
  let starts = 0;
  let stops = 0;
  const host = new Promise<never>(() => undefined);
  const openStore = vi.spyOn(ConversationStore, "open");
  const closeStore = vi.spyOn(ConversationStore.prototype, "close");
  const startSupervisor = vi.fn(() => {
    starts += 1;
    return host;
  });
  const supervisor = {
    health: () => true,
    ready: () => true,
    start: startSupervisor,
    stop: async () => {
      stops += 1;
    },
  };
  const service = await start(
    {
      dataHost: "0.0.0.0",
      dataPort: 0,
      adminHost: "127.0.0.1",
      adminPort: 0,
      dataDir: testDataDir,
      codexHome: join(testDataDir, "codex"),
      codexBin: "codex",
      bifrostProxyToken: "b".repeat(32),
      metricsToken: "m".repeat(32),
      maxActiveTurns: 4,
      queueCapacity: 32,
      turnTimeoutMs: 600_000,
      toolTimeoutMs: 900_000,
      responseTtlMs: 604_800_000,
    },
    { supervisor },
  );

  expect(starts).toBe(1);
  expect(statSync(databasePath).mode & 0o777).toBe(0o600);
  expect(openStore).toHaveBeenCalledWith(
    databasePath,
    expect.objectContaining({ now: expect.any(Function) }),
    {
      responseTtlMs: 604_800_000,
      turnLeaseMs: 600_000,
      toolLeaseMs: 900_000,
    },
  );
  expect(openStore.mock.invocationCallOrder[0]).toBeLessThan(
    startSupervisor.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
  );
  expect(process.listenerCount("SIGINT")).toBe(sigintListeners + 1);
  expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners + 1);
  const firstClose = service.close();
  const secondClose = service.close();
  expect(firstClose).toBe(secondClose);
  await firstClose;
  expect(stops).toBe(1);
  expect(closeStore).toHaveBeenCalledOnce();
  expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
  expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
  openStore.mockRestore();
  closeStore.mockRestore();
});

it("closes the conversation store when listener startup and supervisor cleanup fail", async () => {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "0.0.0.0", resolve));
  const port = (blocker.address() as AddressInfo).port;
  const closeStore = vi.spyOn(ConversationStore.prototype, "close");
  const supervisor = {
    health: () => true,
    ready: () => false,
    start: vi.fn(() => new Promise<never>(() => undefined)),
    stop: vi.fn(async () => {
      throw new Error("supervisor cleanup failed");
    }),
  };

  try {
    await expect(
      start(
        {
          dataHost: "0.0.0.0",
          dataPort: port,
          adminHost: "127.0.0.1",
          adminPort: 0,
          dataDir: testDataDir,
          codexHome: join(testDataDir, "codex"),
          codexBin: "codex",
          bifrostProxyToken: "b".repeat(32),
          metricsToken: "m".repeat(32),
          maxActiveTurns: 4,
          queueCapacity: 32,
          turnTimeoutMs: 600_000,
          toolTimeoutMs: 900_000,
          responseTtlMs: 604_800_000,
        },
        { supervisor },
      ),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(supervisor.start).not.toHaveBeenCalled();
    expect(closeStore).toHaveBeenCalledOnce();
  } finally {
    closeStore.mockRestore();
    await new Promise<void>((resolve, reject) =>
      blocker.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("serves probes during initial recovery and after terminal exhaustion", async () => {
  const dataPort = await availablePort();
  let healthy = true;
  let rejectStart: ((error: Error) => void) | undefined;
  let stops = 0;
  const host = new Promise<never>((_resolve, reject) => {
    rejectStart = reject;
  });
  const supervisor = {
    health: () => healthy,
    ready: () => false,
    start: () => host,
    stop: async () => {
      stops += 1;
    },
  };
  const servicePromise = start(
    {
      dataHost: "0.0.0.0",
      dataPort,
      adminHost: "127.0.0.1",
      adminPort: 0,
      dataDir: testDataDir,
      codexHome: join(testDataDir, "codex"),
      codexBin: "codex",
      bifrostProxyToken: "b".repeat(32),
      metricsToken: "m".repeat(32),
      maxActiveTurns: 4,
      queueCapacity: 32,
      turnTimeoutMs: 600_000,
      toolTimeoutMs: 900_000,
      responseTtlMs: 604_800_000,
    },
    { supervisor },
  ).catch(() => undefined);

  await nextTurn();
  const initialHealth = await probe(dataPort, "/healthz");
  const initialReadiness = await probe(dataPort, "/readyz");
  healthy = false;
  rejectStart?.(new Error("recovery budget exhausted"));
  await nextTurn();
  const terminalHealth = await probe(dataPort, "/healthz");
  const terminalReadiness = await probe(dataPort, "/readyz");
  const service = await servicePromise;

  expect(initialHealth).toBe(200);
  expect(initialReadiness).toBe(503);
  expect(terminalHealth).toBe(500);
  expect(terminalReadiness).toBe(503);
  expect(service).toBeDefined();
  if (!service) return;
  await expect(service.host).rejects.toThrow("recovery budget exhausted");
  await service.close();
  expect(stops).toBe(1);
});

it("rejects model requests before the first host is ready without a generation-zero load", async () => {
  const dataPort = await availablePort();
  let supervisorReady = false;
  let resolveHost!: (host: CodexHost) => void;
  const hostPromise = new Promise<CodexHost>((resolve) => {
    resolveHost = resolve;
  });
  const modelList = vi.fn(async () => fakeModelListResponse());
  const supervisor = {
    health: () => true,
    ready: () => supervisorReady,
    start: () => hostPromise,
    stop: async () => undefined,
  };
  const service = await start(
    {
      dataHost: "0.0.0.0",
      dataPort,
      adminHost: "127.0.0.1",
      adminPort: 0,
      dataDir: testDataDir,
      codexHome: join(testDataDir, "codex"),
      codexBin: "codex",
      bifrostProxyToken: "b".repeat(32),
      metricsToken: "m".repeat(32),
      maxActiveTurns: 4,
      queueCapacity: 32,
      turnTimeoutMs: 600_000,
      toolTimeoutMs: 900_000,
      responseTtlMs: 604_800_000,
    },
    { supervisor },
  );

  try {
    const request = fetch(`http://127.0.0.1:${dataPort}/v1/models`, {
      headers: { authorization: `Bearer ${"b".repeat(32)}` },
    });
    const beforeReady = await Promise.race([
      request,
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), 250),
      ),
    ]);
    expect(modelList).not.toHaveBeenCalled();

    supervisorReady = true;
    resolveHost({
      generation: 7,
      modelList,
      accountRead: async () => ({
        account: {
          type: "chatgpt" as const,
          email: "person@example.com",
          planType: "plus" as const,
        },
        requiresOpenaiAuth: true,
      }),
    } as unknown as CodexHost);
    const initialResponse = await request;
    await nextTurn();
    const readyResponse = await fetch(
      `http://127.0.0.1:${dataPort}/v1/models`,
      { headers: { authorization: `Bearer ${"b".repeat(32)}` } },
    );

    expect(beforeReady).not.toBe("pending");
    expect(initialResponse.status).toBe(503);
    expect(await initialResponse.json()).toEqual({
      error: {
        message: "Service unavailable",
        type: "server_error",
        param: null,
        code: "authentication_required",
      },
    });
    expect(readyResponse.status).toBe(200);
    expect(modelList).toHaveBeenCalledTimes(1);
  } finally {
    await service.close();
  }
});

it("serves Chat and Responses through the production listener after host readiness", async () => {
  const dataPort = await availablePort();
  const events = new EventQueue();
  let resolveHost!: (host: CodexHost) => void;
  const hostPromise = new Promise<CodexHost>((resolve) => {
    resolveHost = resolve;
  });
  const threadDelete = vi.fn(async () => ({}));
  const host = {
    generation: 1,
    accountRead: vi.fn(async () => ({
      account: {
        type: "chatgpt" as const,
        email: "person@example.com",
        planType: "plus" as const,
      },
      requiresOpenaiAuth: true,
    })),
    modelList: vi.fn(async () =>
      fakeModelListResponse({
        data: [fakeModel({ id: "gpt-5.4", model: "gpt-5.4" })],
      }),
    ),
    threadStart: vi.fn(async () => fakeThreadStartResponse()),
    threadInjectItems: vi.fn(async () => ({})),
    threadDelete,
    turnStart: vi.fn(async () => {
      events.push({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          completedAtMs: 1,
          item: {
            type: "agentMessage",
            id: "message-1",
            text: "production answer",
            phase: null,
            memoryCitation: null,
          },
        },
      });
      events.push({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: fakeTurn({ id: "turn-1", status: "completed" }),
        },
      });
      return { turn: fakeTurn() };
    }),
    turnInterrupt: vi.fn(async () => ({})),
    events: vi.fn(() => events),
  } as unknown as CodexHost;
  const supervisor = {
    health: () => true,
    ready: () => true,
    start: () => hostPromise,
    stop: async () => undefined,
  };
  const service = await start(
    {
      dataHost: "0.0.0.0",
      dataPort,
      adminHost: "127.0.0.1",
      adminPort: 0,
      dataDir: testDataDir,
      codexHome: join(testDataDir, "codex"),
      codexBin: "codex",
      bifrostProxyToken: "b".repeat(32),
      metricsToken: "m".repeat(32),
      maxActiveTurns: 4,
      queueCapacity: 32,
      turnTimeoutMs: 600_000,
      toolTimeoutMs: 900_000,
      responseTtlMs: 604_800_000,
    },
    { supervisor },
  );

  try {
    resolveHost(host);
    await service.host;
    await nextTurn();
    const response = await fetch(
      `http://127.0.0.1:${dataPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${"b".repeat(32)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          messages: [{ role: "user", content: "hello" }],
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      object: "chat.completion",
      model: "gpt-5.4",
      choices: [
        { message: { role: "assistant", content: "production answer" } },
      ],
    });
    const responses = await fetch(`http://127.0.0.1:${dataPort}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${"b".repeat(32)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-5.4", input: "hello" }),
    });

    expect(responses.status).toBe(200);
    const responseBody = (await responses.json()) as { id: string };
    expect(responseBody).toMatchObject({
      object: "response",
      status: "completed",
      model: "gpt-5.4",
      output: [
        {
          role: "assistant",
          content: [{ type: "output_text", text: "production answer" }],
        },
      ],
    });
    expect(host.threadStart).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cwd: `/tmp/response-operations/${responseBody.id}`,
      }),
      expect.any(AbortSignal),
    );
    expect(threadDelete).toHaveBeenCalledOnce();
  } finally {
    await service.close();
  }
});

it("aborts hung Responses cleanup at the drain deadline and retains reconciliation identity", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "responses-cleanup-drain-"));
  const dataPort = await availablePort();
  const adminPort = await availablePort();
  const events = new EventQueue();
  const capacity = new TurnCapacity(1, 0);
  const logger = vi.fn();
  const stopSupervisor = vi.fn(async () => undefined);
  const closeStore = vi.spyOn(ConversationStore.prototype, "close");
  const sigintListeners = process.listenerCount("SIGINT");
  const sigtermListeners = process.listenerCount("SIGTERM");
  let releaseDelete = (): void => undefined;
  let allowDelete = false;
  let deletionSignal: AbortSignal | undefined;
  const threadDelete = vi.fn(
    async (_params: { threadId: string }, signal?: AbortSignal) => {
      if (allowDelete) return {};
      deletionSignal = signal;
      await new Promise<void>((resolve, reject) => {
        releaseDelete = resolve;
        signal?.addEventListener(
          "abort",
          () =>
            reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
      return {};
    },
  );
  const host = {
    generation: 1,
    accountRead: vi.fn(async () => ({
      account: {
        type: "chatgpt" as const,
        email: "person@example.com",
        planType: "plus" as const,
      },
      requiresOpenaiAuth: true,
    })),
    modelList: vi.fn(async () =>
      fakeModelListResponse({
        data: [fakeModel({ id: "gpt-5.4", model: "gpt-5.4" })],
      }),
    ),
    threadStart: vi.fn(async () => fakeThreadStartResponse()),
    threadList: vi.fn(async () => ({
      data: [],
      nextCursor: null,
      backwardsCursor: null,
    })),
    threadInjectItems: vi.fn(async () => ({})),
    threadDelete,
    turnStart: vi.fn(async () => {
      events.push({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          completedAtMs: 1,
          item: {
            type: "agentMessage",
            id: "message-1",
            text: "disposable answer",
            phase: null,
            memoryCitation: null,
          },
        },
      });
      events.push({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: fakeTurn({ id: "turn-1", status: "completed" }),
        },
      });
      return { turn: fakeTurn() };
    }),
    turnInterrupt: vi.fn(async () => ({})),
    events: vi.fn(() => events),
  } as unknown as CodexHost;
  const supervisor = {
    health: () => true,
    ready: () => true,
    start: async () => host,
    stop: stopSupervisor,
  };
  const service = await start(
    {
      dataHost: "0.0.0.0",
      dataPort,
      adminHost: "127.0.0.1",
      adminPort,
      dataDir,
      codexHome: join(dataDir, "codex"),
      codexBin: "codex",
      bifrostProxyToken: "b".repeat(32),
      metricsToken: "m".repeat(32),
      maxActiveTurns: 1,
      queueCapacity: 0,
      turnTimeoutMs: 600_000,
      toolTimeoutMs: 900_000,
      responseTtlMs: 604_800_000,
    },
    { supervisor, capacity, logger, drainTimeoutMs: 30_000 },
  );
  let request: Promise<Response> | undefined;

  try {
    await service.host;
    await nextTurn();
    request = fetch(`http://127.0.0.1:${dataPort}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${"b".repeat(32)}`,
        connection: "close",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        input: "disposable",
        store: false,
      }),
    });
    await vi.waitFor(() => expect(threadDelete).toHaveBeenCalledOnce());
    expect(deletionSignal).toBeInstanceOf(AbortSignal);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const closing = service.close();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(stopSupervisor).not.toHaveBeenCalled();
    expect(closeStore).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await closing;
    vi.useRealTimers();
    const response = await request;

    expect(response.status).toBe(500);
    expect(deletionSignal?.aborted).toBe(true);
    expect(capacity.active).toBe(0);
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "responses",
        queueOutcome: "admitted",
        leaseOutcome: "released",
      }),
    );
    expect(stopSupervisor).toHaveBeenCalledOnce();
    expect(closeStore).toHaveBeenCalledOnce();
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
    expect(await probe(dataPort, "/healthz")).toBe(0);
    expect(await probe(adminPort, "/")).toBe(0);

    closeStore.mockRestore();
    const store = ConversationStore.open(
      join(dataDir, "proxy.sqlite"),
      { now: () => Date.now() },
      {
        responseTtlMs: 604_800_000,
        turnLeaseMs: 600_000,
        toolLeaseMs: 900_000,
      },
    );
    try {
      const [operation] = store.abandonedOperations();
      expect(operation).toMatchObject({
        state: "abandoned",
        threadId: "thread-1",
        stored: false,
      });
      allowDelete = true;
      await recoverResponseOperations({ store, host });
      expect(
        store.lookupOperation(operation?.responseId ?? "missing"),
      ).toBeUndefined();
    } finally {
      store.close();
    }
  } finally {
    releaseDelete();
    vi.useRealTimers();
    await service.close().catch(() => undefined);
    await request?.catch(() => undefined);
    closeStore.mockRestore();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
