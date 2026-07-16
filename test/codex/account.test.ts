import { expect, it, vi } from "vitest";
import { createAdminApp } from "../../src/admin/app.js";
import { SessionStore } from "../../src/admin/sessions.js";
import { AccountManager } from "../../src/codex/account.js";
import type { GetAccountResponse } from "../../src/codex/generated/v2/GetAccountResponse.js";
import type { CodexHost, HostNotification } from "../../src/codex/host.js";
import { eventDispatcherFor } from "../../src/turns/events.js";

class EventQueue implements AsyncIterable<HostNotification> {
  readonly #values: HostNotification[] = [];
  readonly #waiters: Array<(value: IteratorResult<HostNotification>) => void> =
    [];

  push(event: HostNotification): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else this.#values.push(event);
  }

  [Symbol.asyncIterator](): AsyncIterator<HostNotification> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value) return { done: false, value };
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeHost(
  accountReadImplementation: CodexHost["accountRead"] = async () => ({
    account: {
      type: "chatgpt" as const,
      email: "person@example.com",
      planType: "plus" as const,
    },
    requiresOpenaiAuth: true,
  }),
) {
  const events = new EventQueue();
  const accountRead = vi.fn(accountReadImplementation);
  const loginStart = vi.fn<CodexHost["loginStart"]>(async () => ({
    type: "chatgptDeviceCode" as const,
    loginId: "login-1",
    verificationUrl: "https://example.com/device",
    userCode: "ABCD-EFGH",
  }));
  const logout = vi.fn(async () => ({}));
  const host = {
    generation: 1,
    accountRead,
    loginStart,
    loginCancel: vi.fn(async () => ({ status: "canceled" as const })),
    logout,
    events: vi.fn(() => events),
  } as unknown as CodexHost;
  return { host, events, accountRead, loginStart, logout };
}

it.each([
  [null, { type: "signed_out" }],
  [{ type: "apiKey" as const }, { type: "signed_out" }],
  [
    {
      type: "amazonBedrock" as const,
      credentialSource: "awsManaged" as const,
    },
    { type: "signed_out" },
  ],
])(
  "forces startup refresh and rejects a non-ChatGPT account",
  async (account, expected) => {
    const fixture = fakeHost(
      vi.fn(async () => ({ account, requiresOpenaiAuth: true })),
    );
    const manager = new AccountManager(fixture.host);

    await manager.start();

    expect(fixture.accountRead).toHaveBeenCalledWith(true);
    expect(manager.state()).toEqual(expected);
    expect(manager.ready()).toBe(false);
  },
);

it("makes only a ChatGPT account ready", async () => {
  const fixture = fakeHost();
  const manager = new AccountManager(fixture.host);

  await manager.start();

  expect(manager.state()).toEqual({
    type: "ready",
    email: "person@example.com",
    planType: "plus",
  });
  expect(manager.ready()).toBe(true);
});

it("keeps liveness while startup and refresh failures remove readiness", async () => {
  const fixture = fakeHost(
    vi.fn().mockRejectedValue(new Error("auth.json / secret-token")),
  );
  const manager = new AccountManager(fixture.host);

  await expect(manager.start()).resolves.toBeUndefined();

  expect(manager.state()).toEqual({
    type: "error",
    code: "authentication_required",
  });
  expect(manager.ready()).toBe(false);
  expect(JSON.stringify(manager.state())).not.toMatch(
    /auth\.json|secret-token/,
  );
});

it("uses the central dispatcher for account notifications and only consumes events once", async () => {
  const fixture = fakeHost();
  const dispatcher = eventDispatcherFor(fixture.host);
  const manager = new AccountManager(fixture.host, dispatcher);
  const turn = dispatcher.register("thread-1", 1);
  await manager.start();
  fixture.accountRead.mockClear();

  fixture.events.push({
    generation: 1,
    method: "account/updated",
    params: { authMode: "chatgpt", planType: "pro" },
  });
  await flush();

  expect(fixture.host.events).toHaveBeenCalledOnce();
  expect(fixture.accountRead).toHaveBeenCalledWith(true);
  turn.close();
});

it("correlates login completion IDs and never exposes protocol errors", async () => {
  const fixture = fakeHost();
  const manager = new AccountManager(fixture.host);
  await manager.start();
  await manager.login();
  fixture.accountRead.mockClear();

  fixture.events.push({
    generation: 1,
    method: "account/login/completed",
    params: { loginId: "other-login", success: true, error: null },
  });
  await flush();
  expect(fixture.accountRead).not.toHaveBeenCalled();

  fixture.events.push({
    generation: 1,
    method: "account/login/completed",
    params: {
      loginId: "login-1",
      success: false,
      error: "access-token at /home/person/.codex/auth.json",
    },
  });
  await flush();

  expect(manager.state()).toEqual({
    type: "error",
    code: "authentication_required",
  });
  expect(JSON.stringify(manager.state())).not.toMatch(
    /access-token|auth\.json/,
  );
});

it("re-reads a new generation and ignores stale notifications and reads", async () => {
  let resolveOld!: (value: {
    account: { type: "chatgpt"; email: string; planType: "plus" };
    requiresOpenaiAuth: boolean;
  }) => void;
  const oldRead = new Promise<{
    account: { type: "chatgpt"; email: string; planType: "plus" };
    requiresOpenaiAuth: boolean;
  }>((resolve) => {
    resolveOld = resolve;
  });
  const accountRead = vi
    .fn()
    .mockImplementationOnce(() => oldRead)
    .mockResolvedValueOnce({
      account: {
        type: "chatgpt" as const,
        email: "new@example.com",
        planType: "pro" as const,
      },
      requiresOpenaiAuth: true,
    });
  const fixture = fakeHost(accountRead);
  const manager = new AccountManager(fixture.host);
  const started = manager.start();

  Object.defineProperty(fixture.host, "generation", { value: 2 });
  expect(manager.ready()).toBe(false);
  expect(manager.ready()).toBe(false);
  expect(manager.ready()).toBe(false);
  expect(accountRead).toHaveBeenCalledTimes(2);
  await flush();
  resolveOld({
    account: {
      type: "chatgpt",
      email: "stale@example.com",
      planType: "plus",
    },
    requiresOpenaiAuth: true,
  });
  await started;
  await flush();

  expect(accountRead).toHaveBeenCalledTimes(2);
  expect(manager.state()).toEqual({
    type: "ready",
    email: "new@example.com",
    planType: "pro",
  });
  fixture.events.push({
    generation: 1,
    method: "account/updated",
    params: { authMode: null, planType: null },
  });
  await flush();
  expect(accountRead).toHaveBeenCalledTimes(2);
});

it("supports device login, cancel, refresh, and immediate logout readiness removal", async () => {
  const fixture = fakeHost();
  const manager = new AccountManager(fixture.host);
  await manager.start();

  await expect(manager.login()).resolves.toEqual({
    type: "login_pending",
    loginId: "login-1",
    verificationUrl: "https://example.com/device",
    userCode: "ABCD-EFGH",
  });
  expect(fixture.host.loginStart).toHaveBeenCalledWith({
    type: "chatgptDeviceCode",
  });
  await manager.cancel();
  expect(fixture.host.loginCancel).toHaveBeenCalledWith({ loginId: "login-1" });
  await manager.refresh();
  expect(fixture.accountRead).toHaveBeenLastCalledWith(true);

  const logout = manager.logout();
  expect(manager.ready()).toBe(false);
  expect(manager.state()).toEqual({ type: "signed_out" });
  await logout;
  expect(fixture.host.logout).toHaveBeenCalledOnce();
});

it("prevents a pending account read from overwriting device login state", async () => {
  let resolveRefresh!: (value: GetAccountResponse) => void;
  const refreshResult = new Promise<GetAccountResponse>((resolve) => {
    resolveRefresh = resolve;
  });
  const fixture = fakeHost(
    vi
      .fn<CodexHost["accountRead"]>()
      .mockResolvedValueOnce({
        account: {
          type: "chatgpt",
          email: "person@example.com",
          planType: "plus",
        },
        requiresOpenaiAuth: true,
      })
      .mockImplementationOnce(() => refreshResult),
  );
  const manager = new AccountManager(fixture.host);
  await manager.start();

  const refresh = manager.refresh();
  await manager.login();
  resolveRefresh({ account: null, requiresOpenaiAuth: true });
  await refresh;

  expect(manager.state()).toMatchObject({
    type: "login_pending",
    loginId: "login-1",
  });
});

it("ignores a delayed login response after logout", async () => {
  let resolveLogin!: (
    value: Awaited<ReturnType<CodexHost["loginStart"]>>,
  ) => void;
  const loginResult = new Promise<Awaited<ReturnType<CodexHost["loginStart"]>>>(
    (resolve) => {
      resolveLogin = resolve;
    },
  );
  const fixture = fakeHost();
  fixture.loginStart.mockImplementationOnce(() => loginResult);
  const manager = new AccountManager(fixture.host);
  await manager.start();

  const login = manager.login();
  await manager.logout();
  resolveLogin({
    type: "chatgptDeviceCode",
    loginId: "late-login",
    verificationUrl: "https://example.com/device",
    userCode: "LATE-CODE",
  });

  await expect(login).rejects.toThrow("Device login unavailable");
  expect(manager.state()).toEqual({ type: "signed_out" });
});

it("does not let account updates start reads while logout is active", async () => {
  let resolveLogout!: () => void;
  const fixture = fakeHost(
    vi
      .fn<CodexHost["accountRead"]>()
      .mockResolvedValueOnce({
        account: {
          type: "chatgpt",
          email: "person@example.com",
          planType: "plus",
        },
        requiresOpenaiAuth: true,
      })
      .mockResolvedValueOnce({
        account: {
          type: "chatgpt",
          email: "old-account@example.com",
          planType: "plus",
        },
        requiresOpenaiAuth: true,
      }),
  );
  fixture.logout.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveLogout = () => resolve({});
      }),
  );
  const manager = new AccountManager(fixture.host);
  await manager.start();

  const logout = manager.logout();
  fixture.events.push({
    generation: 1,
    method: "account/updated",
    params: { authMode: "chatgpt", planType: "plus" },
  });
  fixture.events.push({
    generation: 1,
    method: "account/login/completed",
    params: { loginId: "login-1", success: true, error: null },
  });
  await flush();

  expect(fixture.accountRead).toHaveBeenCalledOnce();
  expect(manager.state()).toEqual({ type: "signed_out" });
  resolveLogout();
  await logout;
  expect(manager.state()).toEqual({ type: "signed_out" });
});

it("keeps successful logout authoritative over forced and notification reads", async () => {
  let resolveForcedRead!: (value: GetAccountResponse) => void;
  let resolveLogout!: () => void;
  const forcedRead = new Promise<GetAccountResponse>((resolve) => {
    resolveForcedRead = resolve;
  });
  const fixture = fakeHost(
    vi
      .fn<CodexHost["accountRead"]>()
      .mockResolvedValueOnce({
        account: {
          type: "chatgpt",
          email: "person@example.com",
          planType: "plus",
        },
        requiresOpenaiAuth: true,
      })
      .mockImplementationOnce(() => forcedRead)
      .mockResolvedValueOnce({
        account: {
          type: "chatgpt",
          email: "old-account@example.com",
          planType: "plus",
        },
        requiresOpenaiAuth: true,
      }),
  );
  fixture.logout.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveLogout = () => resolve({});
      }),
  );
  const manager = new AccountManager(fixture.host);
  await manager.start();

  const refresh = manager.refresh();
  const logout = manager.logout();
  fixture.events.push({
    generation: 1,
    method: "account/updated",
    params: { authMode: "chatgpt", planType: "plus" },
  });
  await flush();
  resolveLogout();
  await logout;
  resolveForcedRead({
    account: {
      type: "chatgpt",
      email: "old-account@example.com",
      planType: "plus",
    },
    requiresOpenaiAuth: true,
  });
  await refresh;
  await flush();

  expect(fixture.accountRead).toHaveBeenCalledTimes(2);
  expect(manager.state()).toEqual({ type: "signed_out" });
  expect(manager.ready()).toBe(false);
});

it("serializes only safe fields from real account transitions", async () => {
  const fixture = fakeHost();
  const manager = new AccountManager(fixture.host);
  const app = createAdminApp({
    account: manager,
    sessions: new SessionStore(),
    allowedOrigins: new Set(["http://127.0.0.1:8081"]),
    assetRoot: "/missing-admin-assets",
  });
  const serializedState = async () => {
    const response = await app.request("/api/state");
    const text = await response.text();
    const body = JSON.parse(text) as { state: Record<string, unknown> };
    return { state: body.state, text };
  };
  const assertSafe = (
    state: Record<string, unknown>,
    text: string,
    keys: string[],
  ) => {
    expect(Object.keys(state).sort()).toEqual(keys.sort());
    expect(text).not.toMatch(
      /auth\.json|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|credential|\/home\//i,
    );
  };

  await manager.start();
  const ready = await serializedState();
  assertSafe(ready.state, ready.text, ["email", "planType", "type"]);

  await manager.login();
  const pending = await serializedState();
  assertSafe(pending.state, pending.text, [
    "loginId",
    "type",
    "userCode",
    "verificationUrl",
  ]);

  fixture.events.push({
    generation: 1,
    method: "account/login/completed",
    params: {
      loginId: "login-1",
      success: false,
      error: "access_token from /home/person/.codex/auth.json",
    },
  });
  await flush();
  const error = await serializedState();
  assertSafe(error.state, error.text, ["code", "type"]);

  await manager.logout();
  const signedOut = await serializedState();
  assertSafe(signedOut.state, signedOut.text, ["type"]);
});
