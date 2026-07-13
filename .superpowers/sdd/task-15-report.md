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
