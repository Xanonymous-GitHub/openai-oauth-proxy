# OpenAI OAuth Proxy

Single-user, single-replica OpenAI-compatible proxy backed by a ChatGPT-authenticated Codex App Server. Bifrost keeps its built-in `openai` provider and sends requests to this service; the proxy never receives OAuth token values.

## Supported API

- `GET /v1/models`: visible Codex Models.
- `POST /v1/chat/completions`: streaming and non-streaming Chat Completions, system/developer/user/assistant history, inline PNG/JPEG/WebP data URLs, JSON Schema output, reasoning effort, and client function tools.
- `POST /v1/responses`: streaming and non-streaming Responses, stored resume/branch behavior, inline images, JSON Schema output, reasoning effort and summaries, cancellation, and single/parallel/repeated client function tools.
- `/healthz`, `/readyz`, and bearer-protected `/metrics` operational endpoints.

Unknown fields and unsupported endpoints fail explicitly. Embeddings, audio, file APIs, remote image URLs, hosted tools, internal Codex tools, multi-user isolation, and a downstream Codex CLI are non-goals. `max_completion_tokens`, `max_output_tokens`, Responses `text.verbosity`, `include: ["reasoning.encrypted_content"]`, and `prompt_cache_key` are validated but intentionally ignored compatibility fields because Codex App Server does not expose equivalent per-turn controls and this proxy keeps continuation and cache state server-side; clients must not rely on them for cost, latency, truncation, `finish_reason: "length"`, output verbosity, encrypted reasoning replay, or cache-key partitioning. Streaming Chat honors `stream_options.include_usage`: `true` emits the required separate usage chunk and `false` suppresses usage; authoritative usage remains App Server-provided.

## Run Locally With Docker Compose

The bearer tokens are required; the service exits at startup without them rather than accepting unauthenticated requests. Install `direnv`, then create a local, untracked `.envrc` and set independent values generated with `openssl rand -hex 32`:

```sh
cp .envrc.example .envrc
# Edit .envrc and set both token values.
direnv allow

docker compose up --build --detach
```

Direnv loads the tokens while the repository directory is active; `compose.yml` consumes them without storing secrets in Compose configuration. Compose persists `/data`, binds ports 8080 and 8081 to host loopback only, and exposes the admin listener through that loopback binding. Do not change the admin port binding to a non-loopback address. Verify `http://127.0.0.1:8080/healthz`, then open `http://127.0.0.1:8081` to complete device login. Until login succeeds, model requests return `authentication_required`. Stop the local service with `docker compose down`.

## Bifrost

Use pinned multiarch Bifrost `maximhq/bifrost:v1.6.3@sha256:95caedb1c368c6d88178c2b98b9238d8a6a62b51d9cb12b6661bf2671ed1aaa4`. Start from `deploy/bifrost/config.example.json`, replace the example `namespace` in its service FQDN, and keep `allow_private_network: true`.

The Bifrost environment variable `OPENAI_PROXY_TOKEN` must equal the proxy Secret value `BIFROST_PROXY_TOKEN`. Clients send models as `openai/gpt-5.4`; Bifrost removes the provider prefix. The upstream `base_url` is the proxy origin without `/v1`, because Bifrost appends the incoming `/v1/*` path.

## Install

1. Choose the target namespace and replace the example `namespace` in Bifrost configuration and any namespace selectors or overlays.
2. Ensure the default StorageClass is an encrypted StorageClass, or set an encryption-backed `storageClassName` in an overlay.
3. Create Secret `openai-oauth-proxy` with independent random `BIFROST_PROXY_TOKEN` and `METRICS_TOKEN` values of at least 32 characters. Set Bifrost `OPENAI_PROXY_TOKEN` to the same value as `BIFROST_PROXY_TOKEN`.
4. Create a Kustomize overlay that replaces the base's intentionally non-pullable example image with a published `repository@sha256` manifest digest, apply the overlay, and wait for `pod/openai-oauth-proxy-0` readiness.
5. Open the loopback-only admin service with `kubectl port-forward pod/openai-oauth-proxy-0 8081:8081`, visit `http://127.0.0.1:8081`, and complete device login.

The admin service can be exposed to a trusted private network as an explicit opt-in. Set `ADMIN_HOST=0.0.0.0` and `ADMIN_ORIGIN` to its exact HTTPS origin, such as `https://openai-proxy-admin.example.ts.net`. Keep the Service private, restrict access with network identity policy, and configure only one origin. Loopback access remains allowed.

The example Secret is intentionally invalid and excluded from Kustomize. Never commit rendered Secrets.

## Operations

- Upgrade: publish and inspect an amd64/arm64 image, replace the immutable overlay digest, validate the rendered Kustomize overlay, then apply it.
- Codex 0.144.1 continuation limitation: `dynamicTools` are set only by `thread/start`; `thread/resume` and `thread/fork` cannot replace them. A stored Responses continuation must therefore send the exact inherited effective function definitions and `tool_choice`. Adding, removing, changing, or switching to/from `none` is rejected before App Server work. New response lineages may define a new configuration.
- Rollback: restore the previous immutable image digest and apply it. Database migrations must remain compatible with the restored release.
- Logout: use the loopback admin page. Device login, refresh, and logout are delegated to App Server; the proxy does not parse credential files.
- Probes: `/healthz` reports terminal supervisor health; `/readyz` additionally requires App Server and account readiness and is removed during drain/recovery.
- Metrics: scrape `/metrics` on port 8080 with `Authorization: Bearer <METRICS_TOKEN>` from the allowed monitoring workload.
- Backups: treat PVC backups as credentials. Stop or quiesce the pod, take an encrypted snapshot of `/data`, restrict restore access, and test restore procedures.
- Egress: plain NetworkPolicy cannot select hostnames. Replace broad TCP 443 fallback with an FQDN-aware CNI policy or controlled HTTPS egress proxy where destination enforcement is required.
- Availability: one single replica means upgrades, pod replacement, node loss, and restart recovery cause downtime. Pending tool continuation is intentionally lost across App Server or proxy restart and returns `proxy_continuation_lost`; completed stored threads remain resumable.

## Verification

The offline gate uses Node 26.5.0, Bun 1.3.14, Codex 0.144.1, the official OpenAI JavaScript client, a real fixture-provider App Server, real pinned Bifrost when Docker is available, and representative OpenCode/Hermes clients. External agent tests are explicitly skipped only when the corresponding binary is absent; CI installs pinned OpenCode 1.17.18 and Hermes Agent 0.15.2 so both are required there.

Run `bun install --frozen-lockfile`, `bun run protocol:check`, `bun run deps:check`, and `bun run check`. Docker and Kubernetes release checks must be reported as passed or unavailable, never conflated.

Live ChatGPT tests are serial, consume subscription capacity, and run only when both `LIVE_CHATGPT_TESTS=1` and `LIVE_CHATGPT_CODEX_HOME=/path/to/pre-authenticated-temporary-home` are set. They accept no token parameters and must not run in ordinary CI.

## Security And Support

Logs contain request metadata only: no prompts, images, tool payloads, authorization headers, raw App Server events, token fields, or credential paths. Keep the admin port loopback-only, maintain separate proxy/metrics tokens, preserve non-root/read-only/capability-free container settings, and report security issues privately to the repository owner rather than attaching credentials or backups to an issue.

Node 26 is a Node Current release, not LTS. Exact pinning makes drift visible but increases upgrade cadence and ecosystem risk; review scheduled dependency pull requests and image scans before release. Supported incidents should include release SHA, stable error code, sanitized request ID, probe state, and process generation, never request content or credentials.
