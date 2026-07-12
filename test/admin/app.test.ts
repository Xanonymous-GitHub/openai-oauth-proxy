import { expect, it, vi } from "vitest";
import { createAdminApp } from "../../src/admin/app.js";
import { SessionStore } from "../../src/admin/sessions.js";
import type { AccountState } from "../../src/codex/account.js";

const allowedOrigins = new Set([
  "http://127.0.0.1:8081",
  "http://localhost:8081",
]);

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function fixture(state: AccountState = { type: "signed_out" }) {
  let now = 0;
  let sequence = 0;
  const account = {
    state: vi.fn(() => state),
    login: vi.fn(async () => ({
      type: "login_pending" as const,
      loginId: "login-1",
      verificationUrl: "https://example.com/device",
      userCode: "ABCD-EFGH",
    })),
    cancel: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
  };
  const randomBytes = vi.fn((size: number) => {
    sequence += 1;
    return Buffer.alloc(size, sequence);
  });
  const sessions = new SessionStore({
    now: () => now,
    randomBytes,
  });
  const app = createAdminApp({ account, sessions, allowedOrigins });
  return {
    account,
    app,
    randomBytes,
    sessions,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

async function sessionFor(app: ReturnType<typeof createAdminApp>) {
  const response = await app.request("/api/state");
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  const body = (await response.json()) as { csrfToken: string };
  if (!cookie) throw new Error("Missing session cookie");
  return { cookie, csrf: body.csrfToken };
}

function post(
  app: ReturnType<typeof createAdminApp>,
  path: string,
  cookie: string,
  csrf: string,
  options: {
    origin?: string | undefined;
    contentType?: string;
    body?: unknown;
  } = {},
) {
  const headers = new Headers({
    cookie,
    "content-type": options.contentType ?? "application/json",
    "x-csrf-token": csrf,
  });
  const origin = Object.hasOwn(options, "origin")
    ? options.origin
    : "http://127.0.0.1:8081";
  if (origin !== undefined) headers.set("origin", origin);
  return app.request(path, {
    method: "POST",
    headers,
    body: JSON.stringify(options.body ?? {}),
  });
}

it("sets opaque 32-byte HttpOnly Strict cookies and does not enable CORS", async () => {
  const { app, randomBytes } = fixture();

  const response = await app.request("/api/state", {
    headers: { origin: "https://attacker.example" },
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toMatch(
    /^codex_admin_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict$/,
  );
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  expect(randomBytes).toHaveBeenCalledTimes(2);
  expect(randomBytes).toHaveBeenNthCalledWith(1, 32);
  expect(randomBytes).toHaveBeenNthCalledWith(2, 32);
});

it.each([
  undefined,
  "null",
  "http://127.0.0.1:8080",
  "http://127.0.0.1:8081.evil.example",
  "http://localhost:8081/",
])("rejects mutating requests without an exact allowed Origin", async (origin) => {
  const { app, account } = fixture();
  const session = await sessionFor(app);

  const response = await post(
    app,
    "/api/logout",
    session.cookie,
    session.csrf,
    {
      origin,
    },
  );

  expect(response.status).toBe(403);
  expect(account.logout).not.toHaveBeenCalled();
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
});

it("accepts both exact loopback origins", async () => {
  const { app, account } = fixture();
  let session = await sessionFor(app);

  expect(
    (await post(app, "/api/refresh", session.cookie, session.csrf)).status,
  ).toBe(200);
  session = await sessionFor(app);
  expect(
    (
      await post(app, "/api/refresh", session.cookie, session.csrf, {
        origin: "http://localhost:8081",
      })
    ).status,
  ).toBe(200);
  expect(account.refresh).toHaveBeenCalledTimes(2);
});

it("rejects missing or wrong CSRF tokens and non-JSON content", async () => {
  const { app, account } = fixture();
  const session = await sessionFor(app);

  const missing = await post(app, "/api/logout", session.cookie, "");
  const wrong = await post(app, "/api/logout", session.cookie, "wrong");
  const form = await post(app, "/api/logout", session.cookie, session.csrf, {
    contentType: "application/x-www-form-urlencoded",
  });

  expect(missing.status).toBe(403);
  expect(wrong.status).toBe(403);
  expect(form.status).toBe(415);
  expect(account.logout).not.toHaveBeenCalled();
});

it("accepts only the device-code login payload and rotates the session", async () => {
  const { app, account } = fixture();
  const session = await sessionFor(app);
  const rejected = await post(app, "/api/login", session.cookie, session.csrf, {
    body: { type: "chatgpt", apiKey: "secret-token" },
  });
  expect(rejected.status).toBe(400);
  expect(account.login).not.toHaveBeenCalled();

  const accepted = await post(app, "/api/login", session.cookie, session.csrf, {
    body: { type: "chatgptDeviceCode" },
  });
  const body = await accepted.json();

  expect(accepted.status).toBe(200);
  expect(accepted.headers.get("set-cookie")).not.toContain(session.cookie);
  expect(body).toMatchObject({
    state: {
      type: "login_pending",
      loginId: "login-1",
      verificationUrl: "https://example.com/device",
      userCode: "ABCD-EFGH",
    },
    csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
  });
  expect(account.login).toHaveBeenCalledOnce();
});

it("delegates cancel, forced refresh, and logout and prevents fixation", async () => {
  const { app, account } = fixture();
  let session = await sessionFor(app);

  expect(
    (await post(app, "/api/cancel", session.cookie, session.csrf)).status,
  ).toBe(200);
  session = await sessionFor(app);
  expect(
    (await post(app, "/api/refresh", session.cookie, session.csrf)).status,
  ).toBe(200);
  session = await sessionFor(app);
  const logout = await post(app, "/api/logout", session.cookie, session.csrf);

  expect(account.cancel).toHaveBeenCalledOnce();
  expect(account.refresh).toHaveBeenCalledOnce();
  expect(account.logout).toHaveBeenCalledOnce();
  expect(logout.headers.get("set-cookie")).not.toContain(session.cookie);

  const fixed = await app.request("/api/state", {
    headers: { cookie: "codex_admin_session=attacker-chosen" },
  });
  expect(fixed.headers.get("set-cookie")).not.toContain("attacker-chosen");
});

it("expires idle sessions after 30 minutes and prunes them", async () => {
  const { app, advance, sessions } = fixture();
  const first = await sessionFor(app);
  expect(sessions.size()).toBe(1);
  advance(30 * 60 * 1000 - 1);
  const active = await app.request("/api/state", {
    headers: { cookie: first.cookie },
  });
  expect(active.headers.get("set-cookie")).toBeNull();

  advance(30 * 60 * 1000 + 1);
  const expired = await app.request("/api/state", {
    headers: { cookie: first.cookie },
  });
  expect(expired.headers.get("set-cookie")).not.toBeNull();
  expect(sessions.size()).toBe(1);
});

it("returns only sanitized account state fields", async () => {
  const state = {
    type: "ready" as const,
    email: "<img src=x onerror=alert(1)>",
    planType: "plus" as const,
  } satisfies AccountState;
  const { app } = fixture(state);

  const response = await app.request("/api/state");
  const body = await response.text();

  expect(JSON.parse(body)).toMatchObject({ state });
  expect(body).not.toMatch(/auth\.json|accessToken|refreshToken|idToken/);
});

it("serves a framework-free page and external script under a restrictive CSP", async () => {
  const { app } = fixture();

  const page = await app.request("/");
  const html = await page.text();
  const script = await app.request("/app.js");
  const javascript = await script.text();

  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toBe(
    "default-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  expect(html).toContain('<script src="/app.js" defer></script>');
  expect(html).toMatch(/<form|<button/);
  expect(html).toContain('role="status"');
  expect(javascript).not.toMatch(
    /React|Vue|innerHTML|outerHTML|insertAdjacentHTML/,
  );
  expect(javascript).toContain("textContent");
  expect(javascript).toContain(
    "response.status === 401 || response.status === 403",
  );
});

it("bootstraps a fresh session after a forbidden mutation without rendering missing state", async () => {
  const { app } = fixture();
  const script = await app.request("/app.js");
  const javascript = await script.text();
  const listeners = new Map<string, Map<string, (event?: Event) => void>>();
  const elements = new Map(
    [
      "status",
      "email",
      "plan",
      "verification-url",
      "user-code",
      "login-form",
      "refresh",
      "cancel",
      "logout",
    ].map((id) => [
      id,
      {
        textContent: "",
        addEventListener(type: string, listener: (event?: Event) => void) {
          const byType = listeners.get(id) ?? new Map();
          byType.set(type, listener);
          listeners.set(id, byType);
        },
      },
    ]),
  );
  const document = {
    getElementById(id: string) {
      return elements.get(id);
    },
  };
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        state: { type: "signed_out" },
        csrfToken: "initial-csrf",
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ error: "forbidden" }, { status: 403 }),
    )
    .mockResolvedValueOnce(
      Response.json({
        state: { type: "signed_out" },
        csrfToken: "replacement-csrf",
      }),
    );

  new Function("document", "fetch", javascript)(document, fetchMock);
  await flush();
  listeners.get("refresh")?.get("click")?.();
  await flush();
  await flush();

  expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
    "/api/state",
    "/api/refresh",
    "/api/state",
  ]);
  expect(elements.get("status")?.textContent).toBe("signed_out");
});

it("sanitizes account-operation failures", async () => {
  const { app, account } = fixture();
  account.refresh.mockRejectedValue(
    new Error("refresh-token from /home/person/.codex/auth.json"),
  );
  const session = await sessionFor(app);

  const response = await post(
    app,
    "/api/refresh",
    session.cookie,
    session.csrf,
  );
  const body = await response.text();

  expect(response.status).toBe(503);
  expect(body).toContain("authentication_required");
  expect(body).not.toMatch(/refresh-token|auth\.json/);
});
