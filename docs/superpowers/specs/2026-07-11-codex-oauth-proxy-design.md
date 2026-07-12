# Codex OAuth Proxy Design

Date: 2026-07-11
Status: Approved for implementation planning

## Summary

Build a single-user Kubernetes proxy that lets Bifrost keep using its built-in `openai` provider while routing supported requests through a ChatGPT-authenticated Codex App Server.

Bifrost sees an OpenAI-shaped HTTP interface at a custom `base_url`. It does not know about Codex threads, OAuth tokens, or App Server JSON-RPC. The proxy supports model listing, Chat Completions, Responses, text input/output, inline image input, streaming, response continuity, and client-executed function tools.

The proxy does not provide the complete OpenAI Platform API. ChatGPT subscription authentication is product-specific and does not authorize Platform Images, Videos, Files, Audio, Embeddings, Moderation, Batch, Fine-tuning, Vector Stores, or other Platform resources.

## Goals

- Let Bifrost configure its built-in provider name as `openai` with the proxy as its base URL.
- Authenticate one ChatGPT account through the official Codex device-code flow.
- Let Codex own access-token refresh and credential persistence.
- Keep authentication valid across pod restarts on a persistent volume.
- Support OpenAI-shaped model listing, Chat Completions, and Responses requests.
- Support non-streaming and SSE streaming responses.
- Preserve message roles instead of flattening history into one prompt.
- Support inline image data URLs.
- Support OpenCode, Hermes Agent, and similar client-side function tools through App Server dynamic tools.
- Prevent Codex from executing shell, filesystem-write, network, web, app, plugin, skill, MCP, or multi-agent tools inside the proxy pod.
- Reject unsupported fields and endpoints explicitly rather than silently ignoring them.
- Use current stable dependencies and detect dependency drift with `npm-check-updates`.

## Non-goals

- Complete OpenAI Platform API compatibility.
- Direct access to `api.openai.com` or fallback to a Platform API key.
- Private or reverse-engineered ChatGPT backend endpoints.
- Multiple ChatGPT accounts, account rotation, or load balancing.
- Multiple active proxy replicas.
- Remote HTTP image fetching or Platform file IDs.
- Codex internal tool execution.
- Guaranteed compatibility when Codex CLI itself is used as a downstream client. Codex CLI sends Codex-specific non-function tool variants that version 1 rejects.
- Audio or Realtime compatibility.
- A public admin UI or Kubernetes Ingress.

## Upstream Findings

### Codex TypeScript SDK

`@openai/codex-sdk` is not the correct integration module for this proxy. It exposes coding-focused thread operations and starts `codex exec --experimental-json` as a child process for each turn. It does not expose login, account, token, or refresh operations. It also does not expose the App Server dynamic-tool callback needed for native client tools.

The proxy will not depend on `@openai/codex-sdk`.

### Codex App Server

The proxy will run a pinned, tested stable `@openai/codex` release, initially `0.144.1`, and spawn one long-lived `codex app-server` child process over stdio. App Server is the official product-integration interface for:

- device-code ChatGPT login;
- account state and logout;
- automatic token refresh;
- model listing;
- thread start, resume, fork, interrupt, and deletion;
- raw Responses-item history injection;
- turn and item streaming;
- experimental dynamic tools.

The stdio transport is used because App Server WebSocket transport is documented as experimental and unsupported.

### Product Boundary

ChatGPT subscription billing and OpenAI Platform API billing are separate. Codex can consume ChatGPT subscription entitlements for Codex workflows, but that does not turn its OAuth tokens into general Platform API credentials.

## System Topology

```text
Bifrost built-in OpenAI provider                  Administrator browser
base_url = proxy /v1                             through kubectl port-forward
             |                                               |
             v                                               v
+--------------------------- Hono HTTP module ---------------------------+
| bearer auth | limits | IDs | OpenAI routes | admin routes | probes    |
+----------------------+-------------------------------+----------------+
                       |                               |
                       v                               v
+-------------- OpenAI compatibility module ---+  +--- Admin module ----+
| validation | translation | SSE | errors       |  | login/status/logout |
+----------------------+-------------------------+  +----------+----------+
                       |                                       |
                       v                                       |
+---------------- Conversation module -----------------+       |
| response mapping | lineage | leases | seven-day TTL  |       |
+----------------------+-------------------------------+       |
                       |                                       |
                       v                                       |
+---------------- Tool bridge module ------------------+       |
| dynamic tools | pending calls | suspend/resume       |       |
+----------------------+-------------------------------+       |
                       |                                       |
                       +---------------------------------------+
                                       |
                                       v
+---------------------------- Codex host module -------------------------+
| child lifecycle | generated protocol | RPC correlation | event routing |
+--------------------------------------+---------------------------------+
                                       |
                                       v
                         codex app-server over stdio
                                       |
                          managed ChatGPT OAuth and refresh
                                       |
                                       v
                            ChatGPT Codex service
```

## Module Interfaces

### Hono HTTP Module

Responsibilities:

- listen on the data and admin ports;
- authenticate the data plane;
- enforce body, image, concurrency, queue, and timeout limits;
- assign request IDs;
- route validated requests;
- expose health, readiness, and metrics;
- perform graceful shutdown.

It does not know OAuth token structure or App Server event details.

### OpenAI Compatibility Module

Responsibilities:

- parse supported OpenAI request shapes with Zod;
- reject unknown or unsupported fields;
- convert supported Chat and Responses inputs into internal turn commands;
- preserve role history through raw Responses items;
- convert App Server events into Chat JSON/SSE or Responses JSON/SSE;
- produce OpenAI-shaped errors.

Its interface uses proxy-owned request, result, stream-event, and error types. App Server wire types do not leak through this seam.

### Conversation Module

Responsibilities:

- create opaque proxy response IDs;
- map response IDs to Codex thread and turn IDs;
- record parent response IDs and branch lineage;
- acquire one active lease per persisted thread;
- decide whether to start, resume, or fork;
- expire mappings and delete corresponding Codex threads without recursively deleting live descendant branches.

The implementation uses built-in `node:sqlite` on the persistent volume.

### Tool Bridge Module

Responsibilities:

- translate OpenAI function definitions into App Server `dynamicTools`;
- correlate `item/tool/call` requests with external call IDs;
- emit OpenAI tool calls without executing them;
- suspend an App Server turn until the client submits all outstanding tool results;
- retain exclusive ownership of the thread lease while a tool continuation is pending;
- validate and return tool results to App Server;
- expire pending calls and invalidate them on App Server restart.

This module is the only intentionally experimental App Server seam.

### Codex Host Module

Responsibilities:

- spawn and monitor one `codex app-server` child process;
- complete the initialize/initialized handshake;
- correlate RPC requests, responses, server requests, and notifications;
- expose account, model, thread, turn, item, and dynamic-tool operations through a small internal interface;
- enforce an explicit allowlist of App Server methods and server requests;
- restart App Server after a crash;
- fail all in-flight operations when process identity changes.

Generated TypeScript and JSON schemas from the pinned Codex binary define its wire contract.

The host does not expose a generic `send(method, params)` interface. Its outgoing RPC allowlist is limited to initialization, account login/read/logout, model listing, and the thread/turn methods required by this design. `thread/list` is exposed only as a narrow typed operation for internal crash reconciliation; no HTTP field or client-selected value can invoke it. The only accepted App Server request is `item/tool/call`. Unexpected approval, process, command, filesystem, shell, or other server requests are denied and treated as redacted protocol violations. No HTTP field can select an App Server method.

### Admin Module

Responsibilities:

- start device-code login;
- display verification URL, one-time code, and completion status;
- read account state;
- request token refresh through `account/read`;
- log out.

It never reads, parses, displays, or returns `auth.json`.

## HTTP Interface

### Data Plane

The data plane listens on `0.0.0.0:8080`. Route authentication is explicit:

- `/v1/*` requires `Authorization: Bearer <BIFROST_PROXY_TOKEN>`;
- `/metrics` requires `Authorization: Bearer <METRICS_TOKEN>`;
- `/healthz` and `/readyz` are unauthenticated and return only minimal status.

Supported routes:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /healthz`
- `GET /readyz`
- `GET /metrics`, protected by a separate monitoring bearer token

Every other `/v1/*` path returns an OpenAI-shaped unsupported-endpoint error.

### Admin Plane

The admin plane binds to `127.0.0.1:8081`. It has no Service or Ingress and is reached with:

```bash
kubectl port-forward pod/openai-oauth-proxy-0 8081:8081
```

The browser UI uses same-origin requests, a `SameSite=Strict` session cookie, Origin validation, and a per-session CSRF token. Kubernetes port-forward permission is the administrator authentication boundary.

Admin operations:

- account status;
- start device login;
- poll login completion;
- force an account refresh check;
- logout.

## Model Listing

`GET /v1/models` calls or reads a short-lived cache of App Server `model/list`.

The response:

- exposes only non-hidden models;
- preserves App Server model IDs exactly;
- exposes only models with text input support;
- records image input support internally for validation;
- never invents aliases for Platform-only model IDs.

Bifrost clients continue selecting models as `openai/<model-id>`. Bifrost removes its provider prefix before sending the upstream request.

## Chat Completions Contract

Supported request concepts:

- `model`;
- `messages` with `system`, `developer`, `user`, `assistant`, and `tool` roles;
- text content;
- user image parts containing inline `data:` URLs;
- `stream`;
- function-only `tools`;
- `tool_choice` values `auto` and `none`;
- omitted or `true` `parallel_tool_calls`;
- supported reasoning-effort values;
- JSON Schema structured output when supplied as `response_format.type = "json_schema"`.

Unsupported examples include sampling controls, log probabilities, audio output, remote image URLs, file IDs, built-in Platform tools, forced tool selection, and exact output-token limits. These fields produce `invalid_request_error`; they are not ignored.

### Stateless Chat Lifecycle

For an ordinary Chat request:

1. Start a disposable Codex thread.
2. Inject all complete history before the final user message as raw Responses items.
3. Start a turn with the final text and inline image input.
4. Translate output events.
5. Delete the thread after completion, failure, cancellation, or timeout.

Starting a disposable thread does not start a new OS process or OAuth session. The long-lived App Server remains warm.

### Chat Tool Lifecycle

When the model requests client tools:

1. App Server sends one or more `item/tool/call` requests.
2. The proxy assigns external call IDs and emits an OpenAI tool-call response.
3. The HTTP response ends while the App Server turn remains suspended.
4. The next Chat request must contain results for every outstanding call ID.
5. The proxy resolves the pending App Server requests instead of creating a new thread.
6. The existing turn continues and either returns final output or another set of tool calls.
7. The disposable thread is deleted after final output.

Partial result sets and unknown call IDs are rejected.

## Responses Contract

Supported request concepts:

- `model`;
- text and structured message `input`;
- inline image data URLs;
- `instructions`;
- `stream`;
- `previous_response_id`;
- `store`;
- function-only `tools`;
- `tool_choice` values `auto` and `none`;
- supported reasoning effort;
- JSON Schema text formatting.

Background mode, Conversations resources, remote files, Platform built-in tools, audio, exact output-token limits, and unsupported include/metadata controls are rejected.

### Response Continuity

- No `previous_response_id`: create a new Codex thread.
- Latest response ID: acquire its thread lease and resume the thread.
- Older response ID in the same lineage: fork the Codex thread at the recorded turn and continue on the new branch.
- Unknown or expired response ID: return `404` with `response_not_found`.
- Concurrent continuation of one thread: return retryable `409` with `thread_busy`.

When `store` is omitted or `true`, mappings and Codex history use a seven-day sliding expiry. When `store=false`, the thread is deleted after a final result and its response ID cannot be resumed. Requests that combine `store=false` with function tools are rejected because a tool result requires resumable suspended-turn state.

Tool calls use the same suspended-turn bridge as Chat Completions.

A Responses result containing pending function calls may be used only to submit results for those calls. It cannot be used as a branch point until the suspended turn completes. The pending-tool lease remains exclusive across the two HTTP requests; matching tool results take over that lease, while unrelated continuation attempts receive `thread_busy`. Timeout interrupts the turn and releases the lease.

## Image Input

Version 1 accepts only inline data URLs with these media types:

- `image/png`
- `image/jpeg`
- `image/webp`

Limits:

- 32 MiB maximum encoded HTTP request body;
- 10 MiB maximum decoded size per image;
- 24 MiB maximum aggregate decoded image size;
- eight images maximum per request.

The proxy verifies that decoded file signatures match the declared media type before passing the documented inline data URL to App Server. Remote HTTP(S) URLs, local client paths, file IDs, SVG, GIF, audio, and video are rejected.

## Streaming

### Chat Completions

App Server agent-message deltas become `chat.completion.chunk` SSE events. Dynamic-tool events become tool-call deltas. The stream terminates with the appropriate finish reason and `[DONE]`.

### Responses

App Server lifecycle and delta events become the corresponding supported Responses streaming events. Internal command, file, reasoning-detail, or disabled-tool events are never exposed.

### Cancellation

Client disconnect or abort calls `turn/interrupt`, releases leases, and cleans up disposable threads. Stored Responses retain the last completed response but do not record a successful response for an interrupted turn.

Usage fields are emitted only when App Server supplies authoritative token data. The proxy does not estimate usage.

## Tool Bridge Invariants

- Only function tools are accepted.
- Tool names and JSON Schemas must satisfy both OpenAI and App Server constraints.
- Codex internal tools remain disabled regardless of client tool definitions.
- The proxy never executes a client tool.
- All outstanding parallel calls must be answered together.
- A suspended turn retains its thread lease until completion, interruption, timeout, or App Server restart.
- Pending calls expire after 15 minutes.
- A Codex Host process restart invalidates all pending calls.
- A continuation after restart returns retryable `409` with `proxy_continuation_lost`.
- The Codex package version is pinned because dynamic tools are experimental.

## Instruction Policy

Codex's default coding-agent instructions are replaced with a minimal neutral adapter baseline. Caller `system` and `developer` messages remain authoritative within normal model instruction precedence.

The neutral baseline states only that:

- the model must respond through supplied text or client function tools;
- internal tools are unavailable;
- it must not assume a repository or local coding workspace;
- it must follow the requested output format.

The proxy does not add a persona or task-specific behavior.

## Strict Validation and Errors

Unknown fields and known unsupported fields are rejected. No field is silently discarded.

Error shape:

```json
{
  "error": {
    "message": "Human-readable message",
    "type": "invalid_request_error",
    "param": "field.name",
    "code": "stable_proxy_code"
  }
}
```

Status mapping:

- `400`: malformed or unsupported request field;
- `401`: missing or invalid Bifrost proxy bearer token;
- `404`: unsupported route, unknown model, or expired response;
- `409`: busy thread, incomplete tool continuation, or lost continuation;
- `429`: bounded queue full, proxy concurrency limit, or upstream rate limit;
- `502`: App Server protocol failure or invalid upstream response;
- `503`: ChatGPT authentication required, App Server unavailable, or pod draining;
- `504`: turn timeout.

Upstream messages are sanitized before inclusion. OAuth responses, raw tokens, authorization headers, and credential paths never appear in errors.

## Authentication Lifecycle

### Device Login

1. Administrator opens the port-forwarded admin page.
2. Proxy calls `account/login/start` with ChatGPT device-code mode.
3. UI displays the official verification URL and one-time code.
4. Administrator completes login in the browser.
5. App Server emits login completion and persists credentials.
6. Proxy calls `account/read` and becomes ready only for a ChatGPT account.

Codex device-code login is documented as beta. The generated schema and a login contract test must pass for every pinned Codex upgrade; the admin UI does not assume an expiry field unless that pinned schema supplies one.

### Startup

1. Open and migrate SQLite transactionally.
2. Spawn App Server.
3. Complete protocol initialization.
4. Call `account/read` with forced refresh checking.
5. Return ready only when ChatGPT authentication is usable.

### Refresh and Logout

App Server refreshes credentials during normal use. The proxy never implements OAuth refresh itself. Logout is delegated to App Server and immediately removes readiness.

## Persistence

One ReadWriteOnce PVC from an operator-supplied encryption-backed StorageClass is mounted at `/data`.

Layout:

- `/data/codex/`: `CODEX_HOME`, `auth.json`, config, sessions, and Codex state;
- `/data/proxy.sqlite`: response mappings, lineage, expiry, and diagnostic metadata.

Permissions:

- `/data/codex`: `0700`;
- credential files: `0600`;
- application runs as a dedicated non-root UID/GID.

Codex configuration includes:

- `cli_auth_credentials_store = "file"`;
- `forced_login_method = "chatgpt"`;
- neutral model instructions;
- disabled internal capabilities.

PVC snapshots and backups are treated as credentials because they contain refresh tokens and transcripts.

## Concurrency and Capacity

Defaults:

- four active Codex turns globally;
- bounded waiting queue of 32 requests;
- one active lease per persisted Responses thread;
- 15-minute pending tool timeout;
- 10-minute ordinary turn timeout;
- seven-day stored-response idle expiry.

The values are environment-configurable but bounded at startup. Invalid values fail configuration validation.

When a stored mapping expires, cleanup marks it unavailable immediately. Because App Server `thread/delete` recursively deletes descendant threads, physical deletion is branch-aware: leaf threads are deleted first, and an ancestor thread is deleted only after every descendant mapping has expired. An expired ancestor may therefore remain physically stored until its last live descendant expires.

## App Server Hardening

Codex configuration disables:

- shell tool;
- unified exec;
- multi-agent tools;
- apps and connectors;
- remote plugins;
- hooks;
- memories;
- web search;
- MCP servers;
- capability roots;
- network access for sandboxed tools.

No skill roots or skill items are installed or passed to App Server. Every thread uses read-only sandboxing and approval policy `never`. Each new or forked Responses operation uses a persisted unique empty working directory so startup recovery can correlate an otherwise unrecorded thread through recovery-only `thread/list`; zero or multiple exact matches are retained for retry and never guessed. Operation directories are removed after final completion or orphan cleanup. Tool capability configuration and the Codex Host RPC allowlist are verified at startup and by integration tests. Enabling `experimentalApi` for dynamic tools does not make any other experimental RPC reachable through the host interface.

## Container and Kubernetes Security

- One-replica StatefulSet.
- ReadWriteOnce PVC whose StorageClass provides encryption at rest.
- ClusterIP Service exposes only port 8080.
- Admin port 8081 has no Service or Ingress.
- Non-root container.
- Read-only root filesystem.
- All Linux capabilities dropped.
- `seccompProfile.type = RuntimeDefault`.
- No service-account token mount.
- Bounded writable temporary volume.
- Bifrost shared bearer and metrics bearer come from Kubernetes Secrets.
- NetworkPolicy allows data-plane ingress from Bifrost and metrics ingress from monitoring only.
- Production requires either an FQDN-aware CNI policy or a controlled egress proxy for required OpenAI HTTPS destinations. Plain Kubernetes NetworkPolicy cannot enforce hostname allowlists; if neither facility exists, the documented fallback is broader TCP 443 egress plus the App Server sandbox and RPC allowlist.

Application sandboxing remains required even with NetworkPolicy because the App Server process itself needs OpenAI egress.

## Health and Recovery

### Health

`/healthz` reflects the Node host and its child supervisor. It remains successful while the supervisor performs bounded App Server recovery, preventing the Kubernetes liveness probe from fighting that recovery loop.

An unexpected child failure starts a recovery budget of five attempts. A recovery attempt fails if the child cannot spawn, does not initialize within 30 seconds, or exits before remaining initialized for 10 minutes. Attempts start after delays of 1, 2, 4, 8, and 16 seconds plus up to 25 percent jitter. Remaining initialized for 10 minutes resets the budget. Exhausting all five attempts puts the supervisor in a terminal unhealthy state: `/healthz` returns `500`, `/readyz` remains unsuccessful, and Kubernetes restarts the pod.

### Readiness

`/readyz` succeeds only when:

- App Server is initialized;
- a ChatGPT account is authenticated;
- refresh checking succeeds;
- the proxy is not draining.

### App Server Crash

- readiness is removed immediately;
- active requests fail;
- pending tool continuations are invalidated;
- App Server restarts with exponential backoff and jitter;
- persisted Responses threads may resume after reinitialization;
- disposable Chat threads are abandoned and cleaned up.

### Refresh Failure

The pod remains alive but unready. Data-plane requests return `503 authentication_required`; the admin plane remains available for device login.

## Observability

Structured JSON logs include:

- request ID;
- route;
- model;
- HTTP status;
- duration;
- stream completion or cancellation;
- queue and lease outcome;
- redacted internal correlation IDs;
- App Server process generation and restart reason.

Normal logs exclude:

- prompts and message bodies;
- image data;
- tool arguments and results;
- authorization headers;
- access, refresh, and ID tokens;
- raw App Server events;
- raw upstream error bodies.

Metrics include request counts and latency, errors by stable code, active turns, queue depth, busy threads, pending and expired tools, App Server restarts, and auth readiness.

## Technology Baseline

Verified on 2026-07-11:

- Node.js 26.5.0 Current;
- Hono 4.12.29;
- `@hono/node-server` 2.0.8;
- Zod 4.4.3;
- `@openai/codex` 0.144.1;
- TypeScript 7.0.2;
- Biome 2.5.3;
- Vitest 4.1.10;
- `@types/node` 26.1.1;
- Bun 1.3.14 for package management and task orchestration;
- `npm-check-updates` 22.2.9.

Node 26 is a Current release, not LTS. This is an explicit project choice despite Node's production recommendation to use LTS.

Vite, an ORM, Redis, and a frontend framework are not required. The small admin page is served directly by Hono.

Production and integration tests execute on Node 26. Bun is not the production runtime.

## Dependency Freshness

- Commit `bun.lock` for reproducible builds.
- Use stable package releases, not alpha, beta, canary, or nightly tags.
- Run `bunx npm-check-updates --errorLevel 2` in CI.
- Run a scheduled dependency update that executes `npm-check-updates -u`, installs with Bun, regenerates Codex schemas, and runs the complete test suite.
- Check Node, Bun, and container base versions separately because `npm-check-updates` only checks package dependencies.
- Pin runtime container versions and immutable image digests.
- Never float `@openai/codex` at pod startup.

## Generated Protocol Policy

For the pinned Codex binary:

```bash
codex app-server generate-ts --experimental --out src/generated/codex
codex app-server generate-json-schema --experimental --out src/generated/codex
```

The `--experimental` flag is required because `dynamicTools` is omitted from stable-only generated bindings. Generated artifacts are committed. CI regenerates them and fails on a diff. Every Codex upgrade must pass protocol fixture, translation, tool bridge, Bifrost, and client smoke tests before updating the lockfile.

## Test Strategy

### Unit Tests

- configuration validation;
- bearer authentication;
- request limits;
- Chat and Responses Zod schemas;
- role and raw-item translation;
- inline image decoding and limits;
- SSE encoding;
- error mapping and redaction;
- response IDs, lineage, expiry, leases, and branching decisions;
- tool-call correlation, fan-in, timeout, and restart invalidation.

### App Server Contract Tests

- initialize handshake;
- account status and device-login messages;
- model listing;
- thread start, resume, fork, interrupt, and delete;
- raw history injection;
- turn and item streaming;
- dynamic tool request/response;
- child crash and protocol-generation invalidation;
- rejection of every generated outgoing method outside the host allowlist and every incoming server request other than `item/tool/call` before handler dispatch.

Tests use the generated schema and a deterministic fake App Server. A separate integration suite configures the real pinned App Server with a loopback `fixture` model provider using `wire_api = "responses"`, `requires_openai_auth = false`, and a test-harness-selected local base URL. A deterministic fake Responses server then verifies outbound requests, SSE handling, thread operations, history injection, cancellation, and dynamic-tool callbacks without a real account. Account/device-login behavior uses the fake App Server plus the opt-in live-account suite.

### OpenAI Client Compatibility Tests

Use the official OpenAI JavaScript client against the proxy for:

- model listing;
- Chat and Responses;
- streaming and non-streaming;
- role history;
- inline images;
- structured output;
- single and parallel tool calls;
- repeated tool loops;
- disconnect cancellation;
- stored response resume and branch.

### Bifrost Tests

Run a real Bifrost instance with its built-in `openai` provider configured with the proxy base URL. Verify model routing, non-streaming, streaming, errors, rate limiting, and tool calls.

### Agent Client Smoke Tests

Verify representative OpenCode and Hermes Agent requests complete at least one real client-executed tool loop without enabling internal Codex tools.

### Security and Chaos Tests

- attempt unsupported Codex tool execution;
- verify no write or network capability reaches child tools;
- kill App Server during normal output and during a pending tool call;
- restart the pod with valid OAuth state;
- invalidate authentication;
- saturate active turns and queue;
- inspect logs for secret or body leakage.

A live ChatGPT-account suite is opt-in because it consumes subscription capacity and cannot run in untrusted CI.

## Kubernetes Delivery

- Multi-stage image: Bun builder, Node 26 runtime.
- Multi-architecture builds for Linux amd64 and arm64.
- One-replica StatefulSet with graceful termination.
- Startup, liveness, and auth-aware readiness probes.
- ClusterIP data-plane Service.
- Secret and NetworkPolicy manifests.
- Immutable image digest deployment.
- SBOM generation and vulnerability scanning.
- Additive, transactional SQLite migrations so the immediately previous image remains rollback-compatible.

## Bifrost Configuration Shape

```json
{
  "providers": {
    "openai": {
      "keys": [
        {
          "name": "oauth-proxy",
          "value": "env.OPENAI_PROXY_TOKEN",
          "models": ["*"],
          "weight": 1
        }
      ],
      "network_config": {
        "base_url": "http://openai-oauth-proxy.namespace.svc.cluster.local:8080/v1",
        "allow_private_network": true
      }
    }
  }
}
```

`OPENAI_PROXY_TOKEN` authenticates Bifrost to this proxy. It is not an OpenAI credential.

## Acceptance Criteria

- Bifrost uses provider name `openai` unchanged and sends requests to the proxy base URL.
- Device-code login completes through the port-forwarded admin page.
- OAuth credentials survive pod restart and refresh without proxy token handling.
- `/v1/models` exposes the usable Codex model catalog.
- Chat and Responses work in streaming and non-streaming modes.
- Structured role history is preserved.
- Inline PNG, JPEG, and WebP inputs work within documented limits.
- Stored Responses resume, branch, expire, and reject concurrent turns correctly.
- OpenCode and Hermes Agent complete client-side tool loops through the dynamic-tool bridge.
- Codex internal tools cannot execute.
- Unsupported endpoints and fields fail explicitly with OpenAI-shaped errors.
- Disconnects interrupt upstream turns.
- Logs contain no prompts, image data, tool payloads, authorization headers, or OAuth tokens.
- Pod readiness reflects App Server and ChatGPT account usability.
- App Server crash recovery and lost-tool-continuation behavior match this design.
- `npm-check-updates` reports no stable dependency drift at release time.
- Generated App Server schemas match the pinned Codex binary.
- Unit, protocol, OpenAI-client, Bifrost, agent smoke, security, and chaos suites pass.

## Principal Risks

### Experimental Dynamic Tools

Native client tool compatibility depends on an experimental App Server interface. Pinning Codex, committing generated schemas, and running end-to-end tool tests reduce but do not remove upgrade risk.

### Device-code Login Maturity

Codex documents headless device-code authentication as beta. A Codex upgrade can require admin-flow changes even when normal authenticated turns remain compatible.

### Semantic Compatibility

Codex App Server remains an agent-oriented interface, not the OpenAI Platform API. Even with neutral instructions and raw-item injection, some sampling, tool-choice, event, and error semantics cannot be identical. Strict rejection prevents silent behavioral drift.

OpenCode and Hermes Agent function-tool flows are explicit compatibility targets. A downstream Codex CLI is not: it can send Codex-specific tool variants outside the function-only contract.

### Subscription Limits

ChatGPT plan limits and Codex model availability can change independently of the proxy. The proxy exposes upstream rate limits rather than attempting account rotation.

### Single Replica

The single-writer design avoids refresh-token and thread-state races but has restart downtime. Kubernetes restarts the pod; active calls and pending tools are not highly available.

### Node Current Release

Node 26 is not LTS at design time. Frequent runtime updates and compatibility testing are required until it enters LTS.

## Sources

- Codex TypeScript SDK: <https://github.com/openai/codex/tree/main/sdk/typescript>
- Codex App Server: <https://developers.openai.com/codex/app-server>
- Codex authentication: <https://developers.openai.com/codex/auth>
- Codex configuration reference: <https://developers.openai.com/codex/config-file/config-reference>
- Bifrost custom providers: <https://github.com/maximhq/bifrost/blob/dev/docs/providers/custom-providers.mdx>
- Bifrost provider configuration: <https://github.com/maximhq/bifrost/blob/dev/docs/quickstart/gateway/provider-configuration.mdx>
- Node release status: <https://nodejs.org/en/about/previous-releases>
- ChatGPT/API billing separation: <https://help.openai.com/en/articles/8156019-how-can-i-move-my-chatgpt-subscription-to-the-api>
