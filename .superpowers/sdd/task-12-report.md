# Task 12 Report: Capacity, Limits, Observability, And Drain

## Status

Complete. Task 12 adds one global turn-capacity gate shared by Chat and Responses, streaming encoded-body enforcement, authenticated Prometheus metrics, whitelisted JSON logs, stable request IDs, and bounded graceful shutdown.

## Files

- Added `src/operations/capacity.ts` for four-active/32-waiter FIFO admission, cancellation, idempotent permits, drain rejection, idle waiting, and forced invalidation.
- Added `src/operations/metrics.ts` for bounded request, latency, stable-error, capacity, lease, tool, restart, and authentication series with Prometheus label escaping.
- Added `src/operations/log.ts` for a compile-time and runtime field whitelist that excludes request bodies, credentials, tool payloads, and raw events.
- Modified `src/http/limits.ts` to validate `Content-Length` strictly and parse JSON through one counting stream that cancels above 32 MiB.
- Modified `src/app.ts` to assign stable request IDs, enforce separate data/metrics bearer tokens, expose `/metrics`, reject new turn admission while draining, and preserve admitted tool continuations.
- Modified `src/main.ts` to compose one shared capacity/metrics/logger instance, add admin request correlation, and perform idempotent bounded drain ordering.
- Modified `src/openai/chat.ts` and `src/openai/responses.ts` so parsing, strict validation, image/tool validation, and exact model checks precede capacity acquisition, while permits precede thread/lease/reservation work.
- Modified `src/turns/runner.ts` and `src/tools/bridge.ts` to interrupt all active turns, invalidate all pending tools, expose operational counts, and settle lifecycle release/cleanup before shutdown continues.
- Modified `src/conversations/store.ts` to expose the current active thread-lease count for the busy-thread gauge.
- Added `test/operations/` coverage and focused regressions in the existing app, Chat, store, bridge, model, and runner suites.

## RED Evidence

- Initial operations suite failed because `capacity.ts`, `metrics.ts`, `log.ts`, and `readJsonBody` did not exist.
- Admission integration failed because handlers ignored capacity, parsed bodies with `Request.json()`, `/metrics` returned `404`, responses lacked generated request IDs, and drain did not reject model admission.
- Forced-drain tests failed because active permits had no invalidation API, `TurnRunner` had no global interrupt hook, and `start().close()` did not begin capacity drain synchronously.
- Review regressions failed because generated request IDs were not visible to downstream response reservations, a rejecting source cancellation masked the required `413`, and global drain middleware blocked already-permitted tool continuations.
- Live observability tests failed because busy leases, pending/expired tools, and process-generation changes were rendered but not connected to runtime producers.

## GREEN Evidence

- Focused operations/app suite passes with body-limit, admission-ordering, metrics, logging, request-ID, capacity, and drain coverage.
- Full Vitest suite passes, including Chat/Responses tool continuation and forced runner interruption coverage.
- `bun run protocol:check` exits `0` with no generated protocol diff.
- `bun run typecheck` exits `0` with no diagnostics.
- `bun run build` exits `0`.
- `bunx biome check src test .superpowers/sdd/task-12-report.md` exits `0` with no fixes required.
- `graphify update .` completes locally; graph output remains untracked and is not committed or published.

## Architecture Review

### Capacity And Continuations

- `start()` creates one `TurnCapacity` and passes that same instance to both endpoint handlers.
- Authentication happens in Hono middleware. Handlers then parse JSON, validate strict schemas and tools/images, and resolve exact model capabilities before acquiring.
- Initial Chat turns acquire before `thread/start`. Initial Responses turns acquire before operation-directory creation, reservation, thread lease, resume, fork, or start.
- Suspended client-tool turns retain the original permit and lease. Continuation HTTP requests validate and model-check but do not acquire a second permit.
- Drain rejects queued waiters and all new acquisitions while allowing an already-permitted continuation to finish during the grace period.

### Body Limits

- Decimal, signed, duplicated, unsafe, and negative `Content-Length` values fail before a reader is acquired.
- Declared and chunked bodies share the exact 32 MiB encoded limit.
- The counting stream cancels the source on the first over-limit chunk and preserves `request_too_large` even if source cancellation rejects.
- `Response.json()` consumes the counted stream directly, avoiding a second application-owned body buffer.

### Observability And Redaction

- Data and admin responses receive a validated caller request ID or one generated `req_<uuid>` value. The same generated value is visible to downstream lease/reservation code and response headers.
- `/metrics` accepts only the metrics bearer. No prompt, model ID, request/response/thread ID, tool name, or payload becomes a metric label.
- Prometheus output escapes backslashes, quotes, and line feeds and ends with a newline.
- Logger output is reconstructed field-by-field from `LogEvent`; extra runtime properties are dropped and cannot leak bodies, authorization headers, OAuth-shaped values, tool arguments/results, or raw events.
- Existing error projection continues to replace unknown/upstream messages with fixed public text.

### Drain Ordering

- `close()` synchronously marks the process draining, removes readiness/admission, rejects queued work, removes signal listeners, and returns one stable promise.
- Active and suspended turns receive up to 30 seconds to finish.
- At the deadline, pending tools are invalidated, active turns receive internal abort signals and App Server interrupts, lifecycle cleanup settles, and residual permits are invalidated idempotently.
- The response sweeper stops before SQLite closes; then the App Server supervisor stops; data/admin listeners close last.

## Self-Review

- Standards: no documented-standard violation or unresolved baseline smell found. Duplicate request-ID policy is limited to the two separate listener compositions and keeps admin internals independent from the data app.
- Spec: no missing, incorrect, or scope-expanding behavior found after the continuation-drain and live-metric follow-ups.
- Scope: Task 11 review minors were not touched because their files were outside the required Task 12 changes.
- Secrets: no credentials, tokens, environment files, databases, generated protocol changes, or graph artifacts are included.

## Concerns

- No blocking implementation concern remains.
- App Server restart counts are observed when `/metrics` sees a higher process generation; multiple unseen generations are reconstructed, but no sample is emitted until the first scrape establishes a baseline.
- Graphify reports the existing non-blocking version warning: installed skill `0.4.3`, package `0.9.4`.
