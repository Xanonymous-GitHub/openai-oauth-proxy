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
