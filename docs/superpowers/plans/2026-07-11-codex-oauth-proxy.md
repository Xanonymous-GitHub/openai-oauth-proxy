# Codex OAuth Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-user Kubernetes service that exposes the supported OpenAI Models, Chat Completions, and Responses contracts to Bifrost while executing turns through one ChatGPT-authenticated Codex App Server.

**Architecture:** A Hono data plane translates strict OpenAI request shapes into a small `CodexHost` interface backed by a long-lived stdio JSON-RPC child. SQLite persists Responses lineage and leases; an in-memory tool bridge owns generation-bound suspended dynamic-tool calls. A loopback-only admin plane delegates device authentication and refresh to App Server.

**Tech Stack:** Node.js 26.5.0, TypeScript 7.0.2, Hono 4.12.29, `@hono/node-server` 2.0.8, Zod 4.4.3, `@openai/codex` 0.144.1, built-in `node:sqlite`, Vitest 4.1.10, Biome 2.5.3, Bun 1.3.14, OpenAI JavaScript client 6.46.0, YAML 2.9.0 for manifest tests, Kubernetes.

## Global Constraints

- Keep Bifrost's provider name `openai`; configure the proxy URL under `network_config.base_url` and set `allow_private_network: true`.
- Expose only `GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/responses`, `GET /healthz`, `GET /readyz`, and authenticated `GET /metrics` on `0.0.0.0:8080`.
- Bind the admin plane only to `127.0.0.1:8081`; do not create a Service or Ingress for it.
- Accept only text and inline PNG, JPEG, or WebP data URLs; enforce 32 MiB encoded body, 10 MiB decoded per image, 24 MiB decoded aggregate, and eight images.
- Reject unknown and unsupported OpenAI fields; never silently discard them.
- Keep four active turns, a waiting queue of 32, a 10-minute ordinary turn timeout, a 15-minute pending-tool timeout, and a seven-day sliding stored-response expiry by default.
- Permit one active replica and one writer to `/data/codex` and `/data/proxy.sqlite`.
- Never parse, return, log, or implement refresh for `auth.json`; App Server owns credentials and refresh.
- Replace built-in coding instructions with the neutral adapter instructions and disable shell, unified exec, multi-agent, apps, plugins, hooks, memories, web search, MCP, skills, and sandbox network access.
- Set App Server `experimentalApi: true` only for `dynamicTools`; expose no generic JSON-RPC method and accept only the `item/tool/call` server request.
- Generate both TypeScript and JSON Schema artifacts with `--experimental`, commit them, and fail CI when regeneration differs.
- Use Node.js as the production runtime. Bun is only the package manager, builder, and task orchestrator.
- Keep `@openai/codex` and all runtime/container inputs pinned; do not update dependencies at pod startup.
- Do not add Redis, an ORM, Vite, a frontend framework, or `@openai/codex-sdk`.

## File Map

| Path | Responsibility |
|---|---|
| `package.json`, `bun.lock`, `tsconfig*.json`, `vitest.config.ts`, `biome.json` | Reproducible build, test, and formatting baseline |
| `src/config.ts` | Strict environment parsing and bounded operational defaults |
| `src/main.ts`, `src/app.ts` | Process composition, dual listeners, shutdown, and Hono route assembly |
| `src/http/auth.ts`, `src/http/errors.ts`, `src/http/limits.ts`, `src/http/sse.ts` | Shared HTTP boundary behavior |
| `src/codex/generated/**` | Version-matched App Server TypeScript and JSON Schema output |
| `src/codex/transport.ts` | Private JSONL correlation, parsing, server-request rejection, and generation invalidation |
| `src/codex/host.ts` | Only allowed account/model/thread/turn operations |
| `src/codex/supervisor.ts` | Child lifecycle, handshake, readiness, bounded restart budget |
| `src/codex/fake.ts` | Deterministic fake App Server used by protocol and route tests |
| `src/conversations/store.ts`, `src/conversations/migrations.ts` | SQLite response mapping, lineage, leases, expiry, and branch-safe cleanup |
| `src/openai/types.ts`, `src/openai/schemas.ts`, `src/openai/images.ts`, `src/openai/translate.ts` | Strict OpenAI boundary and Codex input translation |
| `src/openai/models.ts`, `src/openai/chat.ts`, `src/openai/responses.ts` | Supported `/v1` route handlers and output projection |
| `src/turns/runner.ts`, `src/turns/events.ts` | Turn lifecycle, cancellation, final aggregation, and stream events |
| `src/tools/bridge.ts` | Dynamic-tool definitions, suspended requests, external call IDs, and continuation |
| `src/admin/app.ts`, `src/admin/sessions.ts`, `src/admin/page.ts` | Loopback device-login interface, Origin/CSRF/session controls |
| `src/operations/capacity.ts`, `src/operations/metrics.ts`, `src/operations/log.ts` | Queueing, metrics, redacted structured logs |
| `config/codex/config.toml`, `config/codex/neutral-instructions.md` | App Server hardening and instruction baseline |
| `test/**` | Unit, contract, route, compatibility, security, and chaos suites |
| `deploy/**`, `Dockerfile`, `.dockerignore` | Container, StatefulSet, storage, Secret, Service, and NetworkPolicy |
| `.github/workflows/ci.yml`, `.github/dependabot.yml` | Verification, schema drift, image scanning, and dependency maintenance |

---

### Task 1: Bootstrap a Validated HTTP Process

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `vitest.config.ts`
- Create: `biome.json`
- Create: `.gitignore`
- Create: `src/config.ts`
- Create: `src/app.ts`
- Create: `src/main.ts`
- Create: `test/config.test.ts`
- Create: `test/app.test.ts`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): Config`
- Produces: `createDataApp(deps: DataAppDependencies): Hono`
- Produces: `start(config: Config): Promise<RunningService>` where `RunningService.close(): Promise<void>`

Define the composition contracts in `src/app.ts` and `src/main.ts`:

```ts
export interface DataAppDependencies {
  health(): boolean;
  ready(): boolean;
  bifrostToken: string;
  metricsToken: string;
}

export interface RunningService {
  close(): Promise<void>;
}
```

- [ ] **Step 1: Initialize version control and install the pinned baseline**

Run:

```bash
git init
bun init -y
bun add hono@4.12.29 @hono/node-server@2.0.8 zod@4.4.3 @openai/codex@0.144.1
bun add --dev typescript@7.0.2 @types/node@26.1.1 vitest@4.1.10 @biomejs/biome@2.5.3 npm-check-updates@22.2.9 openai@6.46.0
```

Expected: `package.json` and `bun.lock` exist; install exits `0`.

- [ ] **Step 2: Write failing configuration tests**

Create `test/config.test.ts` with these cases:

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const valid = {
  BIFROST_PROXY_TOKEN: "b".repeat(32),
  METRICS_TOKEN: "m".repeat(32),
  DATA_DIR: "/data",
};

describe("loadConfig", () => {
  it("loads bounded defaults", () => {
    expect(loadConfig(valid)).toMatchObject({
      dataPort: 8080,
      adminHost: "127.0.0.1",
      adminPort: 8081,
      maxActiveTurns: 4,
      queueCapacity: 32,
      turnTimeoutMs: 600_000,
      toolTimeoutMs: 900_000,
      responseTtlMs: 604_800_000,
    });
  });

  it.each([
    [{ ...valid, BIFROST_PROXY_TOKEN: "short" }, "BIFROST_PROXY_TOKEN"],
    [{ ...valid, MAX_ACTIVE_TURNS: "17" }, "MAX_ACTIVE_TURNS"],
    [{ ...valid, QUEUE_CAPACITY: "257" }, "QUEUE_CAPACITY"],
  ])("rejects invalid environment", (env, field) => {
    expect(() => loadConfig(env)).toThrow(field);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bunx vitest run test/config.test.ts`

Expected: FAIL because `src/config.ts` does not exist.

- [ ] **Step 4: Add build configuration and strict environment parsing**

Merge these exact scripts and engine fields into the generated `package.json`, retaining the pinned dependency entries created in Step 1:

```json
{
  "name": "openai-oauth-proxy",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "bun@1.3.14",
  "engines": { "node": "26.5.0", "bun": "1.3.14" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "check": "biome check . && bun run typecheck && bun run test && bun run build",
    "start": "node dist/main.js",
    "deps:check": "bunx npm-check-updates --errorLevel 2"
  }
}
```

Configure TypeScript with `module: "ESNext"`, `moduleResolution: "Bundler"`, `target` and `lib` set to `ES2024`, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, and build output `dist/`. Bundler resolution is required because generated Codex type-only imports omit file extensions; application imports still use `.js` specifiers so emitted ESM runs directly on Node. Configure Vitest for Node, `test/**/*.test.ts`, restored mocks, and a 10-second default timeout. Configure Biome for two-space indentation, double quotes, semicolons, and recommended lint rules, excluding `src/codex/generated/**` from formatting and linting.

Create `.gitignore` with `node_modules/`, `dist/`, `coverage/`, `.env`, `.env.*`, `/data/`, `auth.json`, `.superpowers/`, and local test artifacts. Never ignore `bun.lock` or generated Codex protocol files.

Implement `src/config.ts` with `z.strictObject`, coercing bounded integer fields:

```ts
export interface Config {
  dataHost: "0.0.0.0";
  dataPort: number;
  adminHost: "127.0.0.1";
  adminPort: number;
  dataDir: string;
  codexHome: string;
  codexBin: string;
  bifrostProxyToken: string;
  metricsToken: string;
  maxActiveTurns: number;
  queueCapacity: number;
  turnTimeoutMs: number;
  toolTimeoutMs: number;
  responseTtlMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config;
```

Use ranges `MAX_ACTIVE_TURNS=1..16`, `QUEUE_CAPACITY=0..256`, `TURN_TIMEOUT_MS=1_000..3_600_000`, `TOOL_TIMEOUT_MS=1_000..3_600_000`, and `RESPONSE_TTL_MS=60_000..2_592_000_000`. Require both bearer tokens to be at least 32 characters. Derive `codexHome` as `${DATA_DIR}/codex` unless `CODEX_HOME` is explicitly set.

- [ ] **Step 5: Add a runnable Hono shell and probe tests**

Create `test/app.test.ts`:

```ts
import { expect, it } from "vitest";
import { createDataApp } from "../src/app.js";

it("exposes minimal probes and rejects unknown v1 routes", async () => {
  const app = createDataApp({
    health: () => true,
    ready: () => false,
    bifrostToken: "b".repeat(32),
    metricsToken: "m".repeat(32),
  });
  expect((await app.request("/healthz")).status).toBe(200);
  expect((await app.request("/readyz")).status).toBe(503);
  const missing = await app.request("/v1/embeddings", {
    headers: { authorization: `Bearer ${"b".repeat(32)}` },
  });
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({
    error: { type: "invalid_request_error", code: "unsupported_endpoint" },
  });
});
```

Implement the two probes, explicit `/v1/*` fallback, and two `@hono/node-server` listeners. Register SIGTERM/SIGINT once; stop accepting requests, close both servers, and expose the shutdown through `RunningService.close()`.

- [ ] **Step 6: Verify the bootstrap**

Run:

```bash
bunx vitest run test/config.test.ts test/app.test.ts
bun run typecheck
bun run build
```

Expected: all tests PASS; typecheck and build exit `0`.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock tsconfig.json tsconfig.build.json vitest.config.ts biome.json .gitignore src/config.ts src/app.ts src/main.ts test/config.test.ts test/app.test.ts docs/superpowers/specs/2026-07-11-codex-oauth-proxy-design.md docs/superpowers/plans/2026-07-11-codex-oauth-proxy.md openspec/config.yaml
git commit -m "chore: bootstrap proxy service"
```

### Task 2: Generate and Fence the App Server Protocol

**Files:**
- Modify: `package.json`
- Create: `src/codex/generated/**`
- Create: `src/codex/transport.ts`
- Create: `src/codex/host.ts`
- Create: `src/codex/fake.ts`
- Create: `test/codex/generated.test.ts`
- Create: `test/codex/transport.test.ts`
- Create: `test/fixtures/fake-app-server.mjs`

**Interfaces:**
- Produces: `JsonlTransport.request(method, params, signal): Promise<unknown>` as a private module API
- Produces: `CodexHost` with only `accountRead`, `loginStart`, `loginCancel`, `logout`, `modelList`, `threadStart`, `threadResume`, `threadFork`, `threadInjectItems`, `threadDelete`, `turnStart`, and `turnInterrupt`
- Produces: `CodexHost.events(): AsyncIterable<HostNotification>` and `CodexHost.toolCalls(): AsyncIterable<PendingServerToolCall>`
- Produces: `PendingServerToolCall.respond(result: DynamicToolCallResponse): void` and `.reject(code: number, message: string): void`

- [ ] **Step 1: Add deterministic generation scripts**

Add these scripts to `package.json`:

```json
{
  "protocol:generate": "mkdir -p src/codex/generated && codex app-server generate-ts --experimental --out src/codex/generated && codex app-server generate-json-schema --experimental --out src/codex/generated",
  "protocol:check": "bun run protocol:generate && git diff --exit-code -- src/codex/generated"
}
```

Run: `bun run protocol:generate`

Expected: generated `ClientRequest.ts`, `ServerRequest.ts`, `v2/ThreadStartParams.ts`, `v2/DynamicToolCallParams.ts`, and `ClientRequest.json` exist; `ThreadStartParams` contains `dynamicTools`.

- [ ] **Step 2: Write failing generated-contract tests**

Create `test/codex/generated.test.ts` that imports `ThreadStartParams`, assigns a function `dynamicTools` entry with `type`, `name`, `description`, and `inputSchema`, and parses `src/codex/generated/ClientRequest.json` plus `ServerRequest.json`. Assert the generated client method set contains all allowed methods and the generated server-request set contains `item/tool/call`.

Define the runtime allowlists in the test exactly:

```ts
export const ALLOWED_CLIENT_METHODS = new Set([
  "initialize",
  "account/read",
  "account/login/start",
  "account/login/cancel",
  "account/logout",
  "model/list",
  "thread/start",
  "thread/resume",
  "thread/fork",
  "thread/inject_items",
  "thread/delete",
  "turn/start",
  "turn/interrupt",
]);

export const ALLOWED_SERVER_METHODS = new Set(["item/tool/call"]);
```

Extract every literal method from the two generated JSON Schemas. For every client method outside `ALLOWED_CLIENT_METHODS`, call an exported pure `assertAllowedClientMethod(method: string): void` guard and assert rejection before bytes are written; separately assert the private transport invokes that guard before serialization. For every server method outside `ALLOWED_SERVER_METHODS`, inject a valid request fixture from its generated schema and assert JSON-RPC error `-32601` before handler dispatch. Assert `initialized` is the only outgoing client notification.

- [ ] **Step 3: Write failing JSONL transport tests**

Cover these exact cases in `test/codex/transport.test.ts` with PassThrough streams:

```ts
it.each([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
  "account/chatgptAuthTokens/refresh",
  "attestation/generate",
])("rejects non-allowlisted server request %s", async (method) => {
  const response = await injectServerRequest(method);
  expect(response.error).toMatchObject({ code: -32601 });
  expect(response.error.message).not.toContain("token");
});
```

Also assert request ID correlation, malformed-line protocol failure, unknown response ID rejection, abort cleanup, and rejection of every pending request with `CodexGenerationChangedError` when `invalidateGeneration()` runs.

- [ ] **Step 4: Run tests to verify they fail**

Run: `bunx vitest run test/codex/generated.test.ts test/codex/transport.test.ts`

Expected: generated-contract test passes after generation; transport tests FAIL because the transport does not exist.

- [ ] **Step 5: Implement the private transport and narrow host**

Implement newline-delimited parsing with `node:readline`. Keep the generic `request` method private to `src/codex/transport.ts`. Before serializing, reject any method outside `ALLOWED_CLIENT_METHODS`. Route notifications to an async queue. For server requests, construct `PendingServerToolCall` only for `item/tool/call`; send error `-32601` for every other method before dispatch.

Expose this host shape from `src/codex/host.ts`:

```ts
export interface CodexHost {
  readonly generation: number;
  accountRead(refreshToken: boolean, signal?: AbortSignal): Promise<GetAccountResponse>;
  loginStart(params: LoginAccountParams, signal?: AbortSignal): Promise<LoginAccountResponse>;
  loginCancel(params: CancelLoginAccountParams, signal?: AbortSignal): Promise<CancelLoginAccountResponse>;
  logout(signal?: AbortSignal): Promise<LogoutAccountResponse>;
  modelList(params: ModelListParams, signal?: AbortSignal): Promise<ModelListResponse>;
  threadStart(params: ThreadStartParams, signal?: AbortSignal): Promise<ThreadStartResponse>;
  threadResume(params: ThreadResumeParams, signal?: AbortSignal): Promise<ThreadResumeResponse>;
  threadFork(params: ThreadForkParams, signal?: AbortSignal): Promise<ThreadForkResponse>;
  threadInjectItems(params: ThreadInjectItemsParams, signal?: AbortSignal): Promise<ThreadInjectItemsResponse>;
  threadDelete(params: ThreadDeleteParams, signal?: AbortSignal): Promise<ThreadDeleteResponse>;
  turnStart(params: TurnStartParams, signal?: AbortSignal): Promise<TurnStartResponse>;
  turnInterrupt(params: TurnInterruptParams, signal?: AbortSignal): Promise<TurnInterruptResponse>;
  events(): AsyncIterable<HostNotification>;
  toolCalls(): AsyncIterable<PendingServerToolCall>;
}

export type HostNotification = ServerNotification & { generation: number };

export interface PendingServerToolCall {
  generation: number;
  id: RequestId;
  params: DynamicToolCallParams;
  respond(result: DynamicToolCallResponse): void;
  reject(code: number, message: string): void;
}
```

Map each public method to one literal JSON-RPC method; do not accept a method string from callers. Redact stderr and protocol failures before throwing.

- [ ] **Step 6: Implement the fake App Server fixture**

Make `test/fixtures/fake-app-server.mjs` read JSONL, require `initialize` before other requests, return deterministic IDs, and support scripted notifications from a JSON fixture path in `FAKE_CODEX_SCRIPT`. Implement handshake, account, model, thread, turn, and tool-call records used by later tasks. Make `src/codex/fake.ts` expose fixture builders, not production imports.

- [ ] **Step 7: Verify protocol fencing**

Run:

```bash
bunx vitest run test/codex/generated.test.ts test/codex/transport.test.ts
bun run typecheck
```

Expected: all tests PASS, including exhaustive negative server-request cases.

- [ ] **Step 8: Commit**

```bash
git add package.json src/codex test/codex test/fixtures
git commit -m "feat: fence Codex app-server protocol"
```

### Task 3: Supervise One Long-Lived Codex Child

**Files:**
- Create: `src/codex/supervisor.ts`
- Create: `test/codex/supervisor.test.ts`
- Modify: `src/main.ts`
- Modify: `src/app.ts`

**Interfaces:**
- Produces: `CodexSupervisor.start(): Promise<CodexHost>`
- Produces: `CodexSupervisor.health(): boolean`, `.ready(): boolean`, `.generation(): number`, `.stop(): Promise<void>`
- Consumes: injectable `ChildFactory`, `Clock`, and `random(): number` for deterministic tests

- [ ] **Step 1: Write failing lifecycle tests**

Use `vi.useFakeTimers()` and a fake child factory. Assert:

```ts
it("handshakes with experimental API enabled", async () => {
  const child = fakeChild();
  const supervisor = createSupervisor({ childFactory: () => child });
  const started = supervisor.start();
  expect(child.sent[0]).toMatchObject({
    method: "initialize",
    params: {
      clientInfo: { name: "openai_oauth_proxy", title: "OpenAI OAuth Proxy" },
      capabilities: { experimentalApi: true },
    },
  });
  child.respondTo(0, { userAgent: "fixture" });
  expect(child.sent[1]).toEqual({ method: "initialized", params: {} });
  await expect(started).resolves.toBeDefined();
});
```

Also test immediate readiness removal, active-request invalidation, delays of 1/2/4/8/16 seconds with deterministic zero jitter, 30-second initialization timeout, budget reset after 10 stable minutes, terminal unhealthy state after five failed recovery attempts, and graceful stop without restart.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/codex/supervisor.test.ts`

Expected: FAIL because `CodexSupervisor` does not exist.

- [ ] **Step 3: Implement the supervisor state machine**

Use these explicit states:

```ts
type SupervisorState =
  | { type: "stopped" }
  | { type: "starting"; attempt: number }
  | { type: "ready"; since: number }
  | { type: "recovering"; attempt: number }
  | { type: "unhealthy"; failures: 5 };
```

Spawn `config.codexBin` with `['app-server']`, `cwd` set to an empty dedicated directory, `CODEX_HOME` set to `config.codexHome`, and stdio `['pipe', 'pipe', 'pipe']`. Treat spawn failure, initialization timeout, malformed protocol, and pre-stability child exit as failed recovery attempts. Add up to 25 percent jitter to each fixed delay. On generation change, invalidate transport calls and pending tools before creating the next host.

- [ ] **Step 4: Wire probes and shutdown**

Make `/healthz` return `200` unless supervisor state is `unhealthy` or the Node process is draining. Make `/readyz` require supervisor readiness; account readiness is added in Task 11. During shutdown, remove readiness, interrupt active turns through the runner hook, wait up to 30 seconds, then terminate the child.

- [ ] **Step 5: Verify lifecycle behavior**

Run:

```bash
bunx vitest run test/codex/supervisor.test.ts test/app.test.ts
bun run typecheck
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/codex/supervisor.ts src/main.ts src/app.ts test/codex/supervisor.test.ts
git commit -m "feat: supervise Codex app-server"
```

### Task 4: Persist Response Lineage and Thread Leases

**Files:**
- Create: `src/conversations/migrations.ts`
- Create: `src/conversations/store.ts`
- Create: `test/conversations/store.test.ts`

**Interfaces:**
- Produces: `ConversationStore.open(path, clock): ConversationStore`
- Produces: `createPending`, `complete`, `lookup`, `touch`, `acquireLease`, `releaseLease`, `markContinuationLost`, `expire`, and `deletableLeafThreads`
- Produces: `ContinuationDecision` union with `start`, `resume`, `fork`, `busy`, `not_found`, and `lost`

```ts
export type ContinuationDecision =
  | { type: "start" }
  | { type: "resume"; responseId: string; threadId: string }
  | { type: "fork"; responseId: string; threadId: string; lastTurnId: string }
  | { type: "busy" }
  | { type: "not_found" }
  | { type: "lost" };
```

- [ ] **Step 1: Write failing store tests against a temporary SQLite file**

Test these state transitions:

```ts
expect(store.decide(undefined, "req-1")).toEqual({ type: "start" });
expect(store.decide(latestId, "req-2")).toMatchObject({ type: "resume", threadId: "thr_a" });
expect(store.decide(olderId, "req-3")).toMatchObject({
  type: "fork",
  threadId: "thr_a",
  lastTurnId: "turn_1",
});
expect(store.decide(latestId, "req-4")).toEqual({ type: "busy" });
```

Also assert opaque `resp_` IDs, seven-day sliding touch, `store=false` non-resumability, rollback on failed writes, stale lease recovery, pending-tool generation mismatch returning `lost`, immediate logical expiry, and leaf-first deletion where an expired ancestor remains until descendants expire. Open a database created with each previous migration fixture, apply only additive forward migrations, and verify the immediately previous application schema can still read its original tables after migration.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/conversations/store.test.ts`

Expected: FAIL because the store does not exist.

- [ ] **Step 3: Add transactional migrations**

Use built-in `DatabaseSync` from `node:sqlite`, `PRAGMA journal_mode=WAL`, `PRAGMA foreign_keys=ON`, and `PRAGMA busy_timeout=5000`. Create:

```sql
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
CREATE TABLE responses (
  response_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  turn_id TEXT,
  parent_response_id TEXT REFERENCES responses(response_id),
  root_response_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','complete','lost','expired')),
  stored INTEGER NOT NULL CHECK (stored IN (0,1)),
  process_generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_access_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX responses_thread_idx ON responses(thread_id, created_at);
CREATE INDEX responses_expiry_idx ON responses(state, expires_at);
CREATE TABLE thread_lineage (
  thread_id TEXT PRIMARY KEY,
  parent_thread_id TEXT REFERENCES thread_lineage(thread_id),
  forked_at_turn_id TEXT
);
CREATE TABLE thread_leases (
  thread_id TEXT PRIMARY KEY,
  owner_request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('turn','tool')),
  process_generation INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
```

Wrap each migration and `schema_migrations` insert in one `BEGIN IMMEDIATE` transaction.

- [ ] **Step 4: Implement deterministic decisions and cleanup**

Generate IDs with `resp_${base64url(randomBytes(24))}`. Acquire leases with `INSERT ... ON CONFLICT DO NOTHING`; never wait inside SQLite. `deletableLeafThreads()` must return only expired threads with no live descendant mapping. Mark mappings unavailable before asynchronous App Server deletion.

- [ ] **Step 5: Verify persistence**

Run:

```bash
bunx vitest run test/conversations/store.test.ts
bun run typecheck
```

Expected: all tests PASS with no open-handle warning.

- [ ] **Step 6: Commit**

```bash
git add src/conversations test/conversations
git commit -m "feat: persist response lineage"
```

### Task 5: Define the Strict OpenAI Boundary

**Files:**
- Create: `src/http/errors.ts`
- Create: `src/http/auth.ts`
- Create: `src/http/limits.ts`
- Create: `src/openai/types.ts`
- Create: `src/openai/schemas.ts`
- Create: `src/openai/images.ts`
- Create: `src/openai/translate.ts`
- Create: `test/openai/schemas.test.ts`
- Create: `test/openai/images.test.ts`
- Create: `test/openai/translate.test.ts`

**Interfaces:**
- Produces: `ProxyError` and `toOpenAIError(error, requestId): Response`
- Produces: `parseChatRequest(value): ChatRequest`, `parseResponsesRequest(value): ResponsesRequest`
- Produces: `decodeImages(parts): DecodedImage[]`
- Produces: `translateHistory(messages): ResponseItem[]` and `translateTurnInput(input): UserInput[]`

```ts
export interface DecodedImage {
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  dataUrl: string;
  decodedBytes: number;
}
```

- [ ] **Step 1: Write failing strict-schema tests**

Use table tests proving accepted role/content/tool shapes and rejection of unknown fields, remote images, file IDs, sampling fields, forced function selection, Platform built-in tools, audio, background mode, and `store=false` with tools. Assert Zod error paths become OpenAI `error.param` values such as `messages.0.content.1.image_url.url`.

Use this canonical unsupported-field assertion:

```ts
expect(() => parseChatRequest({
  model: "gpt-5.4",
  messages: [{ role: "user", content: "hello" }],
  temperature: 0.2,
})).toThrowError(expect.objectContaining({
  code: "unsupported_field",
  param: "temperature",
  status: 400,
}));
```

- [ ] **Step 2: Write failing image tests**

Include one valid fixture for each media type and invalid declaration/signature pairs. Assert 10 MiB per-image, 24 MiB aggregate, eight-image, and 32 MiB body failures use stable codes `image_too_large`, `image_aggregate_too_large`, `too_many_images`, and `request_too_large`.

- [ ] **Step 3: Write failing role-preservation tests**

Verify history becomes raw `ResponseItem` messages without concatenation and the final user text/image becomes Codex `UserInput`. Verify assistant tool-call and tool-result records retain exact external call IDs.

- [ ] **Step 4: Run tests to verify they fail**

Run: `bunx vitest run test/openai`

Expected: FAIL because schemas and translators do not exist.

- [ ] **Step 5: Implement strict schemas and stable errors**

Use `z.strictObject` for every request and nested object. Model supported tool choice as `z.enum(["auto", "none"])`; model only `{ type: "function", function: { name, description?, parameters } }` tools. Because Codex 0.144.1 generates `ReasoningEffort` as `string`, validate explicitly with `z.enum(["minimal", "low", "medium", "high", "xhigh"])`, then reject values absent from the selected model's `supportedReasoningEfforts`. Keep the internal request types inferred from the schemas.

Define the error envelope exactly:

```ts
export interface OpenAIErrorBody {
  error: {
    message: string;
    type: "invalid_request_error" | "authentication_error" | "server_error";
    param: string | null;
    code: string;
  };
}
```

Map statuses and codes according to the design, sanitize upstream messages, and set `x-request-id` on every response.

- [ ] **Step 6: Implement signature-aware image decoding and translation**

Accept only `data:image/png;base64,`, `data:image/jpeg;base64,`, and `data:image/webp;base64,`. Verify PNG `89504e470d0a1a0a`, JPEG `ffd8ff`, and WebP `RIFF....WEBP`. Pass the original validated data URL as `{ type: "image", url }`; do not write image bytes to disk.

- [ ] **Step 7: Verify boundary behavior**

Run:

```bash
bunx vitest run test/openai
bun run typecheck
```

Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/http src/openai test/openai
git commit -m "feat: validate OpenAI request boundary"
```

### Task 6: Run and Project Codex Turns

**Files:**
- Create: `src/turns/events.ts`
- Create: `src/turns/runner.ts`
- Create: `src/http/sse.ts`
- Create: `test/turns/runner.test.ts`
- Create: `test/http/sse.test.ts`

**Interfaces:**
- Produces: `TurnRunner.run(command, signal): Promise<TurnResult>`
- Produces: `TurnRunner.stream(command, signal): AsyncIterable<ProxyStreamEvent>`
- Produces: `TurnCommand` with thread action, model, history, input, effort, and output schema
- Produces: `TurnResult` with text, authoritative usage when present, thread/turn IDs, and finish reason

```ts
export type ThreadAction =
  | { type: "start" }
  | { type: "resume"; threadId: string }
  | { type: "fork"; threadId: string; lastTurnId: string };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TurnCommand {
  action: ThreadAction;
  model: string;
  history: ResponseItem[];
  input: UserInput[];
  instructions?: string;
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  outputSchema?: JsonValue;
}

export interface TurnResult {
  threadId: string;
  turnId: string;
  text: string;
  finishReason: "stop";
  usage?: TokenUsage;
}
```

- [ ] **Step 1: Write failing runner tests**

Script the fake App Server to emit `item/agentMessage/delta`, authoritative completed agent-message item, token usage, and `turn/completed`. Assert final text comes from the completed item, deltas stream in order, internal command/file/reasoning events are omitted, usage is absent when no token event exists, and failed/interrupted turns map to stable errors.

Assert every new thread starts with:

```ts
expect(host.threadStart).toHaveBeenCalledWith(expect.objectContaining({
  cwd: emptyWorkingDirectory,
  approvalPolicy: "never",
  sandbox: "read-only",
  baseInstructions: neutralInstructions,
  developerInstructions: null,
  ephemeral: false,
  serviceName: "openai_oauth_proxy",
  environments: [],
  selectedCapabilityRoots: [],
}));
```

Use persisted non-ephemeral threads even for disposable Chat because `thread/delete` rejects ephemeral roots.

- [ ] **Step 2: Write failing cancellation and SSE tests**

Abort an in-progress stream and assert one `turn/interrupt` call with both IDs, one lease-release callback, and one thread cleanup callback. Test SSE encoding with CR/LF-safe `data:` lines, named Responses events, Chat `[DONE]`, and no serialization of `undefined` fields.

- [ ] **Step 3: Run tests to verify they fail**

Run: `bunx vitest run test/turns test/http/sse.test.ts`

Expected: FAIL because runner and encoder do not exist.

- [ ] **Step 4: Implement the turn state machine**

For `start`, call `thread/start`, inject translated history with `thread/inject_items`, then call `turn/start`. For `resume`, call `thread/resume`; for `fork`, call `thread/fork` with inclusive `lastTurnId`. If Responses `instructions` is present, inject it as the newest raw developer message immediately before current input; do not replace the neutral baseline or flatten it into user text. Track one accumulator by `(threadId, turnId)`. Treat completed items and `turn/completed` as authoritative. Interrupt on request abort or 10-minute timeout.

Project only these proxy-owned events:

```ts
export type ProxyStreamEvent =
  | { type: "text.delta"; delta: string }
  | { type: "usage"; usage: TokenUsage }
  | { type: "completed"; result: TurnResult }
  | { type: "failed"; error: ProxyError };
```

- [ ] **Step 5: Verify turns and streams**

Run:

```bash
bunx vitest run test/turns test/http/sse.test.ts
bun run typecheck
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/turns src/http/sse.ts test/turns test/http/sse.test.ts
git commit -m "feat: run Codex turns"
```

### Task 7: Expose Authenticated Model Listing

**Files:**
- Create: `src/openai/models.ts`
- Create: `test/openai/models.test.ts`
- Modify: `src/app.ts`

**Interfaces:**
- Produces: `ModelCatalog.list(signal): Promise<OpenAIModelList>` with a 60-second cache
- Consumes: `CodexHost.modelList`

```ts
export interface OpenAIModelList {
  object: "list";
  data: Array<{ id: string; object: "model"; created: 0; owned_by: "openai" }>;
}
```

- [ ] **Step 1: Write failing route tests**

Assert missing/wrong bearer returns `401`, valid bearer returns only non-hidden text-capable models, App Server IDs remain unchanged, missing `inputModalities` defaults to text+image, cache prevents a second call for 60 seconds, and upstream/auth failures become sanitized `503` responses.

Expected response:

```json
{
  "object": "list",
  "data": [
    { "id": "gpt-5.4", "object": "model", "created": 0, "owned_by": "openai" }
  ]
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/openai/models.test.ts`

Expected: FAIL with route `404`.

- [ ] **Step 3: Implement bearer middleware and model projection**

Use constant-time comparison after checking equal token byte lengths. Apply Bifrost authentication only to `/v1/*`; apply the separate metrics token only to `/metrics`. Page `model/list` until `nextCursor` is null, use `includeHidden: false`, and keep image support in the internal cache for later request validation.

- [ ] **Step 4: Verify the first data-plane slice**

Run:

```bash
bunx vitest run test/openai/models.test.ts test/app.test.ts
bun run typecheck
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/openai/models.ts src/app.ts test/openai/models.test.ts
git commit -m "feat: expose Codex models"
```

### Task 8: Implement Chat Completions

**Files:**
- Create: `src/openai/chat.ts`
- Create: `test/openai/chat.test.ts`
- Modify: `src/app.ts`
- Modify: `src/turns/runner.ts`

**Interfaces:**
- Produces: `createChatHandler(deps): Handler`
- Consumes: `parseChatRequest`, `translateHistory`, `TurnRunner`, and `ModelCatalog`
- Produces disposable-thread cleanup after final output, failure, abort, or timeout

- [ ] **Step 1: Write failing non-streaming route tests**

Send a complete role history and assert the fake host receives raw history injection followed by only the final user input. Assert the response shape exactly:

```ts
expect(await response.json()).toMatchObject({
  id: expect.stringMatching(/^chatcmpl_[A-Za-z0-9_-]{32}$/),
  object: "chat.completion",
  model: "gpt-5.4",
  choices: [{
    index: 0,
    message: { role: "assistant", content: "fixture answer" },
    finish_reason: "stop",
  }],
});
```

Verify `created` is integer epoch seconds, authoritative usage is included only when supplied, image capability is checked against the selected model, and `thread/delete` runs exactly once after success and each failure path.

- [ ] **Step 2: Write failing streaming route tests**

Assert `content-type: text/event-stream`, initial role delta, ordered text deltas, terminal chunk with `finish_reason: "stop"`, then `data: [DONE]`. Abort the `ReadableStream` and assert `turn/interrupt`, lease release, and thread deletion.

- [ ] **Step 3: Run tests to verify they fail**

Run: `bunx vitest run test/openai/chat.test.ts`

Expected: FAIL with route `404`.

- [ ] **Step 4: Implement stateless Chat orchestration**

Generate `chatcmpl_` IDs from 24 random bytes. Start one persisted Codex thread per ordinary request with the neutral policy, inject every complete history item before the final user message, execute one turn, and delete the thread in `finally`. Do not create a process or OAuth session per request.

For streaming, map only proxy `text.delta`, `usage`, `completed`, and later `tool.call` events. Use `streamSSE` and `stream.onAbort`; never expose raw App Server events. Set `Cache-Control: no-cache` and `X-Accel-Buffering: no`.

- [ ] **Step 5: Verify Chat behavior**

Run:

```bash
bunx vitest run test/openai/chat.test.ts test/turns/runner.test.ts
bun run typecheck
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/openai/chat.ts src/app.ts src/turns/runner.ts test/openai/chat.test.ts
git commit -m "feat: add Chat Completions"
```

### Task 9: Implement Stored and Branching Responses

**Files:**
- Create: `src/openai/responses.ts`
- Create: `test/openai/responses.test.ts`
- Modify: `src/app.ts`
- Modify: `src/conversations/store.ts`
- Modify: `src/turns/runner.ts`

**Interfaces:**
- Produces: `createResponsesHandler(deps): Handler`
- Consumes: `ConversationStore.decide`, `TurnRunner`, and strict Responses schemas
- Produces: one opaque `resp_` mapping per successful or tool-suspended result

- [ ] **Step 1: Write failing continuity tests**

Cover these exact calls:

```ts
await postResponse({ model: "gpt-5.4", input: "first" });
await postResponse({ model: "gpt-5.4", input: "latest", previous_response_id: first.id });
await postResponse({ model: "gpt-5.4", input: "branch", previous_response_id: first.id });
```

Assert the second call resumes the first thread and the third forks at the first response's `turnId`. Assert unknown/expired IDs return `404 response_not_found`, competing leases return retryable `409 thread_busy`, interrupted turns create no successful mapping, and a successful continuation slides expiry to seven days.

- [ ] **Step 2: Write failing storage and stream tests**

Assert omitted/true `store` persists, `store=false` deletes the thread after final output and cannot resume, and `store=false` plus tools is rejected before starting a thread. For streaming, assert the sequence contains `response.created`, text delta events, `response.output_text.done`, and one `response.completed` with the same `resp_` ID.

- [ ] **Step 3: Run tests to verify they fail**

Run: `bunx vitest run test/openai/responses.test.ts`

Expected: FAIL with route `404`.

- [ ] **Step 4: Implement the Responses state machine**

Reserve a response ID and lease transactionally before calling App Server. Dispatch `start`, `resume`, or `fork` exactly from `ContinuationDecision`. Record the returned `threadId` and `turnId`, complete the mapping only after authoritative turn completion, and release a normal lease in `finally`. Preserve the lease when Task 10 returns pending tool calls.

Build this minimum non-streaming result shape:

```ts
export interface ProxyResponse {
  id: string;
  object: "response";
  created_at: number;
  status: "completed";
  model: string;
  output: Array<{
    id: string;
    type: "message";
    status: "completed";
    role: "assistant";
    content: Array<{ type: "output_text"; text: string; annotations: [] }>;
  }>;
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
}
```

Project only supported fields. Do not claim Platform fields for which App Server has no authoritative value.

- [ ] **Step 5: Add expiry and branch-aware physical cleanup**

Run a startup cleanup and hourly sweep. Mark expired mappings first, ask `deletableLeafThreads()` for safe leaves, call `thread/delete`, then remove lineage rows. On App Server failure, retain logically expired state and retry cleanup later. Never delete an ancestor with a live descendant mapping because App Server deletion is recursive.

- [ ] **Step 6: Verify Responses behavior**

Run:

```bash
bunx vitest run test/openai/responses.test.ts test/conversations/store.test.ts
bun run typecheck
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/openai/responses.ts src/app.ts src/conversations/store.ts src/turns/runner.ts test/openai/responses.test.ts
git commit -m "feat: add stored Responses"
```

### Task 10: Bridge Client-Executed Function Tools

**Files:**
- Create: `src/tools/bridge.ts`
- Create: `test/tools/bridge.test.ts`
- Modify: `src/turns/runner.ts`
- Modify: `src/openai/chat.ts`
- Modify: `src/openai/responses.ts`
- Modify: `src/openai/translate.ts`
- Modify: `test/openai/chat.test.ts`
- Modify: `test/openai/responses.test.ts`

**Interfaces:**
- Produces: `ToolBridge.toDynamicTools(tools): DynamicToolSpec[]`
- Produces: `ToolBridge.register(call, context): ExternalToolCall`
- Produces: `ToolBridge.continue(request): Promise<ToolContinuation>`
- Produces: `ToolBridge.invalidateGeneration(generation): void` and `.expire(now): void`
- External call IDs encode host generation as `call_g<generation>_<base64url>`

Task 10 extends `TurnCommand` with `dynamicTools?: DynamicToolSpec[]`, extends `TurnResult.finishReason` with `"tool_calls"`, and adds `{ type: "tool.call"; call: ExternalToolCall }` to `ProxyStreamEvent`.

```ts
export interface ExternalToolCall {
  id: string;
  name: string;
  arguments: JsonValue;
}

export type ToolContinuation =
  | { type: "continued"; threadId: string; turnId: string; result: Promise<TurnResult> }
  | { type: "incomplete"; missingCallIds: string[] }
  | { type: "lost" };
```

- [ ] **Step 1: Write failing dynamic-tool definition tests**

Assert one OpenAI function maps exactly:

```ts
expect(bridge.toDynamicTools([{ type: "function", function: {
  name: "weather",
  description: "Read weather",
  parameters: { type: "object", properties: { city: { type: "string" } } },
} }])).toEqual([{ 
  type: "function",
  name: "weather",
  description: "Read weather",
  inputSchema: { type: "object", properties: { city: { type: "string" } } },
}]);
```

Reject invalid/reserved names and schemas before `thread/start`. Pass `dynamicTools` only at thread creation and require tool definitions to match exactly on continuation. With `tool_choice: "none"`, pass no dynamic tools; with `tool_choice: "auto"`, pass the validated function tools. Reject `parallel_tool_calls: false` and every forced function choice at the schema boundary.

- [ ] **Step 2: Write failing suspension and fan-in tests**

Inject one and multiple `item/tool/call` server requests. Assert no tool executes in the proxy, all calls are emitted to the client, the HTTP response ends with tool-call finish state while App Server requests remain unresolved, partial/unknown/duplicate result sets fail, and all valid results resolve together.

Return each textual tool result to App Server exactly:

```ts
pending.respond({
  success: true,
  contentItems: [{ type: "inputText", text: resultText }],
});
```

Assert failed client results set `success: false` and contain only sanitized text.

- [ ] **Step 3: Write failing timeout and generation tests**

With fake time, assert 15-minute expiry interrupts the turn and releases the lease. Change process generation and assert pending calls reject, Responses continuation returns `409 proxy_continuation_lost`, and a Chat call ID carrying an old generation also returns `409 proxy_continuation_lost` rather than `400 unknown_tool_call`.

- [ ] **Step 4: Run tests to verify they fail**

Run: `bunx vitest run test/tools test/openai/chat.test.ts test/openai/responses.test.ts`

Expected: tool tests FAIL because the bridge does not exist.

- [ ] **Step 5: Implement the generation-bound pending registry**

Store pending calls and the turn accumulator only in memory because responder closures belong to one App Server process. Keep this record per suspended turn:

```ts
interface PendingTurn {
  kind: "chat" | "responses";
  responseId?: string;
  threadId: string;
  turnId: string;
  leaseOwner: string;
  generation: number;
  toolFingerprint: string;
  expiresAt: number;
  calls: Map<string, PendingServerToolCall>;
  completion: Promise<TurnResult>;
}
```

Hash canonicalized tool definitions for continuation matching. Retain the thread lease while suspended. Resolve every App Server request only after the submitted external call-ID set equals the outstanding set. A central runner event dispatcher keeps the accumulator alive after the first HTTP response ends; continuation handlers await `completion` after resolving results. A deliberately suspended stream closes normally and must not run the client-disconnect interrupt path.

- [ ] **Step 6: Project Chat and Responses tool outputs**

For Chat, emit assistant `tool_calls` with JSON-stringified arguments and terminal `finish_reason: "tool_calls"`; recognize subsequent `tool` messages by call ID. Override Task 8's ordinary cleanup: retain the disposable thread while suspended and delete it only after final output, failure, timeout, generation loss, or cancellation. For Responses, emit `function_call` output items and accept `function_call_output` inputs. A pending response may accept only matching outputs and may not branch.

For streaming Chat, emit indexed `delta.tool_calls`; for streaming Responses, emit supported function-call argument and output-item events followed by the suspended response object. Never expose App Server call IDs.

- [ ] **Step 7: Verify repeated and parallel loops**

Run:

```bash
bunx vitest run test/tools test/openai/chat.test.ts test/openai/responses.test.ts
bun run typecheck
```

Expected: single, parallel, repeated, timeout, and restart tool-loop tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/tools src/turns/runner.ts src/openai test/tools test/openai
git commit -m "feat: bridge client function tools"
```

### Task 11: Add Device Authentication and the Loopback Admin Plane

**Files:**
- Create: `src/admin/sessions.ts`
- Create: `src/admin/page.ts`
- Create: `src/admin/app.ts`
- Create: `src/codex/account.ts`
- Create: `test/admin/app.test.ts`
- Create: `test/codex/account.test.ts`
- Modify: `src/main.ts`
- Modify: `src/app.ts`

**Interfaces:**
- Produces: `AccountManager.start(): Promise<void>`, `.state(): AccountState`, `.ready(): boolean`
- Produces: `createAdminApp({ account, sessions, allowedOrigins }): Hono`
- Account readiness requires `account.type === "chatgpt"` after `account/read({ refreshToken: true })`

- [ ] **Step 1: Write failing account lifecycle tests**

Assert startup calls forced refresh, API-key/Bedrock/null accounts remain unready, only ChatGPT becomes ready, `account/updated` and `account/login/completed` update state, child generation change re-reads account state, refresh failure removes readiness without failing liveness, and logout removes readiness immediately.

- [ ] **Step 2: Write failing admin security tests**

Assert the admin app:

- sets an opaque `HttpOnly; SameSite=Strict; Path=/` session cookie;
- rejects mutating requests without exact `Origin` of `http://127.0.0.1:8081` or `http://localhost:8081`;
- rejects missing/wrong CSRF tokens;
- never includes `auth.json`, access tokens, refresh tokens, ID tokens, or credential paths;
- accepts `POST /api/login` only with `{ "type": "chatgptDeviceCode" }`;
- displays only `verificationUrl`, `userCode`, `loginId`, status, account email, and plan type;
- delegates cancel, forced account read, and logout to `AccountManager`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `bunx vitest run test/admin test/codex/account.test.ts`

Expected: FAIL because account/admin modules do not exist.

- [ ] **Step 4: Implement account state and readiness composition**

Represent state explicitly:

```ts
export type AccountState =
  | { type: "checking" }
  | { type: "signed_out" }
  | { type: "ready"; email: string | null; planType: string }
  | { type: "login_pending"; loginId: string; verificationUrl: string; userCode: string }
  | { type: "error"; code: "authentication_required" };
```

Data-plane readiness requires both supervisor readiness and account readiness. Data requests while unready return `503 authentication_required`; admin routes remain usable.

- [ ] **Step 5: Implement the framework-free admin page**

Serve one static HTML document with semantic form controls, status region, device URL, code, refresh, cancel, and logout buttons. Use a nonce-free external same-origin script route or a CSP-hashed inline script. Set CSP to `default-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`. Escape all dynamic text.

Keep session and CSRF records in memory with 30-minute idle expiry. Generate both from 32 random bytes. Do not persist browser sessions.

- [ ] **Step 6: Verify authentication and admin flow**

Run:

```bash
bunx vitest run test/admin test/codex/account.test.ts test/app.test.ts
bun run typecheck
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/admin src/codex/account.ts src/main.ts src/app.ts test/admin test/codex/account.test.ts
git commit -m "feat: add device login admin"
```

### Task 12: Enforce Capacity, Limits, Observability, and Drain

**Files:**
- Create: `src/operations/capacity.ts`
- Create: `src/operations/metrics.ts`
- Create: `src/operations/log.ts`
- Create: `test/operations/capacity.test.ts`
- Create: `test/operations/metrics.test.ts`
- Create: `test/operations/log.test.ts`
- Modify: `src/app.ts`
- Modify: `src/main.ts`
- Modify: `src/http/limits.ts`

**Interfaces:**
- Produces: `TurnCapacity.acquire(signal): Promise<Permit>` with `Permit.release(): void`
- Produces: `Metrics.render(): string`
- Produces: `log(event: LogEvent): void` with a compile-time payload whitelist

```ts
export interface Permit { release(): void }

export interface LogEvent {
  requestId: string;
  route: "models" | "chat" | "responses" | "metrics" | "admin";
  model?: string;
  status: number;
  durationMs: number;
  streamOutcome?: "completed" | "cancelled" | "failed";
  queueOutcome?: "admitted" | "queued" | "full";
  leaseOutcome?: "acquired" | "busy" | "released";
  processGeneration?: number;
  restartReason?: string;
}
```

- [ ] **Step 1: Write failing capacity tests**

Assert four permits run concurrently, the next 32 wait FIFO, request 37 receives `429 queue_full`, aborted queued requests disappear, every permit releases once, and draining rejects new work with `503 service_unavailable`.

- [ ] **Step 2: Write failing body-limit, metrics, and redaction tests**

Assert oversized `Content-Length` is rejected before body read and chunked bodies stop after 32 MiB. Assert `/metrics` requires the metrics token and emits counters/gauges for requests, latency, error codes, active turns, queue depth, busy threads, pending/expired tools, App Server restarts, and auth readiness.

Pass a fixture containing prompts, images, tool arguments/results, authorization headers, raw events, and OAuth-shaped tokens through the logger. Assert none appear in output. The logger API must not accept arbitrary request bodies.

- [ ] **Step 3: Run tests to verify they fail**

Run: `bunx vitest run test/operations`

Expected: FAIL because operational modules do not exist.

- [ ] **Step 4: Implement capacity and streaming body limits**

Acquire capacity after authentication/validation and before a lease or thread is created. Implement an abort-aware FIFO array with fixed maximum length; do not add another queueing dependency. Read request bodies through a counting stream and cancel the reader when the encoded limit is exceeded.

- [ ] **Step 5: Implement low-cardinality metrics and whitelisted JSON logs**

Do not label metrics by response ID, thread ID, request ID, prompt, tool name, or raw model values. Permit bounded route, status, stable error code, and process-generation labels. Log request ID, route, model, status, duration, stream outcome, queue/lease outcome, redacted correlations, process generation, and restart reason only.

- [ ] **Step 6: Implement graceful drain**

On SIGTERM: mark draining, fail readiness, stop admitting work, wait up to 30 seconds, interrupt remaining turns, invalidate pending tools, close SQLite, stop App Server, then close listeners. Make repeated signals idempotent.

- [ ] **Step 7: Verify operations**

Run:

```bash
bunx vitest run test/operations test/app.test.ts
bun run check
```

Expected: all tests PASS; formatting, lint, typecheck, test, and build exit `0`.

- [ ] **Step 8: Commit**

```bash
git add src/operations src/http/limits.ts src/app.ts src/main.ts test/operations
git commit -m "feat: enforce proxy operations"
```

### Task 13: Harden Codex and Build the Production Image

**Files:**
- Create: `config/codex/config.toml`
- Create: `config/codex/neutral-instructions.md`
- Create: `test/security/codex-config.test.ts`
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `test/container.test.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Produces: immutable runtime image executing `node dist/main.js` as UID/GID 10001
- Consumes: `/data` PVC, bounded `/tmp`, and read-only `/app/config/codex`

- [ ] **Step 1: Write failing Codex configuration tests**

Parse `config.toml` in the test without adding a runtime TOML dependency; assert literal entries exist for:

```toml
cli_auth_credentials_store = "file"
forced_login_method = "chatgpt"
approval_policy = "never"
sandbox_mode = "read-only"
model_instructions_file = "/app/config/codex/neutral-instructions.md"
web_search = "disabled"
check_for_update_on_startup = false

[features]
apps = false
hooks = false
memories = false
multi_agent = false
remote_plugin = false
shell_tool = false
skill_mcp_dependency_install = false
unified_exec = false
network_proxy = false
```

Assert no `mcp_servers`, app, plugin, skill root, hook, writable workspace, or network allow entry exists. Assert neutral instructions mention only text/client functions, unavailable internal tools, no assumed repository/workspace, and requested output format; reject coding-agent persona text.

Also test startup file security: set `process.umask(0o077)` before any filesystem write, create `${CODEX_HOME}` with mode `0700`, and ensure a newly created SQLite file and App Server credential fixture have mode `0600`.

- [ ] **Step 2: Run the security test to verify it fails**

Run: `bunx vitest run test/security/codex-config.test.ts`

Expected: FAIL because hardening files do not exist.

- [ ] **Step 3: Add hardening files and startup verification**

Set `process.umask(0o077)`, create `${CODEX_HOME}` as `0700`, and write the read-only baseline config atomically to `${CODEX_HOME}/config.toml` on every startup, preserving only App Server-owned credential/session files. Force `/data/proxy.sqlite` to `0600` after creation. Inspect the completed local config before spawning App Server and fail closed if required hardening differs; do not add `config/read` to the RPC allowlist. Create the empty working directory under `/tmp/work`; never point App Server at the application source.

- [ ] **Step 4: Build a multi-stage image**

Use `oven/bun:1.3.14` as builder and `node:26.5.0-bookworm-slim` as runtime. Before writing the final Dockerfile, resolve immutable multi-architecture digests:

```bash
docker buildx imagetools inspect oven/bun:1.3.14
docker buildx imagetools inspect node:26.5.0-bookworm-slim
```

Replace each `FROM image:tag` with the returned top-level digest, validated against `^sha256:[0-9a-f]{64}$`. Install with `bun install --frozen-lockfile`, regenerate protocol bindings and build in the builder, copy production dependencies, generated bindings, config, and `dist/`, then run as `USER 10001:10001`. CI, where Git metadata is available, performs the separate protocol-diff check. Do not bake credentials or writable source into the image.

- [ ] **Step 5: Add image assertions**

In `test/container.test.ts`, inspect Dockerfile text and assert two digest-pinned `FROM` lines, non-root user, Node entrypoint, no `latest`, no copied `.env`/`auth.json`, and no shell-form entrypoint. If Docker is available, build and run `node --version`, expecting `v26.5.0`.

- [ ] **Step 6: Verify security and image**

Run:

```bash
bunx vitest run test/security test/container.test.ts
docker buildx build --platform linux/amd64,linux/arm64 --output type=oci,dest=/tmp/openai-oauth-proxy.oci .
```

Expected: tests PASS and both platform builds complete.

- [ ] **Step 7: Commit**

```bash
git add config Dockerfile .dockerignore src/main.ts test/security test/container.test.ts
git commit -m "build: harden proxy image"
```

### Task 14: Deliver the Single-Replica Kubernetes Deployment

**Files:**
- Create: `deploy/base/kustomization.yaml`
- Create: `deploy/base/statefulset.yaml`
- Create: `deploy/base/service.yaml`
- Create: `deploy/base/networkpolicy.yaml`
- Create: `deploy/base/secret.example.yaml`
- Create: `deploy/base/pvc.yaml`
- Create: `deploy/bifrost/config.example.json`
- Create: `test/deploy/manifests.test.ts`
- Modify: `package.json`
- Modify: `bun.lock`

**Interfaces:**
- Produces: StatefulSet `openai-oauth-proxy` with exactly one replica and `ReadWriteOnce` `/data`
- Produces: ClusterIP Service exposing data port 8080 only
- Produces: example Bifrost built-in `openai` provider configuration

- [ ] **Step 1: Write failing manifest tests**

Run `bun add --dev yaml@2.9.0`, then parse the rendered YAML documents. Assert:

- StatefulSet replicas equal `1`, update strategy is rolling, and pod management is ordered;
- pod/container security contexts enforce non-root UID/GID 10001, dropped `ALL` capabilities, `RuntimeDefault` seccomp, read-only root filesystem, no privilege escalation, and no service-account token;
- pod security context sets `fsGroup: 10001` and `fsGroupChangePolicy: OnRootMismatch` so the single writer can enforce `0700`/`0600` application modes;
- PVC is `ReadWriteOnce`, storage class is operator-supplied, and `/data` is the only persistent writable mount;
- `/tmp` uses size-bounded `emptyDir` and admin port is container-only;
- startup/liveness use `/healthz`, readiness uses `/readyz`, and graceful termination is at least 30 seconds;
- Service exposes only 8080;
- NetworkPolicy limits ingress to Bifrost/monitoring namespaces and documents that hostname-safe egress requires an FQDN-aware CNI or controlled proxy.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run test/deploy/manifests.test.ts`

Expected: FAIL because manifests do not exist.

- [ ] **Step 3: Add deployment resources**

Reference Secret keys `BIFROST_PROXY_TOKEN` and `METRICS_TOKEN`; do not commit values. Mount `/data`, expose container ports 8080 and 8081, but create a Service port only for 8080. Set `CODEX_HOME=/data/codex` and `DATA_DIR=/data`. Use a startup probe long enough for migrations, child initialization, and account refresh; use liveness only for terminal supervisor failure.

Keep `storageClassName` absent from the base PVC so operators select an encryption-backed default or overlay. State in comments and README that encryption at rest is an installation requirement.

- [ ] **Step 4: Add the Bifrost configuration fixture**

Create this exact provider shape:

```json
{
  "providers": {
    "openai": {
      "keys": [{
        "name": "oauth-proxy",
        "value": "env.OPENAI_PROXY_TOKEN",
        "models": ["*"],
        "weight": 1
      }],
      "network_config": {
        "base_url": "http://openai-oauth-proxy.namespace.svc.cluster.local:8080/v1",
        "allow_private_network": true
      }
    }
  }
}
```

- [ ] **Step 5: Verify rendered manifests**

Run:

```bash
bunx vitest run test/deploy/manifests.test.ts
kubectl kustomize deploy/base >/tmp/openai-oauth-proxy.yaml
kubectl apply --dry-run=client -f /tmp/openai-oauth-proxy.yaml
```

Expected: tests PASS, Kustomize renders, and client dry-run succeeds.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock deploy test/deploy
git commit -m "deploy: add Kubernetes resources"
```

### Task 15: Prove Compatibility, Chaos Behavior, and Release Drift

**Files:**
- Create: `test/compat/openai-client.test.ts`
- Create: `test/compat/bifrost.test.ts`
- Create: `test/compat/agents.test.ts`
- Create: `test/integration/real-app-server.test.ts`
- Create: `test/integration/fake-responses-server.ts`
- Create: `test/chaos/recovery.test.ts`
- Create: `test/live/chatgpt-account.test.ts`
- Create: `test/security/log-leak.test.ts`
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/dependencies.yml`
- Create: `.github/dependabot.yml`
- Create: `README.md`

**Interfaces:**
- Produces: offline deterministic CI with no ChatGPT account
- Produces: opt-in `LIVE_CHATGPT_TESTS=1` suite
- Produces: release gate covering generated protocol, OpenAI client, Bifrost, agent tools, security, and chaos

- [ ] **Step 1: Write OpenAI JavaScript client compatibility tests**

Instantiate `new OpenAI({ apiKey: bifrostToken, baseURL })` against a real listening proxy. Cover model listing, Chat and Responses, streaming/non-streaming, role history, all three image formats, JSON Schema output, resume, branch, cancellation, single/parallel/repeated tools, and stable errors. Assert SDK parsing succeeds without custom response adapters.

- [ ] **Step 2: Add the real App Server offline contract suite**

Start the pinned real binary with a temporary `CODEX_HOME` configured as:

```toml
model_provider = "fixture"

[model_providers.fixture]
name = "Fixture"
base_url = "http://127.0.0.1:19090/v1"
wire_api = "responses"
requires_openai_auth = false
```

Run a deterministic fake Responses server at the test-harness-selected loopback port. Verify initialize, model listing, thread start/resume/fork/delete, raw item injection, text streaming, cancellation, and `item/tool/call`. Assert generated schemas match runtime messages. Keep account/device-login behavior in the fake App Server suite because the fixture provider intentionally bypasses OpenAI auth.

- [ ] **Step 3: Add real Bifrost and agent smoke tests**

Resolve the then-current non-prerelease Bifrost container once, pin its multi-architecture digest in the test fixture, and start it with `deploy/bifrost/config.example.json`. Send provider model names as `openai/gpt-5.4` and verify Bifrost removes the prefix, forwards auth, streaming, errors, rate limits, and function tools.

Run representative OpenCode and Hermes Agent commands/configurations against Bifrost and require at least one client-executed function loop each. Assert no internal Codex tool event occurs. Do not add downstream Codex CLI as a compatibility target.

- [ ] **Step 4: Add chaos and secret-leak tests**

Kill App Server during ordinary output and a pending tool call; assert active request failure, readiness removal, bounded recovery, stored thread resume, and lost continuation semantics. Restart the whole proxy with a copied temporary data directory and assert SQLite and file-based auth state are preserved without reading token contents in the test process.

Capture stdout/stderr across malformed requests and fake upstream errors. Search for request bodies, data URLs, tool payloads, `Authorization`, `access_token`, `refresh_token`, `id_token`, and `auth.json`; require zero matches.

- [ ] **Step 5: Add the opt-in live account suite**

Skip unless `LIVE_CHATGPT_TESTS=1` and a pre-authenticated temporary `CODEX_HOME` path is supplied. Never accept tokens as test parameters. Verify `account/read({ refreshToken: true })`, model listing, one text turn, and one device-login schema contract without logging credentials. Mark the suite serial and document that it consumes subscription capacity.

- [ ] **Step 6: Add CI and dependency workflows**

Make `ci.yml` run on Linux amd64 with Node 26.5.0 and Bun 1.3.14:

```bash
bun install --frozen-lockfile
bun run protocol:check
bun run deps:check
bun run check
kubectl kustomize deploy/base >/tmp/rendered.yaml
kubectl apply --dry-run=client -f /tmp/rendered.yaml
```

Add a separate multi-architecture container build, SBOM generation, and vulnerability scan. Make `dependencies.yml` scheduled and manual: run `npm-check-updates -u`, `bun install`, regenerate schemas, run the complete offline suite, and open a reviewable pull request rather than committing to the default branch. Configure Dependabot for GitHub Actions and container base references only; JavaScript updates remain grouped through `npm-check-updates`.

- [ ] **Step 7: Write operator documentation**

Document supported and rejected API scope, Bifrost setup, Secret creation, encrypted StorageClass requirement, install/upgrade/rollback, `kubectl port-forward pod/openai-oauth-proxy-0 8081:8081`, device login, logout, probes, metrics auth, backups as credentials, FQDN-aware egress requirement/fallback, single-replica downtime, tool continuation loss, live-test opt-in, and Node Current-release risk.

- [ ] **Step 8: Run the complete release gate**

Run:

```bash
bun run protocol:check
bun run deps:check
bun run check
bunx vitest run test/integration test/compat test/chaos test/security
docker buildx build --platform linux/amd64,linux/arm64 --output type=oci,dest=/tmp/openai-oauth-proxy.oci .
kubectl kustomize deploy/base >/tmp/rendered.yaml
kubectl apply --dry-run=client -f /tmp/rendered.yaml
```

Expected: all offline tests PASS; dependency check reports no stable drift; protocol and generated files have no diff; both image platforms build; Kubernetes client dry-run succeeds. The live account suite remains skipped unless explicitly enabled.

- [ ] **Step 9: Commit**

```bash
git add test .github README.md
git commit -m "test: add proxy release gate"
```

## Final Acceptance Checklist

- [ ] Bifrost keeps provider name `openai`, uses the private proxy URL, and has `allow_private_network: true`.
- [ ] Device-code login, automatic refresh, logout, and restart persistence work without proxy access to token values.
- [ ] Models, Chat Completions, and Responses pass streaming and non-streaming official-client tests.
- [ ] Roles, inline PNG/JPEG/WebP, JSON Schema output, stored resume, branching, expiry, and concurrency behave as specified.
- [ ] OpenCode and Hermes Agent complete single, parallel, and repeated client function loops.
- [ ] Every unsupported endpoint/field and every non-allowlisted App Server method fails explicitly.
- [ ] Child crash, pod restart, timeout, disconnect, lost continuation, queue saturation, and auth failure match stable error contracts.
- [ ] Logs contain no prompts, images, tool payloads, auth headers, OAuth tokens, raw App Server events, or credential paths.
- [ ] Container and Kubernetes checks prove non-root, read-only, capability-free, one-replica operation with protected storage.
- [ ] Generated experimental App Server bindings match `@openai/codex` 0.144.1 and dependency drift is zero at release time.
