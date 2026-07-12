import { expect, it, vi } from "vitest";
import { createDataApp } from "../../src/app.js";
import { fakeModel, fakeModelListResponse } from "../../src/codex/fake.js";
import type { CodexHost } from "../../src/codex/host.js";
import { ModelCatalog } from "../../src/openai/models.js";

const bifrostToken = "b".repeat(32);
const metricsToken = "m".repeat(32);

function createHost() {
  return {
    generation: 1,
    modelList: vi.fn(async () => fakeModelListResponse()),
  } as unknown as CodexHost;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function createApp(host: CodexHost) {
  return createDataApp({
    health: () => true,
    ready: () => true,
    accountReady: () => true,
    draining: () => false,
    bifrostToken,
    metricsToken,
    host,
  });
}

function get(
  app: ReturnType<typeof createApp>,
  path = "/v1/models",
  token?: string,
) {
  return app.request(path, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

it("authenticates every v1 route before route handling", async () => {
  const app = createApp(createHost());

  for (const response of [
    await get(app),
    await get(app, "/v1/models", "wrong"),
    await get(app, "/v1/not-a-route"),
  ]) {
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        message: "Missing or invalid bearer token",
        type: "authentication_error",
        param: null,
        code: "invalid_api_key",
      },
    });
  }

  expect((await get(app, "/v1/not-a-route", bifrostToken)).status).toBe(404);
});

it("reserves the metrics token for the metrics route", async () => {
  const app = createApp(createHost());

  expect((await get(app, "/metrics", bifrostToken)).status).toBe(401);
  expect((await get(app, "/metrics", metricsToken)).status).toBe(200);
  expect((await app.request("/healthz")).status).toBe(200);
});

it("lists only visible text models and preserves exact App Server IDs", async () => {
  const host = createHost();
  const missingModalities = fakeModel({ id: "gpt-5.4", model: "different" });
  delete (missingModalities as { inputModalities?: unknown }).inputModalities;
  vi.mocked(host.modelList).mockResolvedValueOnce(
    fakeModelListResponse({
      data: [
        missingModalities,
        fakeModel({ id: "hidden", hidden: true }),
        fakeModel({ id: "image-only", inputModalities: ["image"] }),
      ],
    }),
  );

  const response = await get(createApp(host), "/v1/models", bifrostToken);

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    object: "list",
    data: [
      {
        id: "gpt-5.4",
        object: "model",
        created: 0,
        owned_by: "openai",
      },
    ],
  });
  expect(host.modelList).toHaveBeenCalledWith(
    { includeHidden: false },
    expect.any(AbortSignal),
  );
});

it("loads every model page until nextCursor is null", async () => {
  const host = createHost();
  vi.mocked(host.modelList)
    .mockResolvedValueOnce(
      fakeModelListResponse({
        data: [fakeModel({ id: "first" })],
        nextCursor: "page-2",
      }),
    )
    .mockResolvedValueOnce(
      fakeModelListResponse({ data: [fakeModel({ id: "second" })] }),
    );

  const response = await get(createApp(host), "/v1/models", bifrostToken);
  const body = (await response.json()) as { data: Array<{ id: string }> };

  expect(response.status).toBe(200);
  expect(body.data.map(({ id }) => id)).toEqual(["first", "second"]);
  expect(host.modelList).toHaveBeenNthCalledWith(
    2,
    { cursor: "page-2", includeHidden: false },
    expect.any(AbortSignal),
  );
});

it("rejects a pagination cursor cycle as a sanitized service failure", async () => {
  const host = createHost();
  const secret = "Bearer upstream-secret /data/codex/auth.json";
  vi.mocked(host.modelList)
    .mockResolvedValueOnce(fakeModelListResponse({ nextCursor: secret }))
    .mockResolvedValueOnce(fakeModelListResponse({ nextCursor: secret }));

  const response = await get(createApp(host), "/v1/models", bifrostToken);
  const body = await response.json();

  expect(response.status).toBe(503);
  expect(body).toMatchObject({
    error: { message: "Service unavailable", type: "server_error" },
  });
  expect(JSON.stringify(body)).not.toContain(secret);
  expect(host.modelList).toHaveBeenCalledTimes(2);
});

it("caches for 60 seconds and invalidates immediately on host generation change", async () => {
  vi.useFakeTimers();
  try {
    const host = createHost();
    const app = createApp(host);

    expect((await get(app, "/v1/models", bifrostToken)).status).toBe(200);
    await vi.advanceTimersByTimeAsync(59_999);
    expect((await get(app, "/v1/models", bifrostToken)).status).toBe(200);
    expect(host.modelList).toHaveBeenCalledTimes(1);

    (host as { generation: number }).generation = 2;
    expect((await get(app, "/v1/models", bifrostToken)).status).toBe(200);
    expect(host.modelList).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect((await get(app, "/v1/models", bifrostToken)).status).toBe(200);
    expect(host.modelList).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

it("deduplicates concurrent cold catalog loads", async () => {
  let resolve!: (value: ReturnType<typeof fakeModelListResponse>) => void;
  const pending = new Promise<ReturnType<typeof fakeModelListResponse>>(
    (settle) => {
      resolve = settle;
    },
  );
  const host = createHost();
  vi.mocked(host.modelList).mockReturnValueOnce(pending);
  const app = createApp(host);

  const first = get(app, "/v1/models", bifrostToken);
  const second = get(app, "/v1/models", bifrostToken);
  await vi.waitFor(() => expect(host.modelList).toHaveBeenCalledTimes(1));
  resolve(fakeModelListResponse());

  expect((await first).status).toBe(200);
  expect((await second).status).toBe(200);
  expect(host.modelList).toHaveBeenCalledTimes(1);
});

it("keeps a shared cold load alive when its first waiter aborts", async () => {
  const page = deferred<ReturnType<typeof fakeModelListResponse>>();
  const host = createHost();
  vi.mocked(host.modelList).mockImplementationOnce((_params, signal) => {
    signal?.addEventListener("abort", () => page.reject(signal.reason), {
      once: true,
    });
    return page.promise;
  });
  const catalog = new ModelCatalog(host);
  const firstController = new AbortController();

  const first = catalog.list(firstController.signal);
  const second = catalog.list();
  await vi.waitFor(() => expect(host.modelList).toHaveBeenCalledTimes(1));
  const firstResult = expect(first).rejects.toMatchObject({
    name: "AbortError",
  });
  const secondResult = expect(second).resolves.toMatchObject({
    object: "list",
  });
  firstController.abort();
  page.resolve(fakeModelListResponse());

  await firstResult;
  await secondResult;
  expect(host.modelList).toHaveBeenCalledTimes(1);
});

it("reloads after an in-flight load completes for an old generation", async () => {
  const oldPage = deferred<ReturnType<typeof fakeModelListResponse>>();
  const currentPage = deferred<ReturnType<typeof fakeModelListResponse>>();
  const host = createHost();
  vi.mocked(host.modelList)
    .mockReturnValueOnce(oldPage.promise)
    .mockReturnValueOnce(currentPage.promise);
  const catalog = new ModelCatalog(host);

  const oldWaiter = catalog.list();
  await vi.waitFor(() => expect(host.modelList).toHaveBeenCalledTimes(1));
  (host as { generation: number }).generation = 2;
  const currentWaiter = catalog.list();
  await vi.waitFor(() => expect(host.modelList).toHaveBeenCalledTimes(2));
  oldPage.resolve(
    fakeModelListResponse({ data: [fakeModel({ id: "old-generation" })] }),
  );
  currentPage.resolve(
    fakeModelListResponse({ data: [fakeModel({ id: "current-generation" })] }),
  );

  for (const result of await Promise.all([oldWaiter, currentWaiter])) {
    expect(result.data.map(({ id }) => id)).toEqual(["current-generation"]);
  }
  await expect(catalog.list()).resolves.toMatchObject({
    data: [{ id: "current-generation" }],
  });
  expect(host.modelList).toHaveBeenCalledTimes(2);
});

it("sanitizes host and upstream authentication failures as 503", async () => {
  const secret = "refresh-token /data/codex/auth.json";
  const host = createHost();
  vi.mocked(host.modelList).mockRejectedValueOnce(new Error(secret));

  const response = await get(createApp(host), "/v1/models", bifrostToken);
  const body = await response.json();

  expect(response.status).toBe(503);
  expect(body).toEqual({
    error: {
      message: "Service unavailable",
      type: "server_error",
      param: null,
      code: "codex_unavailable",
    },
  });
  expect(JSON.stringify(body)).not.toContain(secret);
});

it("looks up exact model capabilities without exposing App Server models", async () => {
  const host = createHost();
  vi.mocked(host.modelList).mockResolvedValueOnce(
    fakeModelListResponse({
      data: [
        fakeModel({
          id: "gpt-5.4",
          inputModalities: ["text", "image"],
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast" },
            { reasoningEffort: "high", description: "Thorough" },
          ],
        }),
      ],
    }),
  );
  const catalog = new ModelCatalog(host);

  await expect(catalog.lookup("gpt-5.4")).resolves.toEqual({
    id: "gpt-5.4",
    supportsImage: true,
    supportedReasoningEfforts: ["low", "high"],
  });
  await expect(catalog.lookup("GPT-5.4")).resolves.toBeUndefined();
  expect(host.modelList).toHaveBeenCalledTimes(1);
});
