# Final Review Fix Report

Date: 2026-07-13
Branch: `feature/codex-oauth-proxy`
Implementation commit: `a67dd98`
Report commit: this commit

## Scope

Closed final-review items 1 through 7 only:

1. Bounded one-response transport tombstones for aborted RPC IDs.
2. Exact dynamic-tool declaration allowlisting before external call IDs.
3. Additively persisted Responses lineage tool configuration for the Codex 0.144.1 continuation limitation.
4. Live streaming from resumed tool-turn accumulators for Chat and Responses.
5. Abortable, deadline-bound response sweeping and bounded service shutdown.
6. Non-pullable Kubernetes base image plus immutable multiarchitecture GHCR release workflow.
7. Canonical Bifrost origin-only `base_url` in design, plan, examples, and tests.

## RED Evidence

- `test/codex/transport.test.ts`, `test/tools/bridge.test.ts`, and `test/turns/runner.test.ts`: 4 expected failures proved that an aborted late response protocol-failed unrelated work, undeclared tools were accepted, and resumed stages exposed no event iterable.
- `test/conversations/store.test.ts`, `test/openai/responses.test.ts`, `test/deploy/manifests.test.ts`, and `test/release/policy.test.ts`: 10 expected failures proved missing migration columns, completed-lineage tool mismatch acceptance, unbounded sweeper stop, unpublished GHCR base reference, absent release workflow, and stale design/plan URLs.
- Route timing tests withheld final turn completion and observed that the old continuation paths could not forward the first resumed delta.

## GREEN Evidence

- Focused continuation/streaming run: 107 tests passed across Chat, Responses, and TurnRunner.
- Focused App Server/shutdown run: 12 tests passed, including real Codex 0.144.1 inherited dynamic tools and never-settling sweep closure.
- `bun run protocol:check`: passed with no generated protocol drift.
- `bun run deps:check`: all dependencies match current stable package versions.
- `bun run check`: 480 tests passed, 2 policy skips; Biome, TypeScript, tests, and build passed.
- `bunx vitest run test/integration test/compat test/chaos test/security`: 83 tests passed, 1 Hermes binary skip.
- `docker buildx build --platform linux/amd64,linux/arm64 --output type=oci,...`: passed; manifest list `sha256:0e426e303125288aad1e271e2dd9ad35c8927354f4b6b4b683d0710beeab870f` contains both builds.
- `kubectl kustomize deploy/base` and `kubectl apply --dry-run=client`: Service, PVC, StatefulSet, and NetworkPolicy accepted.
- Graphify deterministic non-generated TypeScript corpus: 76 files, 885 nodes, 1,752 edges, 53 communities; average query reduction 5.6x.

## Files

- Transport/tool runtime: `src/codex/transport.ts`, `src/tools/bridge.ts`, `src/turns/runner.ts`.
- Persistence/continuation: `src/conversations/migrations.ts`, `src/conversations/store.ts`, `src/openai/chat.ts`, `src/openai/responses.ts`.
- Shutdown: `src/main.ts`, `src/openai/responses.ts`.
- Release/deployment: `.github/workflows/release.yml`, `deploy/base/statefulset.yaml`, `deploy/README.md`, `README.md`.
- Approved artifacts: `docs/superpowers/specs/2026-07-11-codex-oauth-proxy-design.md`, `docs/superpowers/plans/2026-07-11-codex-oauth-proxy.md`.
- Regression coverage: `test/app.test.ts`, `test/codex/transport.test.ts`, `test/conversations/store.test.ts`, `test/deploy/manifests.test.ts`, `test/integration/**`, `test/openai/chat.test.ts`, `test/openai/responses.test.ts`, `test/operations/**`, `test/release/policy.test.ts`, `test/tools/bridge.test.ts`, `test/turns/runner.test.ts`.

## Self-Review

- Verified transport tombstones consume one late response only, evict oldest at 256 entries, preserve concurrent unrelated requests, and clear on generation invalidation.
- Verified tool rejection occurs before random external ID allocation and returns only the sanitized protocol error.
- Verified tool configuration is immutable per completed lineage, checked before model lookup/lease/upstream work, and rechecked transactionally during reservation.
- Verified migration 5 is additive and old no-tool rows receive the canonical default configuration and matching fingerprint.
- Verified resumed stages preserve existing suspension, abort, error, lease, cleanup, and repeated-tool-loop behavior while forwarding events live.
- Verified sweep abort leaves cleanup records intact for retry and service close reaches store, supervisor, and listeners.
- Removed a duplicate Responses continuation cleanup path found during diff review.
- Verified no unrelated linked-worktree changes were staged. GitButler was not used for mutation because it resolved the main workspace and exposed unrelated `.pi` changes outside this worktree.

## Residual Constraints

- Codex 0.144.1 cannot replace `dynamicTools` on `thread/resume` or `thread/fork`; continuation configuration changes intentionally return `tool_definitions_changed`.
- The Kubernetes base is intentionally non-runnable until an operator supplies a published `repository@sha256` image replacement through a Kustomize overlay.
- The tag release workflow was validated statically and by local multiarchitecture build, but no tag was pushed and GHCR publication was not executed.
- Live ChatGPT account tests remain opt-in and were not run. Hermes Agent remains skipped locally because its external binary is unavailable; CI requires it.
- Full-root Graphify detected 1,106 files, mostly generated protocol bindings, beyond its 200-file limit. The completed graph intentionally covers non-generated TypeScript source and tests; semantic extraction was unavailable because this harness has no subagent tool.
