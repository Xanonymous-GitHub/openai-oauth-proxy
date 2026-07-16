import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAdminApp } from "../../src/admin/app.js";
import { SessionStore } from "../../src/admin/sessions.js";
import type { AccountState } from "../../src/codex/account.js";

const allowedOrigins = new Set([
  "http://127.0.0.1:8081",
  "http://localhost:8081",
]);

function fixture(
  state: AccountState = { type: "signed_out" },
  assetRoot = "/missing-admin-assets",
) {
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
  const app = createAdminApp({ account, sessions, allowedOrigins, assetRoot });
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
])(
  "rejects mutating requests without an exact allowed Origin",
  async (origin) => {
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
  },
);

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

it("serializes checking without adding credential fields", async () => {
  const { app } = fixture({ type: "checking" });

  const response = await app.request("/api/state");

  expect(await response.json()).toMatchObject({ state: { type: "checking" } });
});

it("serves the React mount shell under the restrictive CSP", async () => {
  const { app } = fixture();
  const page = await app.request("/");
  const html = await page.text();

  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toBe(
    "default-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  expect(page.headers.get("cache-control")).toBe("no-store");
  expect(html).toContain('<div id="root"></div>');
  expect(html).toContain('<link rel="stylesheet" href="/app.css">');
  expect(html).toContain('<script type="module" src="/app.js"></script>');
  expect(html).not.toContain("Start device login");
});

it("serves only local admin assets with explicit content types", async () => {
  const assetRoot = await mkdtemp(join(tmpdir(), "admin-assets-"));
  await mkdir(join(assetRoot, "assets"));
  await Promise.all([
    writeFile(join(assetRoot, "app.js"), "export {}"),
    writeFile(join(assetRoot, "app.css"), "body{}"),
    writeFile(join(assetRoot, "assets", "geist.woff2"), "font"),
    writeFile(join(assetRoot, "assets", "private.txt"), "not an asset"),
  ]);
  const { app } = fixture({ type: "signed_out" }, assetRoot);

  try {
    const script = await app.request("/app.js");
    const style = await app.request("/app.css");
    const font = await app.request("/assets/geist.woff2");
    const disallowed = await app.request("/assets/private.txt");
    expect(script.headers.get("content-type")).toBe(
      "text/javascript; charset=UTF-8",
    );
    expect(style.headers.get("content-type")).toBe("text/css; charset=UTF-8");
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(await script.text()).toBe("export {}");
    expect(disallowed.status).toBe(404);
    expect(script.headers.get("content-security-policy")).toBe(
      "default-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(script.headers.get("cache-control")).toBe("no-store");
    expect(script.headers.get("x-content-type-options")).toBe("nosniff");
    expect(script.headers.get("access-control-allow-origin")).toBeNull();
  } finally {
    await rm(assetRoot, { recursive: true, force: true });
  }
});

it("rejects encoded asset traversal", async () => {
  const parent = await mkdtemp(join(tmpdir(), "admin-traversal-"));
  const assetRoot = join(parent, "ui");
  await mkdir(join(assetRoot, "assets"), { recursive: true });
  await writeFile(join(parent, "secret.js"), "not public");
  const { app } = fixture({ type: "signed_out" }, assetRoot);

  try {
    const response = await app.request("/assets/%2e%2e%2f%2e%2e%2fsecret.js");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("not public");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

it("rejects asset symlinks that resolve outside the asset root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "admin-symlink-"));
  const assetRoot = join(parent, "ui");
  const external = join(parent, "external.js");
  await mkdir(join(assetRoot, "assets"), { recursive: true });
  await writeFile(external, "external secret");
  await symlink(external, join(assetRoot, "assets", "linked.js"));
  const { app } = fixture({ type: "signed_out" }, assetRoot);

  try {
    const response = await app.request("/assets/linked.js");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("external secret");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

it.each([
  ["a malformed NUL path", "/assets/bad%00.js"],
  ["a non-directory path segment", "/assets/not-a-directory/file.js"],
])("returns a sanitized 404 for %s", async (_case, path) => {
  const assetRoot = await mkdtemp(join(tmpdir(), "admin-invalid-asset-"));
  await mkdir(join(assetRoot, "assets"));
  await writeFile(join(assetRoot, "assets", "not-a-directory"), "private path");
  const { app } = fixture({ type: "signed_out" }, assetRoot);

  try {
    const response = await app.request(path);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("404 Not Found");
  } finally {
    await rm(assetRoot, { recursive: true, force: true });
  }
});

it("returns 404 for a missing asset", async () => {
  expect((await fixture().app.request("/assets/missing.js")).status).toBe(404);
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
