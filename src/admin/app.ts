import { readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { type Context, Hono } from "hono";
import type { AccountController, AccountState } from "../codex/account.js";
import type { AdminResponse } from "./contract.js";
import { ADMIN_PAGE } from "./page.js";
import {
  type AdminSession,
  type SessionStore,
  sessionCookie,
} from "./sessions.js";

const CSP =
  "default-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

interface AdminAppDependencies {
  account: AccountController;
  sessions: SessionStore;
  allowedOrigins: ReadonlySet<string>;
  assetRoot: string;
}

export function createAdminApp({
  account,
  sessions,
  allowedOrigins,
  assetRoot,
}: AdminAppDependencies): Hono {
  const app = new Hono();

  app.use("*", async (context, next) => {
    context.header("content-security-policy", CSP);
    context.header("cache-control", "no-store");
    context.header("x-content-type-options", "nosniff");
    await next();
  });

  app.get("/", (context) => context.html(ADMIN_PAGE));
  app.get("/app.js", (context) =>
    adminAsset(context, assetRoot, "app.js"),
  );
  app.get("/app.css", (context) =>
    adminAsset(context, assetRoot, "app.css"),
  );
  app.get("/assets/*", (context) =>
    adminAsset(context, assetRoot, context.req.path.slice(1)),
  );
  app.get("/api/state", (context) => {
    const opened = sessions.open(context.req.header("cookie"));
    if (opened.created) setSessionCookie(context, opened.session);
    return context.json(responseBody(account.state(), opened.session));
  });

  app.post("/api/login", async (context) => {
    const session = authorize(context, sessions, allowedOrigins);
    if (session instanceof Response) return session;
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "invalid_request" }, 400);
    }
    if (!isDeviceLogin(body)) {
      return context.json({ error: "invalid_request" }, 400);
    }
    try {
      const state = await account.login();
      const rotated = sessions.rotate(session.id);
      setSessionCookie(context, rotated);
      return context.json(responseBody(state, rotated));
    } catch {
      return authenticationUnavailable(context, account.state(), session);
    }
  });

  app.post("/api/cancel", async (context) => {
    const session = authorize(context, sessions, allowedOrigins);
    if (session instanceof Response) return session;
    return runAccountAction(context, session, account, () => account.cancel());
  });
  app.post("/api/refresh", async (context) => {
    const session = authorize(context, sessions, allowedOrigins);
    if (session instanceof Response) return session;
    return runAccountAction(context, session, account, () => account.refresh());
  });
  app.post("/api/logout", async (context) => {
    const session = authorize(context, sessions, allowedOrigins);
    if (session instanceof Response) return session;
    try {
      await account.logout();
      const rotated = sessions.rotate(session.id);
      setSessionCookie(context, rotated);
      return context.json(responseBody(account.state(), rotated));
    } catch {
      return authenticationUnavailable(context, account.state(), session);
    }
  });

  return app;
}

const ASSET_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=UTF-8",
  ".js": "text/javascript; charset=UTF-8",
  ".woff2": "font/woff2",
};

const EXPECTED_ASSET_ERROR_CODES: ReadonlySet<string> = new Set([
  "EACCES",
  "EINVAL",
  "EISDIR",
  "ELOOP",
  "ENAMETOOLONG",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
  "ERR_INVALID_ARG_VALUE",
]);

async function adminAsset(
  context: Context,
  root: string,
  requestedPath: string,
): Promise<Response> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestedPath);
  } catch {
    return context.notFound();
  }
  try {
    const canonicalRoot = await realpath(root);
    const file = await realpath(resolve(canonicalRoot, decoded));
    const fromRoot = relative(canonicalRoot, file);
    const contentType = ASSET_CONTENT_TYPES[extname(file)];
    if (
      !fromRoot ||
      fromRoot.startsWith("..") ||
      isAbsolute(fromRoot) ||
      !contentType
    ) {
      return context.notFound();
    }
    return context.body(new Uint8Array(await readFile(file)), 200, {
      "content-type": contentType,
    });
  } catch (error) {
    if (isExpectedAssetError(error)) {
      return context.notFound();
    }
    throw error;
  }
}

function isExpectedAssetError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    EXPECTED_ASSET_ERROR_CODES.has(error.code)
  );
}

function authorize(
  context: Context,
  sessions: SessionStore,
  allowedOrigins: ReadonlySet<string>,
): AdminSession | Response {
  const origin = context.req.header("origin");
  if (!origin || !allowedOrigins.has(origin)) {
    return context.json({ error: "forbidden" }, 403);
  }
  const contentType = context.req.header("content-type")?.split(";", 1)[0];
  if (contentType?.trim().toLowerCase() !== "application/json") {
    return context.json({ error: "unsupported_media_type" }, 415);
  }
  const session = sessions.authenticate(
    context.req.header("cookie"),
    context.req.header("x-csrf-token"),
  );
  return session ?? context.json({ error: "forbidden" }, 403);
}

async function runAccountAction(
  context: Context,
  session: AdminSession,
  account: AccountController,
  action: () => Promise<void>,
): Promise<Response> {
  try {
    await action();
    return context.json(responseBody(account.state(), session));
  } catch {
    return authenticationUnavailable(context, account.state(), session);
  }
}

function authenticationUnavailable(
  context: Context,
  state: AccountState,
  session: AdminSession,
): Response {
  return context.json(
    {
      ...responseBody(state, session),
      error: "authentication_required",
    },
    503,
  );
}

function responseBody(
  state: AccountState,
  session: AdminSession,
): AdminResponse {
  return { state, csrfToken: session.csrfToken };
}

function setSessionCookie(context: Context, session: AdminSession): void {
  context.header("set-cookie", sessionCookie(session.id));
}

function isDeviceLogin(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length === 1 &&
    entries[0]?.[0] === "type" &&
    entries[0][1] === "chatgptDeviceCode"
  );
}
