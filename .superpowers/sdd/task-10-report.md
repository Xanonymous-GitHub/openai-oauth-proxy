# Task 10 Report: Bridge Client-Executed Function Tools

## Status

Implemented Chat Completions and Responses function-tool suspension and continuation on one live Codex turn.

## TDD Evidence

- RED: `bunx vitest run test/tools/bridge.test.ts` failed because `src/tools/bridge.ts` did not exist.
- RED: `bunx vitest run test/turns/runner.test.ts` failed because dynamic tools were absent from `thread/start` and `TurnRunner.tools` did not exist.
- RED: Chat tool-loop tests failed with the former `unsupported_tool_semantics` boundary.
- RED: Responses suspension tests failed with the former `unsupported_tool_semantics` boundary.
- GREEN: focused bridge, runner, Chat, and Responses suites pass after implementation.

## Implementation

- Added one host-scoped `ToolBridge` consumer for `CodexHost.toolCalls()` with generation/thread/turn routing.
- Added opaque generation-bound external call IDs, deterministic tool fingerprints, exact continuation matching, all-or-nothing fan-in, sanitized failed results, expiry, and lost tombstones.
- Replaced request-owned turn iteration with a staged central accumulator. HTTP and SSE projections can end at `tool_calls` while the original turn, subscription, responder closures, and completion remain live.
- Passed exact dynamic function specs only to `thread/start`; `tool_choice: none` passes no dynamic tools.
- Added Chat non-streaming and streaming function-call projections and in-memory call-ID continuation.
- Added Responses non-streaming and streaming function-call projections, durable pending mappings, tool-lease promotion, no-branch takeover, and final completion of the original response operation.
- Added timeout, restart, unknown, partial, duplicate, parallel, repeated-loop, stream, cleanup, and definition-validation coverage.

## Verification

- Focused: `bunx vitest run test/tools test/turns/runner.test.ts test/openai/chat.test.ts test/openai/responses.test.ts`
- Full: `bun run test`
- Typecheck: `bun run typecheck`
- Build: `bun run build`
- Biome: `bunx biome check src test`
- Protocol: `bun run protocol:check`
- Graph: `graphify update .`

## Notes

- `graphify-out/` remains untracked and is intentionally excluded from the Task 10 commit.
- Full-repository `bunx biome check .` also scans untracked Graphify cache JSON and reports formatting diagnostics there; source and test trees are clean.

## Final GREEN Evidence

- Focused: `bunx vitest run test/tools test/turns/runner.test.ts test/openai/chat.test.ts test/openai/responses.test.ts` exited 0 with 4 test files passed and 99 tests passed.
- Full: `bun run test` exited 0 with 15 test files passed and 280 tests passed.
- Typecheck: `bun run typecheck` ran `tsc -p tsconfig.json --noEmit` and exited 0 with no diagnostics.
- Build: `bun run build` ran `tsc -p tsconfig.build.json` and exited 0 with no diagnostics.
- Biome: `bunx biome check src test .superpowers/sdd/task-10-report.md` exited 0 with 39 files checked and no fixes required.
- Protocol: `bun run protocol:check` regenerated experimental TypeScript and JSON Schema protocol files, then `git diff --exit-code -- src/codex/generated` exited 0.
- Graphify: `graphify update .` rebuilt the code graph with 17,428 nodes, 20,188 edges, and 1,235 communities. HTML generation was intentionally skipped because the graph exceeded the 5,000-node visualization limit.
- Commit: `5f455943a174287716482fc035e2b0ab6aa85b66` (`feat: bridge client function tools`).

## Self-Review

- Single central consumers: `HostEventDispatcher` remains the sole `CodexHost.events()` consumer, and the host-scoped `ToolBridge` is the sole `CodexHost.toolCalls()` consumer. Tool requests route by generation, thread, and turn instead of creating per-request iterators.
- Accumulator lifecycle: `TurnRunner` owns one staged accumulator for the original upstream turn. Suspension completes only the current HTTP/SSE stage; the subscription, responder closures, turn, and next-stage completion remain alive until terminal completion or invalidation.
- All-or-none fan-in: continuation rejects duplicate and unknown IDs, reports missing IDs without resolving any responder, prepares the next accumulator stage before responding, and submits results only when the supplied ID set exactly equals the outstanding set.
- Lease retention and release: Responses suspension writes a durable pending mapping and promotes the operation lease to the configured tool timeout. Completion, loss, timeout, and abandonment release the operation lease, including leases created for new threads.
- Chat cleanup: disposable Chat threads and release callbacks remain retained across suspension, then run once after final output, cancellation, timeout, generation loss, or lifecycle failure.
- Responses durable pending state: suspended Responses remain durable as `pending`; only matching `function_call_output` input can take over the in-memory turn. Ordinary continuation cannot branch from pending state, restart loss becomes durable `lost`, and final output completes the original response mapping.
- Repeated loops: `resume()` creates the next accumulator stage before App Server responders resolve, allowing parallel and repeated function-call rounds to remain on the same thread and turn without another `turnStart`.
- Timer and listener cleanup: suspension detaches the completed HTTP request signal and replaces the turn timeout with the tool-expiry timer. Continuation reattaches its request signal and turn timeout. Terminal completion and invalidation clear timers, listeners, bridge registrations, call maps, and subscriptions.
- Generation tombstones: external IDs encode only the generation and random opaque bytes, never App Server request or call IDs. Invalidated Chat call IDs and Responses IDs retain bounded tombstones so late continuations return stable lost semantics; old-generation IDs are also recognized directly from their prefix.
- Stream suspension versus disconnect: intentional `tool_calls` completion closes the projection normally after detaching its request signal, so it does not trigger disconnect interruption. Actual stream write failures or disconnects invalidate pending tool turns and run cancellation cleanup.
- Redaction: failed client tool results send `success: false` with only `Tool execution failed`; App Server and internal call IDs, responder errors, stack traces, and sensitive upstream text are not projected to clients.
- Scope and secrets: the commit contains only Task 10 source, tests, and this report. `graphify-out/` remains untracked, no generated graph was committed, no push occurred, and no credentials, tokens, environment files, or other secrets were added.

## Important Findings Remediation

### RED Evidence

- Definition fidelity: focused bridge and Responses tests failed before the fix because endpoint definitions had no `fingerprintDefinitions` API and the lossy `DynamicToolSpec[]` fingerprint treated a Responses `strict` change as equivalent.
- Durable-loss cleanup: the Responses regression timed out waiting for `turnInterrupt` when `deleteThread` rejected, demonstrating that fallible cleanup ran before cancellation.
- Responses continuation streaming: initial, mid-item, final, cleanup-rejection, and abort regressions left repeated parallel calls pending and could emit terminal output after transport failure.
- Chat continuation streaming: mixed text followed by repeated parallel calls survived a preceding text write failure or abort because call IDs were recorded only as their tool-call chunks were written.

### GREEN Evidence

- Focused: `bunx vitest run test/tools test/turns/runner.test.ts test/openai/chat.test.ts test/openai/responses.test.ts` exited 0 with 4 test files and 109 tests passed.
- Full: `bun run test` exited 0 with 15 test files and 290 tests passed.
- Protocol: `bun run protocol:check` regenerated the experimental TypeScript and JSON Schema protocol files and exited 0 with no generated diff.
- Typecheck: `bun run typecheck` ran `tsc -p tsconfig.json --noEmit` and exited 0 with no diagnostics.
- Build: `bun run build` ran `tsc -p tsconfig.build.json` and exited 0 with no diagnostics.
- Biome: `bunx biome check src test .superpowers/sdd/task-10-report.md` exited 0 with 39 files checked and no fixes required before this evidence append; it is rerun on the final report below.
- Final Biome: `bunx biome check src test .superpowers/sdd/task-10-report.md` exited 0 with 39 files checked and no fixes required after this evidence append.
- Graphify: `graphify update .` exited 0 and rebuilt 17,430 nodes, 20,191 edges, and 1,242 communities. The installed skill emitted a non-blocking version warning, and HTML generation was skipped because the graph exceeded the 5,000-node visualization limit.

### Remediation Self-Review

- Definition fidelity: handlers validate parsed endpoint definitions, then fingerprint those definitions directly. Canonicalization sorts object keys without reordering arrays, retains every accepted field including Responses `strict`, and ignores only absent `undefined` properties.
- Cancellation ordering: tool invalidation requests cancellation synchronously before awaiting durable-loss cleanup. Operation directories are removed in `finally`, and a cleanup rejection cannot replace the primary continuation or stream failure.
- Responses repeated loops: the continuation result and all repeated calls exist before streaming begins. Abort and every SSE write failure invalidate the response, reject all outstanding responders, interrupt the turn, release the lease, avoid `response.completed`, and attempt cleanup independently.
- Chat repeated loops: every repeated call ID is captured before the role or mixed-text chunks are written. Abort and write failure invalidate the complete call set, interrupt and clean up the retained turn, release it once, and avoid `[DONE]`.
- Architecture and scope: the host-scoped bridge remains the sole `CodexHost.toolCalls()` consumer and `TurnRunner` retains the original staged accumulator. Changes are limited to Task 10 source, regressions, and this report; `graphify-out/` remains excluded.

### Remediation Hash

- Parent Task 10 commit: `5f455943a174287716482fc035e2b0ab6aa85b66` (`feat: bridge client function tools`).
- Remediation source commit: `8edc0a9cc8e559f709cc079d12391c132e877568` (`fix: harden tool continuation failures`).
