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

## Release Queue Integrity

Date: 2026-07-13

### Scope

- Added workflow-level `queue: max` to the static `release-images` concurrency group.
- Retained `cancel-in-progress: false`, allowing GitHub Actions to queue up to 100 pending tag releases in FIFO order without cancelling an active release.
- Extended release policy coverage to require both queueing and non-cancellation.

### RED Evidence

- Focused release policy failed because the global release concurrency block had no `queue: max` declaration.

### GREEN Evidence

- Focused release policy: 4 tests passed.
- `bun run check`: 490 tests passed, 2 policy skips; Biome, TypeScript, tests, and build passed.
- `bun run protocol:check`: passed with no generated protocol drift.
- `bun run deps:check`: all dependencies match current stable package versions.

### Files

- Workflow: `.github/workflows/release.yml`.
- Policy: `test/release/policy.test.ts`.

## Final Release Integrity Finding

Date: 2026-07-13

### Scope

Closed the final release-integrity finding only:

- Removed the unapproved mutable `latest` alias.
- Serialized every tag release through one repository-wide concurrency group with cancellation disabled.
- Added authenticated, fail-closed pre-build probes for both immutable final tags: version and source SHA.
- Preserved digest-only candidate publication, pre-tag SBOM scanning and signing, exact dual-tag creation, and post-tag digest/platform/attestation/signature verification.
- Documented that releases publish only immutable version and source SHA tags.

### RED Evidence

- Focused release policy initially failed because concurrency was version-scoped, no source-SHA preflight probe existed, `latest` was created and verified, and operator documentation did not define the immutable two-tag contract.

### GREEN Evidence

- Focused release policy: 4 tests passed.
- Policy coverage now asserts static cross-release concurrency with `cancel-in-progress: false`, authentication before both probes, both probes before candidate build, fail-closed manifest-unknown handling and existing-tag rejection for each final tag, scan before dual tagging, no `latest`, exact digest equality for both tags, amd64/arm64 platforms, attestations, and keyless signature verification.
- `bun run check`: 490 tests passed, 2 policy skips; Biome, TypeScript, tests, and build passed.
- `bun run protocol:check`: passed with no generated protocol drift.
- `bun run deps:check`: all dependencies match current stable package versions.
- Graphify deterministic non-generated TypeScript corpus: 76 files, 887 nodes, 1,761 edges, 50 communities; average query reduction 5.7x.

### Files

- Workflow: `.github/workflows/release.yml`.
- Policy: `test/release/policy.test.ts`.
- Operator contract: `deploy/README.md`.

### Residual Constraint

- GHCR's live missing-manifest diagnostic, OIDC signature, dual-tag publication, and rerun rejection remain unexercised until a real tag-triggered GitHub Actions release runs; any non-`manifest unknown` probe failure blocks publication by design.
- Full-root Graphify detected 1,106 files, mostly generated protocol bindings, beyond its 200-file limit. The completed graph intentionally covers non-generated TypeScript source and tests; semantic extraction was unavailable because this harness has no subagent tool.

## Re-review Important Findings

Date: 2026-07-13

### Scope

Closed all three re-review Important findings:

1. Replaced bounded aborted-response tombstones with the monotonic issued-ID range invariant.
2. Made the resumed Responses stream handler the independent owner of durable operation, lease, cleanup, and continuation-admission settlement.
3. Reordered release publication around authenticated fail-closed probing, digest-only build publication, pre-tag scanning, signing, final tagging, and post-tag verification.

### RED Evidence

- Transport regressions failed because a second late response protocol-failed unrelated pending work and the source still retained the 256-entry tombstone collection.
- The 1,001-abort regression proved the old eviction boundary could not safely classify all previously issued IDs without retained history.
- Four resumed Responses tests timed out service drain after `response.output_text.done`, `response.completed`, consumer-abort, and iterator-terminal failures because ToolBridge had already removed the response context before handler cleanup.
- A stalled `ToolBridge.invalidateResponse()` regression timed out independently, proving durable settlement still depended on bridge cleanup returning.
- Repeated-tool failure tests observed continuation admission completion twice before the original lifecycle finish callback became idempotent.
- Release policy ordering failed because GHCR authentication followed the existence probe and final tags preceded SBOM generation and vulnerability scanning.

### GREEN Evidence

- Focused transport, Responses, and release policy run: 102 tests passed.
- The transport now accepts only nonnegative safe-integer response IDs, discards any nonpending ID below the monotonic next-issued boundary, protocol-fails malformed and future IDs, resets its issued range on generation invalidation, and retains no response-history collection.
- The 1,001-abort regression delivers every late response, completes unrelated pending work, then confirms a future ID still protocol-fails and the implementation contains no tombstone storage.
- Resumed stream settlement preserves durable success after a `response.completed` write failure, loses pre-commit operations at `response.output_text.done`, consumer abort, or iterator termination, records failed deletion for reconciliation, releases the lease, and finishes admission once even when bridge invalidation never settles.
- Release policy tests enforce authentication -> existence probe -> digest build -> SBOM/scan -> final tags -> verification, explicit manifest-unknown handling, digest-only candidate publication, immutable action pins, attestation checks, and keyless signature verification.
- `bun run protocol:check`: passed with no generated protocol drift.
- `bun run deps:check`: all dependencies match current stable package versions.
- `bun run check`: 490 tests passed, 2 policy skips; Biome, TypeScript, tests, and build passed.
- Offline integration, compatibility, chaos, security, and release subset: 87 tests passed, 1 Hermes binary skip.
- Multiarchitecture OCI build passed for `linux/amd64` and `linux/arm64`; manifest list `sha256:4372f5c6c50829f570394006caf027a4f0921848e8de17e7eab342eace465003` includes both platform manifests and attestations.
- `kubectl kustomize deploy/base | kubectl apply --dry-run=client -f -`: Service, PVC, StatefulSet, and NetworkPolicy accepted.
- Graphify deterministic non-generated TypeScript corpus: 76 files, 887 nodes, 1,761 edges, 50 communities; average query reduction 5.7x.

### Files

- Runtime: `src/codex/transport.ts`, `src/openai/responses.ts`.
- Release: `.github/workflows/release.yml`.
- Regressions: `test/codex/transport.test.ts`, `test/openai/responses.test.ts`, `test/release/policy.test.ts`.

### Residual Constraints

- The release workflow is statically policy-tested and locally multiarchitecture-built, but GHCR tag probing, OIDC keyless signing, publication, and rerun behavior require a real tag-triggered GitHub Actions run for end-to-end confirmation.
- The fail-closed GHCR probe intentionally allows only the registry's explicit `manifest unknown` diagnostic; any changed registry diagnostic blocks publication rather than risking overwrite.
- Live ChatGPT account tests remain opt-in and were not run. Hermes Agent remains skipped locally because its external binary is unavailable; CI requires it.
