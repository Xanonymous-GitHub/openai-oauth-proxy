# Task 15 Report: Prove Compatibility, Recovery, And Release Drift

## Status

Complete. Task 15 adds deterministic offline release gates for the official OpenAI JavaScript client, the pinned real Codex App Server, pinned real Bifrost, external agents, restart recovery, secret-free logging, release policy, and operator documentation.

Implementation commit: `b2cc961` (`test: add proxy release gate`).

## Coverage

- The official OpenAI client runs against a listening proxy and covers Models, Chat Completions, Responses, JSON and SSE, role history, PNG/JPEG/WebP inputs, JSON Schema, resume, branch, cancellation, stable errors, and single/parallel/repeated client tools.
- Codex App Server `0.144.1` runs with a temporary fixture-provider `CODEX_HOME` and deterministic fake Responses server. The suite covers initialization, models, thread lifecycle, raw injection, streaming text, interruption, dynamic tools, forwarded tool output, and generated method contracts without ChatGPT credentials.
- Bifrost uses stable multiarch image `maximhq/bifrost:v1.6.3@sha256:95caedb1c368c6d88178c2b98b9238d8a6a62b51d9cb12b6661bf2671ed1aaa4` and the checked-in example configuration. Docker Hub and Buildx both confirmed `linux/amd64` and `linux/arm64` manifests.
- OpenCode and Hermes use deterministic client-side terminal function loops through real Bifrost. CI installs exact versions and sets `REQUIRE_EXTERNAL_AGENTS=1`, so binary absence is a hard failure rather than a silent skip.
- Recovery kills real App Server generations during output and a pending tool call, then checks readiness removal, bounded restart, stored thread resume, lost continuation, two complete proxy starts, copied SQLite state, and opaque credential-file preservation without reading credential contents.
- The live account suite is serial and requires both `LIVE_CHATGPT_TESTS=1` and `LIVE_CHATGPT_CODEX_HOME`; it accepts no token argument and performs account refresh, model listing, a real text turn, and device-login schema validation.
- CI pins Node `26.5.0`, Bun `1.3.14`, immutable action SHAs, frozen installation, protocol/dependency/check/Kubernetes gates, multiarch image build, SBOM generation, and vulnerability scanning. Scheduled dependency updates open pull requests and never commit directly to the default branch.
- README and deployment documentation cover API scope, Bifrost token equality and namespace substitution, install/upgrade/rollback, device login/logout, probes, metrics, backup security, FQDN egress, single-replica downtime, continuation loss, live testing, and Node Current risk.
- Task 11 and Task 14 review minors are closed: rejected admin fetches render a reload state, runtime `checking` serialization is tested, and Bifrost namespace/token instructions are explicit.
- Stable Hono drift was resolved by updating the exact pin and lockfile from `4.12.29` to `4.12.30`.

## RED Evidence

```bash
bun run deps:check
```

Result: exit `1`; `npm-check-updates` reported stable drift from `hono 4.12.29` to `4.12.30`.

```bash
bunx vitest run test/chaos/recovery.test.ts test/integration/real-app-server.test.ts test/compat/bifrost.test.ts test/release/policy.test.ts
```

Result: exit `1`; four assertions failed before implementation for complete proxy restarts, forwarded tool output, checked-in Bifrost configuration use, and mandatory external-agent CI policy.

```bash
bun run check
```

Result: exit `1`; the first full run exposed OpenCode exceeding Vitest's default 10-second timeout under parallel container load. The process-level timeout remained 60 seconds and the test timeout was bounded at 120 seconds.

```bash
bunx vitest run test/compat/bifrost.test.ts
```

Result: exit `1`; the contract had four requests and conflated generic upstream failure with rate limiting. The final fixture separately verifies forwarded `500` and `429` responses.

## GREEN Evidence

```bash
bun run protocol:check
bun run deps:check
bun run check
bunx vitest run test/integration test/compat test/chaos test/security
```

Result: all commands exited `0`. Protocol generation produced no diff, stable dependency drift was zero, Biome checked 83 files, TypeScript and production build passed, the full suite passed `398` tests in 34 files, and the explicit offline release subset passed `17` tests in 7 files.

Two tests were intentionally skipped in the full local run: the opt-in live ChatGPT suite and Hermes, whose external binary is absent. OpenCode `1.17.18` was present and completed its real Bifrost function loop. CI requires both external agents.

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  --output type=oci,dest=/tmp/openai-oauth-proxy.oci .
```

Result: exit `0`; Buildx exported both target manifests in OCI manifest list `sha256:7b56761c1fb5edcc6dfd851184082821e054ff44d25766733c78251ee3bdbc56`.

```bash
kubectl kustomize deploy/base >/tmp/rendered.yaml
kubectl apply --dry-run=client -f /tmp/rendered.yaml
```

Result: exit `0`; the Service, PVC, StatefulSet, and NetworkPolicy all passed client dry-run.

## Graphify

Graphify's code-only AST path analyzed 44 test files and about 38,790 words. It produced 266 nodes, 293 edges, 34 communities, no import cycles, and an estimated 81.2x query-token reduction. The central Task 15 bridges were `runRealAppServerContract()`, `runAgentSmoke()`, `startFakeResponsesServer()`, and `runRecoveryContract()`. Outputs remain ignored under `graphify-out/`.

## Self-Review

- Standards: no documented-standard violation or unresolved code-smell finding remains. Test fixtures stay behind public HTTP/process boundaries and production edits are limited to compatibility and prior-review requirements.
- Spec: every Task 15 step has a corresponding executable gate or operator document. Generic Bifrost errors and rate limits are independently tested after review found the initial conflation.
- Scope: no ChatGPT credential was used, read, logged, or accepted as a command argument. No image, cluster resource, branch, or graph artifact was pushed.

## Concerns

- Hermes Agent is not installed on this machine: neither `hermes` nor `hermes-agent` exists on `PATH`. Its local smoke is explicitly reported skipped; Linux CI installs `hermes-agent==0.15.2` and fails if the binary is still absent.
- The live suite was not run because `LIVE_CHATGPT_TESTS=1` and a preauthenticated `LIVE_CHATGPT_CODEX_HOME` were not supplied. This is intentional and prevents accidental subscription use.
- SBOM generation and high-severity vulnerability scanning are immutable CI gates; the local acceptance command built the multiarch OCI archive but did not duplicate those CI-only scanners.

## Final Reviewer Wave

The final Task 15 review was resolved in one TDD wave:

- The official OpenAI JavaScript client now exercises Chat tool history and four genuine continuation rounds with widths `1, 2, 1, 1`, then repeats the same single/parallel/repeated sequence through Responses. Responses also sends PNG, JPEG, and WebP data URLs with JSON Schema output.
- `max_completion_tokens` and `verbosity` are again strict `unsupported_field` errors because exact output limits and verbosity semantics are not implemented. Streaming Chat accepts only `stream_options: {"include_usage":true}` and now honors it with `usage: null` on ordinary chunks plus a separate empty-choice usage chunk immediately before `[DONE]`; non-streaming, disabled, and unknown stream options are rejected at exact parameter paths.
- Real App Server stdin/stdout JSONL frames are captured and validated with test-only Ajv `8.20.0` against generated experimental client-request, client-notification, server-request, server-notification, and method-specific response schemas. Invalid fixture diagnostics include direction, frame kind, method, schema path, and keyword without captured values. A self-review found and fixed method indexing for client responses to App Server tool requests.
- OpenCode and Hermes share a four-round agent fixture that requires five client tool calls and widths `1, 2, 1, 1`. OpenCode uses a local `chat.params` hook to omit unsupported exact-limit and verbosity fields rather than weakening the proxy contract. Both agents remain mandatory in CI.
- Recovery now observes `stream-before-crash` from a real App Server before killing it, then verifies active failure, readiness loss, and bounded recovery. Two complete proxy child processes run sequentially against original and copied data directories; stored response resume and lost tool continuation are verified only through `/v1/responses` HTTP calls.
- Bifrost asserts exact SDK-observed `500` and `429` status, type, code, and sanitized message. Its pinned manifest is inspected at runtime and must contain both `linux/amd64` and `linux/arm64`.
- The leak gate runs a production proxy child and passes unique raw App Server event and child-stderr sentinels through actual process paths. Combined proxy stdout/stderr contains zero prompt, image, tool, authorization, token, credential-path, raw-event, or child-stderr matches.
- The shared agent proxy listens on `0.0.0.0`, retains `127.0.0.1` as its host URL, exposes `host.docker.internal` to Docker, and asserts all three topology values. The serial opt-in live suite has an explicit 120-second test timeout.

### Reviewer RED Evidence

- Request-schema and official-client tests initially failed because `max_completion_tokens`, `stream_options`, and `verbosity` were accepted and genuine multi-round helper methods did not exist.
- The real App Server test initially had no frame counts or runtime validator, and a later method-specific client-response test proved dynamic tool responses were falling back to generic JSON-RPC validation.
- OpenCode first failed on `max_completion_tokens`, then `stream_options`, then `verbosity`; strict client configuration plus implemented usage-chunk semantics closed each failure without silently discarding fields in the proxy.
- Recovery initially lacked a streamed delta and used same-process SQLite inspection. The new HTTP child-process contract failed until the Node production build, fake App Server completion mode, and copied-response output checks were exercised end to end.
- Bifrost initially exposed only status integers, so exact error objects and registry manifest platforms were absent.
- The first full run caught automatic fake App Server completions perturbing an existing protocol fixture. Autocomplete is now opt-in only for proxy-child contracts, and the previously failing transport test passes with both child-process suites.

### Final GREEN Evidence

```bash
bun run protocol:check
bun run deps:check
bun run check
bunx vitest run test/integration test/compat test/chaos test/security
```

All commands exited `0`. Biome checked 83 files, TypeScript and the production build passed, the complete suite passed `410` tests in 34 files with two intentional skips, and the explicit offline release subset passed `23` tests in 7 files with one Hermes skip.

The real Bifrost contract passed against `maximhq/bifrost:v1.6.3@sha256:95caedb1c368c6d88178c2b98b9238d8a6a62b51d9cb12b6661bf2671ed1aaa4`. A separate multiarch OCI build passed for amd64 and arm64 with manifest list `sha256:281d5c40eba24c2b8dc68813329f540be809db2c8a45d2d2947e26bf861e82f0`. Kubernetes client dry-run passed the Service, PVC, StatefulSet, and NetworkPolicy.

Graphify's final code-only pass analyzed 44 test files and about 41,200 words, producing 278 nodes, 313 edges, 34 communities, no import cycles, and an estimated 86.0x query-token reduction. The leading cross-community bridges are `runRealAppServerContract()`, `runRecoveryContract()`, `runAgentSmoke()`, and `startFakeResponsesServer()`.

Residual constraints are unchanged: Hermes is unavailable locally but mandatory in Linux CI; the live ChatGPT suite was not opted in; SBOM and vulnerability scanning remain immutable CI-only gates. No credential, image, cluster resource, graph artifact, branch, or commit was pushed.

## Final Matrix And Cleanup Wave

Task 15 implementation lineage:

- `b2cc961` (`test: add proxy release gate`) added the initial release contracts.
- `3b08735` (`test: harden proxy release gate`) closed the first final-review gaps for multi-round clients, runtime protocol schemas, process recovery, Bifrost errors, manifest platforms, process-log sentinels, Docker topology, and live timeout.
- `14483f1` (`test: close Task 15 release gaps`) added the exhaustive official-SDK matrix, upstream-failure log sentinels, shutdown-inclusive log capture, and failure-safe chaos child cleanup.

The official OpenAI listener gate is now data-driven across every documented supported Chat and Responses concept. Each supported concept has an independent typed SDK request. Twenty-six distinct rejected branches use a cast only at the invalid SDK call boundary and assert exact HTTP `400` status, stable `unsupported_field` or `invalid_request` code, and parameter path. Focused SDK verification passed `57` tests.

The production process-log fixture now rejects `turn/start` with unique credential, filesystem-path, header, and upstream-body sentinels. The failure traverses App Server JSON-RPC, proxy error handling, and production request logging. The fixture terminates and awaits the proxy child before taking its combined stdout/stderr snapshot, so shutdown output is included; all request, event, child-stderr, and upstream-failure sentinel matches remain zero.

Both sequential chaos proxy children are held by the outer `finally`. Startup failures terminate their child before escaping, and outer cleanup attempts both child closures even if one fails. An induced intermediate failure captures the first child PID and verifies `ESRCH` after `runRecoveryContract()` rejects.

Final verification:

```bash
bun run protocol:check
bun run deps:check
bun run check
bunx vitest run test/integration test/compat test/chaos test/security
```

All commands exited `0`. Biome checked 83 files, TypeScript and the production build passed, the complete suite passed `459` tests in 34 files with two intentional skips, and the explicit offline release subset passed `72` tests in 7 files with one Hermes skip.

The final standalone multiarch OCI build passed for amd64 and arm64 with manifest list `sha256:0370d88c7f8261cb0bcf64e1a9f9c9758499f6d98ef978870dea7164145bd9ea`. Kubernetes client dry-run again passed the Service, PVC, StatefulSet, and NetworkPolicy.

Graphify's refreshed code-only pass analyzed 44 test files and about 43,057 words, producing 286 nodes, 324 edges, 34 communities, no import cycles, and an estimated 90.1x query-token reduction. `ListeningProxyFixture`, `runRealAppServerContract()`, `runRecoveryContract()`, `runAgentSmoke()`, and `startFakeResponsesServer()` remain the principal release-contract bridges.

Residual constraints remain explicit: Hermes is unavailable locally but mandatory in Linux CI; the live ChatGPT suite was not opted in; SBOM and vulnerability scanning remain immutable CI-only gates. No push was performed.
