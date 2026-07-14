# Admin UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw port-8081 authentication page with a polished, responsive React and TypeScript interface while preserving every existing admin security boundary.

**Architecture:** Vite builds one bundled React entry and local CSS/fonts into `dist/admin-ui/`; Hono serves a fixed HTML mount shell and traversal-safe static assets from an injected asset root. A shared runtime-validated response contract connects the existing account API to a small client state controller. Server and browser TypeScript projects remain separate.

**Tech Stack:** Bun, React 19.2.7, TypeScript 7, Vite 8.1.4, Tailwind CSS 4.3.2, shadcn/ui 4.13.0, Radix UI, Tabler Icons, Geist, Vitest, Testing Library, jsdom, Hono.

## Global Constraints

- Preserve `/api/state`, `/api/login`, `/api/cancel`, `/api/refresh`, and `/api/logout` behavior and payloads.
- Preserve exact-Origin validation, CSRF validation and rotation, `HttpOnly; SameSite=Strict` cookies, no CORS, `Cache-Control: no-store`, and loopback-only deployment.
- Keep the current restrictive CSP; do not add inline-script, inline-style, remote-font, or remote-image exceptions.
- Link a device verification URL only when its origin is exactly `https://auth.openai.com` and pathname is exactly `/codex/device`.
- Device-login completion remains manual-refresh only.
- Use one root `package.json` and `bun.lock`; pin every dependency exactly.
- Use customized shadcn/ui components, one Tabler icon family, local Geist fonts, one muted teal accent, 16px panels, 10px controls, and pill geometry only for status badges.
- Do not add routing, global state, SSR, automatic polling, an animation package, metrics, logs, navigation, or new backend endpoints.
- Honor `prefers-reduced-motion`; verify WCAG AA contrast and layouts at 320px, 768px, and desktop widths.
- Commit commands below are conditional: execute them only if the user explicitly authorizes Git commits.

## File Structure

**Create**

- `tsconfig.admin.json`: DOM/JSX type boundary for client source and client tests.
- `vite.config.ts`: React/Tailwind build with deterministic `app.js` and `app.css` names.
- `components.json`: shadcn/ui Vite/Tailwind configuration.
- `src/admin/contract.ts`: shared response type and runtime parser.
- `src/admin/ui/main.tsx`: browser mount entry.
- `src/admin/ui/admin-app.tsx`: client state, requests, state views, and guidance layout.
- `src/admin/ui/theme-control.tsx`: persisted system/light/dark theme control.
- `src/admin/ui/styles.css`: Tailwind v4 import, semantic tokens, responsive composition, and reduced-motion rules.
- `src/admin/ui/lib/utils.ts`: shadcn `cn` helper.
- `src/admin/ui/components/ui/{alert,badge,button,card,separator,skeleton}.tsx`: copied shadcn primitives.
- `test/admin/ui/contract.test.ts`: response parser coverage.
- `test/admin/ui/admin-app.test.tsx`: state, request, recovery, copy, and URL behavior.
- `test/admin/ui/theme-control.test.tsx`: theme preference behavior.
- `test/admin/container-smoke.mjs`: smoke check against the final runtime image.

**Modify**

- `package.json`, `bun.lock`: exact dependencies and server/client scripts.
- `tsconfig.json`, `tsconfig.build.json`: exclude browser files from Node compilation.
- `vitest.config.ts`: include TSX tests and resolve the `@` alias.
- `src/admin/page.ts`: replace the raw document and script with the mount shell only.
- `src/admin/app.ts`: serve injected local assets and use the shared response contract.
- `src/main.ts`: pass the production asset root resolved from `import.meta.url`.
- `test/admin/app.test.ts`: fixture asset root and shell/asset/CSP tests.
- `test/codex/account.test.ts`: provide the required inert asset root to its admin fixture.
- `test/app.test.ts`: assert the live admin listener exposes the new mount shell.
- `Dockerfile`: copy browser build configuration into the build stage.

---

### Task 1: Browser Toolchain And Validated Contract

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `tsconfig.json`
- Modify: `tsconfig.build.json`
- Create: `tsconfig.admin.json`
- Create: `vite.config.ts`
- Create: `components.json`
- Modify: `vitest.config.ts`
- Create: `test/admin/ui/contract.test.ts`
- Create: `src/admin/contract.ts`

**Interfaces:**
- Consumes: `AccountState` from `src/codex/account.ts`.
- Produces: `AdminResponse` and `parseAdminResponse(value: unknown): AdminResponse | null`.

- [ ] **Step 1: Install the exact current dependencies**

Run:

```bash
bun add --dev --exact react@19.2.7 react-dom@19.2.7 radix-ui@1.6.2 @tabler/icons-react@3.44.0 @fontsource-variable/geist@5.2.9 @fontsource-variable/geist-mono@5.2.8 class-variance-authority@0.7.1 clsx@2.1.1 tailwind-merge@3.6.0 vite@8.1.4 @vitejs/plugin-react@6.0.3 tailwindcss@4.3.2 @tailwindcss/vite@4.3.2 shadcn@4.13.0 @types/react@19.2.17 @types/react-dom@19.2.3 @testing-library/dom@10.4.1 @testing-library/react@16.3.2 @testing-library/user-event@14.6.1 jsdom@29.1.1
```

Expected: all browser/build packages are exact-pinned dev dependencies, `bun.lock` updates without peer-dependency errors, and the runtime production install remains limited to server dependencies.

- [ ] **Step 2: Separate Node and browser TypeScript projects**

Add `"exclude": ["src/admin/ui/**/*"]` to `tsconfig.json`. Change `tsconfig.build.json` to exclude both browser source and tests:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/admin/ui/**/*", "test/**/*.ts"]
}
```

Create `tsconfig.admin.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "lib": ["ES2024", "DOM", "DOM.Iterable"],
    "types": ["node", "vite/client"],
    "jsx": "react-jsx",
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/admin/ui/*"]
    },
    "noEmit": true
  },
  "include": [
    "src/admin/contract.ts",
    "src/admin/ui/**/*.ts",
    "src/admin/ui/**/*.tsx",
    "test/admin/ui/**/*.ts",
    "test/admin/ui/**/*.tsx",
    "vite.config.ts"
  ],
  "exclude": ["src/codex/generated"]
}
```

Update scripts in `package.json` without changing `build` yet:

```json
"typecheck:server": "tsc -p tsconfig.json --noEmit",
"typecheck:admin": "tsc -p tsconfig.admin.json --noEmit",
"typecheck": "bun run typecheck:server && bun run typecheck:admin"
```

- [ ] **Step 3: Configure Vite, shadcn/ui, and Vitest**

Create `vite.config.ts`:

```ts
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src/admin/ui", import.meta.url)) },
  },
  build: {
    outDir: `${root}dist/admin-ui`,
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: { app: `${root}src/admin/ui/main.tsx` },
      output: {
        entryFileNames: "app.js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith(".css"))
            ? "app.css"
            : "assets/[name]-[hash][extname]",
      },
    },
  },
});
```

Create `components.json`:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/admin/ui/styles.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "iconLibrary": "tabler",
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  }
}
```

Update `vitest.config.ts`:

```ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src/admin/ui", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    testTimeout: 10_000,
  },
});
```

- [ ] **Step 4: Write failing contract tests**

Create `test/admin/ui/contract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseAdminResponse } from "../../../src/admin/contract.js";

const csrfToken = "c".repeat(43);

describe("parseAdminResponse", () => {
  it.each([
    { type: "checking" },
    { type: "signed_out" },
    { type: "ready", email: null, planType: "plus" },
    {
      type: "login_pending",
      loginId: "login-1",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    },
    { type: "error", code: "authentication_required" },
  ])("accepts account state $type", (state) => {
    expect(parseAdminResponse({ state, csrfToken })).toEqual({
      state,
      csrfToken,
    });
  });

  it("accepts only the sanitized optional error", () => {
    expect(
      parseAdminResponse({
        state: { type: "signed_out" },
        csrfToken,
        error: "authentication_required",
      }),
    ).toMatchObject({ error: "authentication_required" });
    expect(
      parseAdminResponse({
        state: { type: "signed_out" },
        csrfToken,
        error: "refresh-token leaked",
      }),
    ).toBeNull();
  });

  it.each([
    null,
    {},
    { state: { type: "unknown" }, csrfToken },
    { state: { type: "ready", email: 7, planType: "plus" }, csrfToken },
    { state: { type: "ready", email: null, planType: "invalid" }, csrfToken },
    { state: { type: "login_pending" }, csrfToken },
    { state: { type: "signed_out" }, csrfToken: 42 },
  ])("rejects malformed payload %#", (payload) => {
    expect(parseAdminResponse(payload)).toBeNull();
  });
});
```

- [ ] **Step 5: Run the contract test to verify RED**

Run: `bunx vitest run test/admin/ui/contract.test.ts`

Expected: FAIL because `src/admin/contract.ts` does not exist.

- [ ] **Step 6: Implement the browser-safe contract**

Create `src/admin/contract.ts` with:

```ts
import type { AccountState } from "../codex/account.js";
import type { PlanType } from "../codex/generated/PlanType.js";

const PLAN_TYPES: ReadonlySet<string> = new Set<PlanType>([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_usage_based",
  "business",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "unknown",
]);

export interface AdminResponse {
  state: AccountState;
  csrfToken: string;
  error?: "authentication_required";
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function accountState(value: unknown): AccountState | null {
  if (!record(value) || typeof value.type !== "string") return null;
  if (value.type === "checking" || value.type === "signed_out") {
    return { type: value.type };
  }
  if (
    value.type === "ready" &&
    (typeof value.email === "string" || value.email === null) &&
    typeof value.planType === "string" &&
    PLAN_TYPES.has(value.planType)
  ) {
    return {
      type: value.type,
      email: value.email,
      planType: value.planType as PlanType,
    };
  }
  if (
    value.type === "login_pending" &&
    typeof value.loginId === "string" &&
    typeof value.verificationUrl === "string" &&
    typeof value.userCode === "string"
  ) {
    return {
      type: value.type,
      loginId: value.loginId,
      verificationUrl: value.verificationUrl,
      userCode: value.userCode,
    };
  }
  if (value.type === "error" && value.code === "authentication_required") {
    return { type: value.type, code: value.code };
  }
  return null;
}

export function parseAdminResponse(value: unknown): AdminResponse | null {
  if (!record(value) || typeof value.csrfToken !== "string") return null;
  if (
    value.error !== undefined &&
    value.error !== "authentication_required"
  ) {
    return null;
  }
  const state = accountState(value.state);
  if (!state) return null;
  return value.error === "authentication_required"
    ? { state, csrfToken: value.csrfToken, error: value.error }
    : { state, csrfToken: value.csrfToken };
}
```

- [ ] **Step 7: Verify GREEN and both type boundaries**

Run:

```bash
bunx vitest run test/admin/ui/contract.test.ts
bun run typecheck
```

Expected: contract tests PASS; server and admin typechecks PASS.

- [ ] **Step 8: Conditional commit checkpoint**

If the user explicitly authorizes commits:

```bash
git add package.json bun.lock tsconfig.json tsconfig.build.json tsconfig.admin.json vite.config.ts vitest.config.ts components.json src/admin/contract.ts test/admin/ui/contract.test.ts
git commit -m "build: add admin frontend toolchain"
```

---

### Task 2: Secure Mount Shell And Static Assets

**Files:**
- Modify: `src/admin/page.ts`
- Modify: `src/admin/app.ts`
- Modify: `src/main.ts`
- Modify: `test/admin/app.test.ts`
- Modify: `test/codex/account.test.ts`
- Modify: `test/app.test.ts`

**Interfaces:**
- Consumes: `AdminResponse` from `src/admin/contract.ts`.
- Produces: required `assetRoot: string` in `AdminAppDependencies`; routes `/app.js`, `/app.css`, and `/assets/*`.

- [ ] **Step 1: Replace framework-free assertions with failing shell and asset tests**

In `test/admin/app.test.ts`, add `mkdir`, `mkdtemp`, `rm`, and `writeFile` imports from `node:fs/promises`, plus `tmpdir` and `join`. Change `fixture` to accept `assetRoot = "/missing-admin-assets"` and pass it to `createAdminApp`.

Replace the framework-free page/script test with:

```ts
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
  ]);
  const { app } = fixture({ type: "signed_out" }, assetRoot);

  try {
    const script = await app.request("/app.js");
    const style = await app.request("/app.css");
    const font = await app.request("/assets/geist.woff2");
    expect(script.headers.get("content-type")).toBe(
      "text/javascript; charset=UTF-8",
    );
    expect(style.headers.get("content-type")).toBe("text/css; charset=UTF-8");
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(await script.text()).toBe("export {}");
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
    const response = await app.request(
      "/assets/%2e%2e%2f%2e%2e%2fsecret.js",
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("not public");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

it("returns 404 for a missing asset", async () => {
  expect((await fixture().app.request("/assets/missing.js")).status).toBe(404);
});
```

Delete the two tests that evaluate `ADMIN_SCRIPT` with `new Function`; their client recovery behavior moves to Task 3.

- [ ] **Step 2: Run the focused server tests to verify RED**

Run: `bunx vitest run test/admin/app.test.ts test/app.test.ts test/codex/account.test.ts`

Expected: FAIL because the page has no React mount/CSS and `assetRoot` is not accepted.

- [ ] **Step 3: Replace the raw page with a fixed mount shell**

Replace `src/admin/page.ts` with:

```ts
export const ADMIN_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Codex Gateway</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/app.js"></script>
</body>
</html>
`;
```

- [ ] **Step 4: Implement traversal-safe asset responses**

In `src/admin/app.ts`:

1. Import `readFile` from `node:fs/promises`, `extname`, `isAbsolute`, `relative`, and `resolve` from `node:path`.
2. Import `AdminResponse` from `./contract.js` and remove the local interface.
3. Remove `ADMIN_SCRIPT` and require `assetRoot: string` in `AdminAppDependencies`.
4. Add these routes after `/`:

```ts
app.get("/app.js", (context) =>
  adminAsset(context, assetRoot, "app.js"),
);
app.get("/app.css", (context) =>
  adminAsset(context, assetRoot, "app.css"),
);
app.get("/assets/*", (context) =>
  adminAsset(context, assetRoot, context.req.path.slice(1)),
);
```

Add the helper:

```ts
const ASSET_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=UTF-8",
  ".js": "text/javascript; charset=UTF-8",
  ".woff2": "font/woff2",
};

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
  const file = resolve(root, decoded);
  const fromRoot = relative(root, file);
  const contentType = ASSET_CONTENT_TYPES[extname(file)];
  if (
    !fromRoot ||
    fromRoot.startsWith("..") ||
    isAbsolute(fromRoot) ||
    !contentType
  ) {
    return context.notFound();
  }
  try {
    return context.body(new Uint8Array(await readFile(file)), 200, {
      "content-type": contentType,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return context.notFound();
    }
    throw error;
  }
}
```

Destructure `assetRoot` in `createAdminApp`. Keep the middleware before all routes so asset responses retain CSP, no-store, and nosniff headers.

- [ ] **Step 5: Supply asset roots at every call site**

In `src/main.ts`, import `fileURLToPath` alongside `pathToFileURL`, then pass:

```ts
assetRoot: fileURLToPath(new URL("./admin-ui/", import.meta.url)),
```

to `createAdminApp`. This resolves to `dist/admin-ui/` from compiled `dist/main.js`.

Pass `assetRoot: "/missing-admin-assets"` in the direct `createAdminApp` fixture in `test/codex/account.test.ts`. Update `test/app.test.ts` to expect `Codex Gateway` instead of `Codex authentication`.

- [ ] **Step 6: Verify GREEN and unchanged security behavior**

Run:

```bash
bunx vitest run test/admin/app.test.ts test/app.test.ts test/codex/account.test.ts
bun run typecheck:server
```

Expected: all focused tests PASS, including existing Origin, CSRF, cookie, rotation, and sanitization tests.

- [ ] **Step 7: Conditional commit checkpoint**

If commits are authorized:

```bash
git add src/admin/page.ts src/admin/app.ts src/main.ts test/admin/app.test.ts test/codex/account.test.ts test/app.test.ts
git commit -m "feat: serve bundled admin assets"
```

---

### Task 3: React State Flow And Authentication Actions

**Files:**
- Create: `src/admin/ui/main.tsx`
- Create: `src/admin/ui/admin-app.tsx`
- Create: `src/admin/ui/styles.css` (minimal Tailwind entry; Task 4 replaces it)
- Create: `src/admin/ui/lib/utils.ts`
- Create: `src/admin/ui/components/ui/{alert,badge,button,card,separator,skeleton}.tsx`
- Create: `test/admin/ui/admin-app.test.tsx`

**Interfaces:**
- Consumes: `parseAdminResponse` and all existing admin API routes.
- Produces: `AdminApp`, `canonicalVerificationUrl(value: string): string | null`, and the browser entry.

- [ ] **Step 1: Generate only the approved shadcn/ui primitives**

Create `src/admin/ui/styles.css` first so the CLI can resolve the configured stylesheet:

```css
@import "tailwindcss";
```

Run:

```bash
bunx shadcn@4.13.0 add button badge card separator skeleton alert --yes
```

Expected: the six component files and `src/admin/ui/lib/utils.ts` are created under the aliases in `components.json`. Do not add unrelated components. If the CLI rewrites `styles.css`, retain its semantic variable structure but Task 4 will replace the palette and layout.

Before continuing, verify the copied primitives use `rounded-md` for buttons, `rounded-xl`/`rounded-lg` for panels, and `rounded-full` only for `Badge`. Replace any generated badge radius with `rounded-full`. If the CLI added `lucide-react`, `motion`, or `tw-animate-css`, run `bun remove lucide-react`, `bun remove motion`, or `bun remove tw-animate-css` for each package that is present, then confirm `package.json` still contains exact versions only.

- [ ] **Step 2: Write failing client behavior tests**

Create `test/admin/ui/admin-app.test.tsx` with these executable behavior cases:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminApp } from "../../../src/admin/ui/admin-app.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const csrfToken = "c".repeat(43);
const rotatedToken = "d".repeat(43);
const response = (
  state: unknown,
  token = csrfToken,
  init?: ResponseInit,
) => Response.json({ state, csrfToken: token }, init);

function fetchSequence(
  ...items: Array<Response | Error | Promise<Response>>
) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const item of items) {
    fetchMock.mockImplementationOnce(() =>
      item instanceof Error ? Promise.reject(item) : Promise.resolve(item),
    );
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestInit(fetchMock: ReturnType<typeof fetchSequence>, call: number) {
  return fetchMock.mock.calls[call]?.[1] as RequestInit;
}

const pending = {
  type: "login_pending",
  loginId: "login-1",
  verificationUrl: "https://auth.openai.com/codex/device",
  userCode: "ABCD-EFGH",
};

describe("AdminApp", () => {
  it("renders checking with a manual refresh action", async () => {
    const fetchMock = fetchSequence(
      response({ type: "checking" }),
      response({ type: "signed_out" }),
    );
    const user = userEvent.setup();
    render(<AdminApp />);

    await user.click(await screen.findByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/refresh");
    expect(requestInit(fetchMock, 1).body).toBe("{}");
    expect(requestInit(fetchMock, 1).headers).toMatchObject({
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    });
  });

  it("starts device login with the exact payload", async () => {
    const fetchMock = fetchSequence(
      response({ type: "signed_out" }),
      response(pending, rotatedToken),
    );
    const user = userEvent.setup();
    render(<AdminApp />);

    await user.click(await screen.findByRole("button", { name: "Connect Codex" }));
    await screen.findByText("ABCD-EFGH");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/login");
    expect(requestInit(fetchMock, 1).body).toBe(
      JSON.stringify({ type: "chatgptDeviceCode" }),
    );
  });

  it("renders ready details and a nullable-email fallback", async () => {
    fetchSequence(response({ type: "ready", email: "dev@example.com", planType: "plus" }));
    const first = render(<AdminApp />);
    expect(await screen.findByText("dev@example.com")).toBeTruthy();
    expect(screen.getByText("Plus")).toBeTruthy();
    first.unmount();

    fetchSequence(response({ type: "ready", email: null, planType: "team" }));
    render(<AdminApp />);
    expect(await screen.findByText("Email unavailable")).toBeTruthy();
    expect(screen.getByText("Team")).toBeTruthy();
  });

  it("copies the pending code, refreshes, and cancels", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const fetchMock = fetchSequence(
      response(pending),
      response(pending),
      response({ type: "signed_out" }),
    );
    const user = userEvent.setup();
    render(<AdminApp />);

    await user.click(await screen.findByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith("ABCD-EFGH");
    expect(screen.getByText("Copied")).toBeTruthy();
    const refresh = screen.getByRole("button", { name: "Refresh status" });
    await user.click(refresh);
    await waitFor(() => expect(refresh.hasAttribute("disabled")).toBe(false));
    await user.click(screen.getByRole("button", { name: "Cancel login" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/state",
      "/api/refresh",
      "/api/cancel",
    ]);
  });

  it("links only the canonical OpenAI device URL", async () => {
    fetchSequence(response(pending));
    const first = render(<AdminApp />);
    const link = await screen.findByRole("link", { name: "Open verification page" });
    expect(link.getAttribute("href")).toBe("https://auth.openai.com/codex/device");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    first.unmount();

    fetchSequence(
      response({ ...pending, verificationUrl: "https://auth.openai.com.evil.example/codex/device" }),
    );
    render(<AdminApp />);
    expect(await screen.findByText("Verification link unavailable")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open verification page" })).toBeNull();
  });

  it("reconnects from authentication error", async () => {
    const fetchMock = fetchSequence(
      response({ type: "error", code: "authentication_required" }),
      response(pending, rotatedToken),
    );
    const user = userEvent.setup();
    render(<AdminApp />);
    await user.click(await screen.findByRole("button", { name: "Reconnect Codex" }));
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/login");
  });

  it("disables mutation controls while a mutation is pending", async () => {
    let finish: ((value: Response) => void) | undefined;
    const pendingResponse = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    fetchSequence(response({ type: "signed_out" }), pendingResponse);
    const user = userEvent.setup();
    render(<AdminApp />);
    const connect = await screen.findByRole("button", { name: "Connect Codex" });
    await user.click(connect);
    expect(connect.hasAttribute("disabled")).toBe(true);
    finish?.(response(pending, rotatedToken));
    await screen.findByText("ABCD-EFGH");
  });

  it("adopts rotated CSRF tokens after login and logout", async () => {
    const loginFetch = fetchSequence(
      response({ type: "signed_out" }),
      response(pending, rotatedToken),
      response(pending, rotatedToken),
    );
    const user = userEvent.setup();
    const first = render(<AdminApp />);
    await user.click(await screen.findByRole("button", { name: "Connect Codex" }));
    await user.click(await screen.findByRole("button", { name: "Refresh status" }));
    expect(requestInit(loginFetch, 2).headers).toMatchObject({
      "x-csrf-token": rotatedToken,
    });
    first.unmount();

    const logoutFetch = fetchSequence(
      response({ type: "ready", email: "dev@example.com", planType: "plus" }),
      response({ type: "signed_out" }, rotatedToken),
      response(pending, "e".repeat(43)),
    );
    render(<AdminApp />);
    await user.click(await screen.findByRole("button", { name: "Log out" }));
    await user.click(await screen.findByRole("button", { name: "Connect Codex" }));
    expect(requestInit(logoutFetch, 2).headers).toMatchObject({
      "x-csrf-token": rotatedToken,
    });
  });

  it("bootstraps once after 403 without replaying the mutation", async () => {
    const fetchMock = fetchSequence(
      response({ type: "ready", email: "dev@example.com", planType: "plus" }),
      Response.json({ error: "forbidden" }, { status: 403 }),
      response({ type: "signed_out" }, rotatedToken),
    );
    const user = userEvent.setup();
    render(<AdminApp />);
    await user.click(await screen.findByRole("button", { name: "Refresh account" }));
    await screen.findByRole("button", { name: "Connect Codex" });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/state",
      "/api/refresh",
      "/api/state",
    ]);
  });

  it("applies a valid 503 state and shows sanitized failure copy", async () => {
    fetchSequence(
      response({ type: "signed_out" }),
      response(
        { type: "error", code: "authentication_required" },
        csrfToken,
        { status: 503 },
      ),
    );
    const user = userEvent.setup();
    render(<AdminApp />);
    await user.click(await screen.findByRole("button", { name: "Connect Codex" }));
    expect(await screen.findByText("Authentication is temporarily unavailable.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect Codex" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("refresh-token");
  });

  it("preserves the last valid state after malformed or failed responses", async () => {
    fetchSequence(
      response({ type: "ready", email: "dev@example.com", planType: "plus" }),
      new Response("not json", { status: 500 }),
      new TypeError("network failed"),
    );
    const user = userEvent.setup();
    render(<AdminApp />);
    const refresh = await screen.findByRole("button", { name: "Refresh account" });
    await user.click(refresh);
    expect(await screen.findByText("Session unavailable. Try again.")).toBeTruthy();
    expect(screen.getByText("dev@example.com")).toBeTruthy();
    await user.click(refresh);
    expect(screen.getByText("dev@example.com")).toBeTruthy();
  });

  it("shows session unavailable and retries a failed initial bootstrap", async () => {
    fetchSequence(
      new TypeError("network failed"),
      response({ type: "signed_out" }),
    );
    const user = userEvent.setup();
    render(<AdminApp />);
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Connect Codex" })).toBeTruthy();
  });

});
```

Do not use `toBeInTheDocument`; use standard DOM assertions such as `screen.getByRole(...)`, `.textContent`, `.hasAttribute("disabled")`, and `.getAttribute(...)` so no jest-dom dependency is needed.

- [ ] **Step 3: Run the client suite to verify RED**

Run: `bunx vitest run test/admin/ui/admin-app.test.tsx`

Expected: FAIL because `AdminApp` does not exist.

- [ ] **Step 4: Implement the React entry and request controller**

Create `src/admin/ui/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AdminApp } from "./admin-app.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Admin root element is missing");

createRoot(root).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>,
);
```

Create `src/admin/ui/admin-app.tsx` with this complete state and interaction structure. Task 4 adds `ThemeControl` to the marked top-bar action container without changing this request flow.

```tsx
import {
  IconAlertTriangle,
  IconArrowUpRight,
  IconCheck,
  IconCopy,
  IconLock,
  IconLogout,
  IconRefresh,
  IconShieldCheck,
  IconX,
} from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import type { AccountState } from "../../codex/account.js";
import { parseAdminResponse } from "../contract.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

type Action = "login" | "cancel" | "refresh" | "logout";
type Issue = "authentication_unavailable" | "session_unavailable";

const ACTIONS: Record<Action, { path: string; body: object }> = {
  login: { path: "/api/login", body: { type: "chatgptDeviceCode" } },
  cancel: { path: "/api/cancel", body: {} },
  refresh: { path: "/api/refresh", body: {} },
  logout: { path: "/api/logout", body: {} },
};

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function canonicalVerificationUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.origin === "https://auth.openai.com" &&
      url.pathname === "/codex/device"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function statusLabel(state: AccountState | null): string {
  if (!state) return "Connecting";
  switch (state.type) {
    case "checking":
      return "Checking";
    case "signed_out":
      return "Disconnected";
    case "login_pending":
      return "Authorization pending";
    case "ready":
      return "Connected";
    case "error":
      return "Action required";
  }
}

function planLabel(value: string): string {
  return value
    .split("_")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function IssueAlert({ issue }: { issue: Issue }) {
  const authentication = issue === "authentication_unavailable";
  return (
    <Alert role="alert">
      <IconAlertTriangle aria-hidden="true" />
      <AlertTitle>
        {authentication ? "Authentication unavailable" : "Session unavailable"}
      </AlertTitle>
      <AlertDescription>
        {authentication
          ? "Authentication is temporarily unavailable."
          : "Session unavailable. Try again."}
      </AlertDescription>
    </Alert>
  );
}

function LoadingPanel() {
  return (
    <div className="grid gap-5" aria-label="Checking account">
      <Skeleton className="h-5 w-36" />
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-10 w-40" />
    </div>
  );
}

function SessionUnavailable({
  retry,
  loading,
}: {
  retry: () => void;
  loading: boolean;
}) {
  return (
    <div className="grid gap-5">
      <IssueAlert issue="session_unavailable" />
      <Button type="button" onClick={retry} disabled={loading}>
        <IconRefresh aria-hidden="true" />
        Retry
      </Button>
    </div>
  );
}

function AccountContent({
  state,
  busy,
  run,
}: {
  state: AccountState;
  busy: Action | null;
  run: (action: Action) => void;
}) {
  const disabled = busy !== null;
  const [copyStatus, setCopyStatus] = useState("");
  const code = state.type === "login_pending" ? state.userCode : "";

  useEffect(() => setCopyStatus(""), [code]);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus("Copy unavailable");
    }
  };

  switch (state.type) {
    case "checking":
      return (
        <div className="grid gap-5">
          <LoadingPanel />
          <Button type="button" onClick={() => run("refresh")} disabled={disabled}>
            <IconRefresh aria-hidden="true" />
            Refresh status
          </Button>
        </div>
      );
    case "signed_out":
      return (
        <div className="grid gap-6">
          <div className="grid gap-2">
            <h2 className="text-2xl font-semibold tracking-tight">Connect your Codex account</h2>
            <p className="max-w-[52ch] text-sm leading-6 text-muted-foreground">
              Start a one-time device authorization without exposing credentials to this page.
            </p>
          </div>
          <Button type="button" onClick={() => run("login")} disabled={disabled}>
            Connect Codex
          </Button>
        </div>
      );
    case "login_pending": {
      const verificationUrl = canonicalVerificationUrl(state.verificationUrl);
      return (
        <div className="grid gap-6">
          <div className="grid gap-2">
            <p className="text-sm font-medium">One-time device code</p>
            <div className="flex flex-col gap-3 rounded-lg border bg-muted p-4 sm:flex-row sm:items-center sm:justify-between">
              <code className="break-all font-mono text-xl font-semibold tracking-[0.12em]">
                {state.userCode}
              </code>
              <Button type="button" variant="outline" onClick={copyCode}>
                {copyStatus === "Copied" ? (
                  <IconCheck aria-hidden="true" />
                ) : (
                  <IconCopy aria-hidden="true" />
                )}
                Copy code
              </Button>
            </div>
            <p className="min-h-5 text-sm text-muted-foreground" aria-live="polite">
              {copyStatus}
            </p>
          </div>
          {verificationUrl ? (
            <Button asChild>
              <a href={verificationUrl} target="_blank" rel="noopener noreferrer">
                Open verification page
                <IconArrowUpRight aria-hidden="true" />
              </a>
            </Button>
          ) : (
            <Alert role="alert">
              <IconAlertTriangle aria-hidden="true" />
              <AlertTitle>Verification link unavailable</AlertTitle>
              <AlertDescription>Cancel this login and start again.</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="button" variant="outline" onClick={() => run("refresh")} disabled={disabled}>
              <IconRefresh aria-hidden="true" />
              Refresh status
            </Button>
            <Button type="button" variant="ghost" onClick={() => run("cancel")} disabled={disabled}>
              <IconX aria-hidden="true" />
              Cancel login
            </Button>
          </div>
        </div>
      );
    }
    case "ready":
      return (
        <div className="grid gap-6">
          <div className="flex items-start gap-3">
            <IconShieldCheck className="mt-0.5 text-primary" aria-hidden="true" />
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">Account connected</h2>
              <p className="mt-1 text-sm text-muted-foreground">The proxy can authenticate Codex requests.</p>
            </div>
          </div>
          <dl className="grid gap-4 rounded-lg border bg-muted/50 p-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Email</dt>
              <dd className="mt-1 break-all text-sm font-medium">{state.email ?? "Email unavailable"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Plan</dt>
              <dd className="mt-1 text-sm font-medium">{planLabel(state.planType)}</dd>
            </div>
          </dl>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="button" variant="outline" onClick={() => run("refresh")} disabled={disabled}>
              <IconRefresh aria-hidden="true" />
              Refresh account
            </Button>
            <Button type="button" variant="destructive" onClick={() => run("logout")} disabled={disabled}>
              <IconLogout aria-hidden="true" />
              Log out
            </Button>
          </div>
        </div>
      );
    case "error":
      return (
        <div className="grid gap-5">
          <Alert role="alert">
            <IconAlertTriangle aria-hidden="true" />
            <AlertTitle>Authentication required</AlertTitle>
            <AlertDescription>Reconnect Codex to restore proxy access.</AlertDescription>
          </Alert>
          <Button type="button" onClick={() => run("login")} disabled={disabled}>
            Reconnect Codex
          </Button>
        </div>
      );
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

export function AdminApp() {
  const [state, setState] = useState<AccountState | null>(null);
  const [csrfToken, setCsrfToken] = useState("");
  const [busy, setBusy] = useState<Action | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [issue, setIssue] = useState<Issue | null>(null);

  const bootstrap = useCallback(async () => {
    setBootstrapping(true);
    try {
      const response = await fetch("/api/state");
      const parsed = parseAdminResponse(await responseJson(response));
      if (!response.ok || !parsed) {
        setIssue("session_unavailable");
        return;
      }
      setState(parsed.state);
      setCsrfToken(parsed.csrfToken);
      setIssue(parsed.error ? "authentication_unavailable" : null);
    } catch {
      setIssue("session_unavailable");
    } finally {
      setBootstrapping(false);
    }
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const run = async (action: Action) => {
    if (busy) return;
    setBusy(action);
    try {
      const request = ACTIONS[action];
      const response = await fetch(request.path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify(request.body),
      });
      if (response.status === 401 || response.status === 403) {
        setCsrfToken("");
        await bootstrap();
        return;
      }
      const parsed = parseAdminResponse(await responseJson(response));
      if (!parsed) {
        setIssue("session_unavailable");
        return;
      }
      setState(parsed.state);
      setCsrfToken(parsed.csrfToken);
      setIssue(
        response.status === 503 || parsed.error
          ? "authentication_unavailable"
          : response.ok
            ? null
            : "session_unavailable",
      );
    } catch {
      setIssue("session_unavailable");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex h-16 max-w-[1120px] items-center justify-between gap-4 px-4 md:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-md border bg-card">
              <IconLock size={18} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">Codex Gateway</p>
              <p className="truncate text-xs text-muted-foreground">Local admin control</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" role="status">{statusLabel(state)}</Badge>
          </div>
        </div>
      </header>

      <main
        className="mx-auto grid max-w-[1120px] grid-cols-1 gap-5 px-4 py-6 md:grid-cols-12 md:gap-6 md:px-6 md:py-10"
        aria-busy={busy !== null || bootstrapping}
      >
        <section className="md:col-span-7" aria-labelledby="account-title">
          <Card className="rounded-2xl shadow-sm">
            <CardHeader>
              <CardTitle id="account-title" className="text-sm font-medium text-muted-foreground">
                Codex authentication
              </CardTitle>
              <CardDescription>Manage the account used by this local proxy.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5" aria-live="polite">
              {issue && state ? <IssueAlert issue={issue} /> : null}
              {state ? (
                <AccountContent state={state} busy={busy} run={(action) => void run(action)} />
              ) : issue ? (
                <SessionUnavailable retry={() => void bootstrap()} loading={bootstrapping} />
              ) : (
                <LoadingPanel />
              )}
            </CardContent>
          </Card>
        </section>

        <aside className="grid content-start gap-6 md:col-span-5" aria-labelledby="guidance-title">
          <div>
            <p className="text-sm font-medium text-primary">Secure by location</p>
            <h1 id="guidance-title" className="mt-2 text-3xl font-semibold tracking-tight">
              A focused path to authorization.
            </h1>
            <p className="mt-3 max-w-[48ch] text-sm leading-6 text-muted-foreground">
              This panel stays on loopback and handles only the Codex account lifecycle.
            </p>
          </div>
          <Separator />
          <ol className="grid gap-5 text-sm">
            <li className="grid grid-cols-[1.75rem_1fr] gap-3">
              <span className="font-mono text-primary">01</span>
              <span>Start login here to request a one-time code.</span>
            </li>
            <li className="grid grid-cols-[1.75rem_1fr] gap-3">
              <span className="font-mono text-primary">02</span>
              <span>Enter it only at the verified OpenAI device page.</span>
            </li>
            <li className="grid grid-cols-[1.75rem_1fr] gap-3">
              <span className="font-mono text-primary">03</span>
              <span>Return here and refresh after authorization.</span>
            </li>
          </ol>
        </aside>
      </main>
    </div>
  );
}
```

- [ ] **Step 5: Verify the full client behavior suite GREEN**

Run:

```bash
bunx vitest run test/admin/ui/contract.test.ts test/admin/ui/admin-app.test.tsx
bun run typecheck:admin
```

Expected: all client tests PASS and admin typecheck PASS.

- [ ] **Step 6: Conditional commit checkpoint**

If commits are authorized:

```bash
git add src/admin/ui src/admin/contract.ts test/admin/ui components.json
git commit -m "feat: add responsive admin client"
```

---

### Task 4: Theme, Visual System, And Responsive Styling

**Files:**
- Create: `src/admin/ui/theme-control.tsx`
- Modify: `src/admin/ui/admin-app.tsx`
- Create or replace: `src/admin/ui/styles.css`
- Create: `test/admin/ui/theme-control.test.tsx`

**Interfaces:**
- Consumes: `AdminApp` header slot.
- Produces: `ThemeControl` with persisted `system | light | dark` mode and a root `data-theme="light|dark"` attribute.

- [ ] **Step 1: Write failing theme tests**

Create `test/admin/ui/theme-control.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThemeControl } from "../../../src/admin/ui/theme-control.js";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("uses the system theme by default", () => {
  render(<ThemeControl />);
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(screen.getByRole("button", { name: "Use system theme" }).getAttribute("aria-pressed")).toBe("true");
});

it("persists explicit light and dark modes", async () => {
  const user = userEvent.setup();
  render(<ThemeControl />);
  await user.click(screen.getByRole("button", { name: "Use light theme" }));
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(localStorage.getItem("admin-theme")).toBe("light");
  await user.click(screen.getByRole("button", { name: "Use dark theme" }));
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(localStorage.getItem("admin-theme")).toBe("dark");
});

it("exposes the theme modes in keyboard order", async () => {
  const user = userEvent.setup();
  render(<ThemeControl />);
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Use system theme" }),
  );
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Use light theme" }),
  );
});

it("tracks system theme changes while system mode is active", () => {
  let dark = false;
  let listener: (() => void) | undefined;
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return dark;
      },
      addEventListener: (_type: string, next: () => void) => {
        listener = next;
      },
      removeEventListener: vi.fn(),
    })),
  );
  render(<ThemeControl />);
  expect(document.documentElement.dataset.theme).toBe("light");
  dark = true;
  listener?.();
  expect(document.documentElement.dataset.theme).toBe("dark");
});
```

- [ ] **Step 2: Run theme tests to verify RED**

Run: `bunx vitest run test/admin/ui/theme-control.test.tsx`

Expected: FAIL because `ThemeControl` does not exist.

- [ ] **Step 3: Implement the compact three-mode control**

Create `src/admin/ui/theme-control.tsx`. It reads only `system`, `light`, or `dark` from `localStorage`, treats every other value as `system`, and subscribes to system-theme changes only while system mode is selected:

```tsx
import { IconDeviceDesktop, IconMoon, IconSun } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type ThemeMode = "system" | "light" | "dark";
const STORAGE_KEY = "admin-theme";

const OPTIONS = [
  { mode: "system", label: "Use system theme", Icon: IconDeviceDesktop },
  { mode: "light", label: "Use light theme", Icon: IconSun },
  { mode: "dark", label: "Use dark theme", Icon: IconMoon },
] as const;

function storedMode(): ThemeMode {
  const value = localStorage.getItem(STORAGE_KEY);
  return value === "light" || value === "dark" ? value : "system";
}

export function ThemeControl() {
  const [mode, setMode] = useState<ThemeMode>(storedMode);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        mode === "system" ? (media.matches ? "dark" : "light") : mode;
    };
    apply();
    localStorage.setItem(STORAGE_KEY, mode);
    if (mode !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [mode]);

  return (
    <div
      className="flex items-center rounded-md border bg-card p-0.5"
      role="group"
      aria-label="Color theme"
    >
      {OPTIONS.map(({ mode: option, label, Icon }) => (
        <Button
          key={option}
          type="button"
          size="icon"
          variant={mode === option ? "secondary" : "ghost"}
          className="size-8"
          aria-label={label}
          aria-pressed={mode === option}
          title={label}
          onClick={() => setMode(option)}
        >
          <Icon size={16} aria-hidden="true" />
        </Button>
      ))}
    </div>
  );
}
```

Add `import { ThemeControl } from "./theme-control.js";` to `admin-app.tsx` and render it once immediately after the status badge in the top-bar action container:

```tsx
<div className="flex items-center gap-2">
  <Badge className="hidden sm:inline-flex" variant="outline" role="status">
    {statusLabel(state)}
  </Badge>
  <ThemeControl />
</div>
```

- [ ] **Step 4: Implement the approved visual system in CSS**

Create `src/admin/ui/styles.css` with this structure and token set:

```css
@import "tailwindcss";
@import "@fontsource-variable/geist";
@import "@fontsource-variable/geist-mono";

@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));

:root {
  --radius: 0.625rem;
  --background: oklch(0.975 0.004 230);
  --foreground: oklch(0.19 0.015 235);
  --card: oklch(0.995 0.002 230);
  --card-foreground: var(--foreground);
  --popover: var(--card);
  --popover-foreground: var(--foreground);
  --primary: oklch(0.48 0.095 190);
  --primary-foreground: oklch(0.985 0.004 190);
  --secondary: oklch(0.93 0.008 225);
  --secondary-foreground: oklch(0.25 0.018 230);
  --muted: oklch(0.945 0.006 225);
  --muted-foreground: oklch(0.46 0.018 230);
  --accent: oklch(0.91 0.025 190);
  --accent-foreground: oklch(0.29 0.055 190);
  --destructive: oklch(0.55 0.19 27);
  --border: oklch(0.87 0.012 225);
  --input: var(--border);
  --ring: oklch(0.55 0.095 190);
}

[data-theme="dark"] {
  --background: oklch(0.16 0.012 235);
  --foreground: oklch(0.94 0.006 225);
  --card: oklch(0.205 0.015 235);
  --card-foreground: var(--foreground);
  --popover: var(--card);
  --popover-foreground: var(--foreground);
  --primary: oklch(0.72 0.105 188);
  --primary-foreground: oklch(0.18 0.025 190);
  --secondary: oklch(0.27 0.016 232);
  --secondary-foreground: oklch(0.92 0.007 225);
  --muted: oklch(0.245 0.015 232);
  --muted-foreground: oklch(0.69 0.015 225);
  --accent: oklch(0.29 0.04 190);
  --accent-foreground: oklch(0.88 0.055 188);
  --destructive: oklch(0.65 0.17 25);
  --border: oklch(0.34 0.016 232);
  --input: var(--border);
  --ring: oklch(0.67 0.095 188);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {
    --background: oklch(0.16 0.012 235);
    --foreground: oklch(0.94 0.006 225);
    --card: oklch(0.205 0.015 235);
    --card-foreground: var(--foreground);
    --popover: var(--card);
    --popover-foreground: var(--foreground);
    --primary: oklch(0.72 0.105 188);
    --primary-foreground: oklch(0.18 0.025 190);
    --secondary: oklch(0.27 0.016 232);
    --secondary-foreground: oklch(0.92 0.007 225);
    --muted: oklch(0.245 0.015 232);
    --muted-foreground: oklch(0.69 0.015 225);
    --accent: oklch(0.29 0.04 190);
    --accent-foreground: oklch(0.88 0.055 188);
    --destructive: oklch(0.65 0.17 25);
    --border: oklch(0.34 0.016 232);
    --input: var(--border);
    --ring: oklch(0.67 0.095 188);
  }
}

@theme inline {
  --font-sans: "Geist Variable", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "Geist Mono Variable", ui-monospace, monospace;
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --radius-sm: calc(var(--radius) - 2px);
  --radius-md: var(--radius);
  --radius-lg: 1rem;
}

@layer base {
  * { @apply border-border outline-ring/50; }
  html { @apply bg-background; }
  body { @apply min-w-80 bg-background font-sans text-foreground antialiased; }
  button, a { @apply focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background; }
}

@media (prefers-reduced-motion: no-preference) {
  button, a, [data-slot="card"] {
    transition: color 160ms ease, background-color 160ms ease,
      border-color 160ms ease, opacity 160ms ease, transform 160ms ease;
  }
  button:active { transform: translateY(1px); }
}
```

Use Tailwind classes in `AdminApp` for the remaining layout rules:

- page: `min-h-[100dvh] bg-background text-foreground`;
- top bar: one line, max 72px high, bottom border, `max-w-[1120px]` inner container;
- workspace: `grid grid-cols-1 gap-5 px-4 py-6 md:grid-cols-12 md:gap-6 md:px-6 md:py-10`;
- account panel: `md:col-span-7`, 16px card radius, tinted border shadow only;
- guidance: `md:col-span-5`, grouped by whitespace and one separator rather than nested cards;
- all multi-column account rows collapse to one column below `md`;
- action row wraps on mobile and uses full-width primary actions below `sm`;
- device code uses `font-mono`, high contrast, `break-all`, and no fake terminal chrome;
- body copy stays at or under 65 characters per line;
- no class introduces a gradient, glow, backdrop blur, or section-level theme inversion.

- [ ] **Step 5: Verify theme behavior and client regressions**

Run:

```bash
bunx vitest run test/admin/ui
bun run typecheck:admin
```

Expected: all client tests PASS; no `act(...)` warnings; admin typecheck PASS.

- [ ] **Step 6: Conditional commit checkpoint**

If commits are authorized:

```bash
git add src/admin/ui test/admin/ui/theme-control.test.tsx
git commit -m "style: polish admin authentication UI"
```

---

### Task 5: Production Build, Container Smoke Test, And Final Verification

**Files:**
- Modify: `package.json`
- Modify: `Dockerfile`
- Create: `test/admin/container-smoke.mjs`

**Interfaces:**
- Consumes: `dist/main.js`, `dist/admin-ui/app.js`, `dist/admin-ui/app.css`, and emitted font assets.
- Produces: one production image containing the server and complete admin client.

- [ ] **Step 1: Add a container smoke script before changing the build**

Create `test/admin/container-smoke.mjs`:

```js
import { createAdminApp } from "/app/dist/admin/app.js";
import { SessionStore } from "/app/dist/admin/sessions.js";

const account = {
  state: () => ({ type: "signed_out" }),
  login: async () => ({ type: "signed_out" }),
  cancel: async () => undefined,
  refresh: async () => undefined,
  logout: async () => undefined,
};
const app = createAdminApp({
  account,
  sessions: new SessionStore(),
  allowedOrigins: new Set(["http://127.0.0.1:8081"]),
  assetRoot: "/app/dist/admin-ui",
});

for (const path of ["/", "/app.js", "/app.css", "/api/state"]) {
  const response = await app.request(path);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
}
```

- [ ] **Step 2: Verify the current production build is RED**

Run:

```bash
bun run build
test -s dist/admin-ui/app.js
```

Expected: the second command FAILS because the current build only runs server `tsc`.

- [ ] **Step 3: Integrate server and client production builds**

Change `package.json` scripts to:

```json
"build:server": "tsc -p tsconfig.build.json",
"build:admin": "tsc -p tsconfig.admin.json --noEmit && vite build",
"build": "bun run build:server && bun run build:admin",
"typecheck:server": "tsc -p tsconfig.json --noEmit",
"typecheck:admin": "tsc -p tsconfig.admin.json --noEmit",
"typecheck": "bun run typecheck:server && bun run typecheck:admin"
```

Keep `check` as `biome check . && bun run typecheck && bun run test && bun run build`.

Update the Docker build-stage configuration copy to:

```dockerfile
COPY package.json bun.lock tsconfig.json tsconfig.build.json tsconfig.admin.json vite.config.ts components.json ./
```

`COPY src ./src` already includes browser source. Do not copy host `dist/`; both builds must execute inside the image.

- [ ] **Step 4: Verify deterministic production output**

Run:

```bash
bun run build
test -s dist/main.js
test -s dist/admin-ui/app.js
test -s dist/admin-ui/app.css
set -- dist/admin-ui/assets/*.woff2
test -s "$1"
```

Expected: every command exits 0. `dist/admin-ui/` contains fixed `app.js` and `app.css` plus local hashed `.woff2` assets; it contains no HTML file and no remote asset references.

- [ ] **Step 5: Run repository verification**

Run:

```bash
bun run check
git diff --check
```

Expected: Biome, both typechecks, the full Vitest suite, both builds, and whitespace validation PASS.

- [ ] **Step 6: Build and smoke-test the runtime image**

Run:

```bash
docker build -t openai-oauth-proxy:admin-ui .
docker run --rm --entrypoint node -v "$PWD/test/admin/container-smoke.mjs:/tmp/admin-container-smoke.mjs:ro" openai-oauth-proxy:admin-ui /tmp/admin-container-smoke.mjs
```

Expected: image build succeeds and the smoke script exits 0 after receiving successful mount-shell, JavaScript, CSS, and state responses from the application code and assets inside the image.

- [ ] **Step 7: Perform visual and accessibility verification**

Start the normal loopback service using the repository's documented environment, then inspect `http://127.0.0.1:8081` in a real browser.

Verify all of the following explicitly:

- 320px: single column, no horizontal overflow, primary controls remain visible and device code wraps.
- 768px: clean transition to the asymmetric workspace without a cramped guidance rail.
- Desktop: workspace maxes at 1120px, top bar remains one line and at most 72px high.
- Light, dark, and system modes preserve hierarchy and WCAG AA contrast; preference survives reload.
- Keyboard-only operation reaches every control in logical order with visible focus.
- Reduced-motion mode removes nonessential transitions and active transforms.
- Signed-out, checking, pending, ready, error, initial network failure, and inline mutation failure states are visually coherent.
- Button labels never wrap on desktop, status badges are the only pills, and no gradients, glows, glass effects, or fake data appear.

Run Lighthouse against the live loopback page and require Accessibility >= 95 and no critical Best Practices findings. Record any environment-only inability to run Lighthouse rather than weakening the checks.

- [ ] **Step 8: Conditional final commit**

If commits are authorized:

```bash
git add package.json bun.lock Dockerfile test/admin/container-smoke.mjs
git commit -m "build: ship admin frontend assets"
```
