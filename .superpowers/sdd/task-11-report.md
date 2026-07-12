# Task 11 Report: Device Authentication And Loopback Admin Plane

## Status

Complete. Task 11 adds ChatGPT device authentication, account-aware data-plane readiness, and a secured loopback admin plane. The follow-up remediation derives the exact admin Origin allowlist from the configured loopback listener port, including non-default ports while preserving the default `8081` behavior.

## Files

- Added `src/codex/account.ts` for sanitized account state, readiness, device login, cancellation, refresh, logout, generation transitions, and auth-operation race control.
- Added `src/admin/sessions.ts` for opaque in-memory sessions and CSRF tokens with 30-minute idle expiry, rotation, pruning, and constant-time token comparison.
- Added `src/admin/page.ts` for the framework-free static HTML and same-origin JavaScript application.
- Added `src/admin/app.ts` for admin routing, exact Origin checks, CSRF/content-type enforcement, CSP, and sanitized API responses.
- Modified `src/turns/events.ts` to add a narrow account-notification subscription to the existing central `HostEventDispatcher`.
- Modified `src/app.ts` to require bearer authentication before supervisor/account readiness on `/v1/*` and compose account readiness into `/readyz`.
- Modified `src/main.ts` to compose `AccountManager`, sessions, the actual admin application, and listener-port-derived loopback origins.
- Added `test/codex/account.test.ts` and `test/admin/app.test.ts` for lifecycle, race, redaction, session, CSRF, Origin, CSP, and admin API coverage.
- Modified `test/app.test.ts` for data readiness, listener separation, and real non-default-port Origin security/function coverage.
- Modified OpenAI endpoint fixtures to declare account readiness explicitly.
- Added this `.superpowers/sdd/task-11-report.md` handoff.

## RED Evidence

- Initial focused command: `bunx vitest run test/admin test/codex/account.test.ts test/app.test.ts` failed because `src/admin/app.ts` and `src/codex/account.ts` did not exist; the data app also returned `200` where account-unready `/v1/models` required sanitized `503 authentication_required`.
- Admin-listener composition: `bunx vitest run test/app.test.ts -t "serves the admin app"` failed with `expected 404 to be 200` because the admin listener served an empty Hono application.
- Generation deduplication: `bunx vitest run test/codex/account.test.ts -t "re-reads a new generation"` failed because three readiness checks launched four total account reads instead of one startup read plus one replacement-generation read.
- Auth-operation sequencing: `bunx vitest run test/codex/account.test.ts -t "pending account read|delayed login"` failed twice because a pending forced read overwrote `login_pending` and a delayed login response overwrote logout state.
- Non-default listener remediation: `bunx vitest run test/app.test.ts -t "serves the admin app"` failed with `expected 200 to be 403`; a listener on a non-`8081` port still accepted stale Origin `http://127.0.0.1:8081`.

## GREEN Evidence

- Non-default-port regression: `bunx vitest run test/app.test.ts -t "serves the admin app"` exited 0 with 1 test passed and 6 skipped. It rejects stale port `8081` and host `0.0.0.0`, then accepts only `127.0.0.1` and `localhost` on the configured listener port.
- Focused: `bunx vitest run test/admin test/codex/account.test.ts test/app.test.ts` exited 0 with 3 files and 33 tests passed.
- Full: `bun run test` exited 0 with 17 files and 318 tests passed.
- Protocol: `bun run protocol:check` regenerated experimental TypeScript and JSON Schema files and exited 0 with no generated diff.
- Typecheck: `bun run typecheck` ran `tsc -p tsconfig.json --noEmit` and exited 0 with no diagnostics.
- Build: `bun run build` ran `tsc -p tsconfig.build.json` and exited 0.
- Biome: `bunx biome check src test` exited 0 with 45 files checked and no fixes required.
- Final Biome: `bunx biome check src test .superpowers/sdd/task-11-report.md` exited 0 with 45 files checked and no fixes required.
- Graphify: final `graphify update .` exited 0 and rebuilt 17,497 nodes, 20,338 edges, and 1,237 communities. HTML visualization was automatically skipped because the graph exceeds 5,000 nodes.

## Commits

- Task 11 implementation: `f45e6414f04260b5126d4759aa68590339b3aa57` (`feat: add device login admin`).
- Listener-Origin remediation: `b95f5895db9f5ddf5955f0b1e6c5c774a5413442` (`fix: bind admin origins to listener`).

## Self-Review

### Single Event Consumer

- `HostEventDispatcher.consume()` remains the only iterator over `CodexHost.events()`. `AccountManager` uses `subscribeAccount()` on that dispatcher and never starts a competing iterator.
- The global subscription is deliberately narrow: only `account/updated` and `account/login/completed` notifications are delivered to account listeners. Turn events retain their existing generation/thread/turn routing.

### Generation And Authentication Races

- Startup and generation changes call `accountRead(true)`. Reads are sequence- and generation-bound, stale results and stale notifications are ignored, and repeated readiness checks do not duplicate a generation read.
- Login completion is correlated to the active `loginId`. Pending account reads cannot overwrite login state, delayed login responses cannot outlive logout, and logout removes readiness before awaiting App Server completion.
- API-key, Amazon Bedrock, null, failed reads, and failed login all remain unready. Only `account.type === "chatgpt"` becomes ready.

### Readiness And Liveness

- `/v1/*` authenticates the bearer token first, then requires both supervisor and account readiness. Unready requests receive sanitized `503 authentication_required`.
- `/readyz` composes supervisor and account readiness. `/healthz`, the static admin page, session bootstrap, and sanitized admin error state remain available while authentication or App Server startup fails.

### Session, CSRF, Origin, And CSP

- Session IDs and CSRF tokens each use 32 random bytes, remain memory-only, expire after 30 minutes idle, and are pruned during access. Unknown cookies are replaced and privilege-changing login/logout operations rotate sessions to prevent fixation.
- Cookies are `HttpOnly; SameSite=Strict; Path=/`. Mutations require exact JSON content type, an existing session, a matching CSRF token, and an exact configured Origin.
- Allowed origins are derived only from `config.adminPort` and the fixed hostnames `127.0.0.1` and `localhost`. Request `Host`/`Origin` values never expand the allowlist; alternate hosts, stale ports, suffixes, and missing origins remain rejected. Default configuration still resolves to port `8081`.
- No CORS middleware or allow-origin response is present. The page uses a same-origin external script, `textContent` for dynamic values, and CSP `default-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`.

### Token Redaction

- Public account state contains only status, `loginId`, device verification URL/code, account email, plan type, and the fixed `authentication_required` code.
- App Server event errors, raw exceptions, access/refresh/ID tokens, API keys, `auth.json`, and credential paths are never copied into account state or admin/data responses. Tests use synthetic credentials only.

### Listener Composition

- The data listener continues to serve the OpenAI-compatible data app. The loopback admin listener serves `createAdminApp`, not the data app, and remains bound through the typed `adminHost: "127.0.0.1"` configuration.
- The default admin port remains `8081`; supported non-default configured ports produce exact matching loopback origins and reject the default port when it is no longer the listener.

### Scope And Secrets

- Changes are limited to Task 11 account/admin implementation, central event subscription, readiness/listener composition, focused fixtures/regressions, and this handoff report.
- No credentials, OAuth tokens, environment files, databases, generated protocol changes, or generated graph artifacts are committed. No push or graph publication occurred.

## Concerns

- No blocking implementation concern remains.
- Graphify reports the existing non-blocking version warning: installed skill `0.4.3`, package `0.9.4`. `graphify-out/` remains untracked and intentionally excluded from commits.
- Root-level `bunx biome check .` scans untracked Graphify cache JSON; the tracked source, tests, and this report are checked explicitly instead.

## Authentication Epoch And Admin Session Follow-Up

### Status

Complete. Review findings for logout/read races, expired admin sessions, and ineffective safe-state coverage are remediated.

### RED Evidence

- Logout notification barrier: `bunx vitest run test/codex/account.test.ts -t "logout|serializes only safe"` failed because `account/updated` started a second read while logout was pending (`expected ... called once, but got 2 times`).
- Logout versus forced/notification reads: the same command failed because the combined race started a third read (`expected ... called 2 times, but got 3 times`). The deterministic fixtures return an old ChatGPT account from both the pre-logout forced read and the forbidden notification-read path.
- Expired/forbidden admin session: `bunx vitest run test/admin/app.test.ts -t "bootstraps a fresh session"` failed because fetch calls stopped at `[/api/state, /api/refresh]` instead of bootstrapping `/api/state` again. Vitest also captured the unhandled `Cannot read properties of undefined (reading 'type')` from `render(undefined)`.
- Safe-state coverage replacement: the literal compile-time `AccountState[]` test was removed. Its replacement drives a real `AccountManager` through ready, login-pending, sanitized error, and signed-out transitions, serializes each through `createAdminApp`, and checks exact state key sets plus forbidden credential substrings.

### GREEN Evidence

- Targeted account/state: `bunx vitest run test/codex/account.test.ts -t "logout|serializes only safe"` exited 0 with 5 tests passed and 9 skipped.
- Targeted admin script: `bunx vitest run test/admin/app.test.ts -t "bootstraps a fresh session"` exited 0 with 1 test passed and 14 skipped, with no unhandled rejection.
- Focused: `bunx vitest run test/admin test/codex/account.test.ts test/app.test.ts` exited 0 with 3 files and 36 tests passed.
- Full: `bun run test` exited 0 with 17 files and 321 tests passed.
- Protocol: `bun run protocol:check` exited 0 with no generated protocol diff.
- Typecheck: `bun run typecheck` exited 0 with no diagnostics.
- Build: `bun run build` exited 0.
- Biome: `bunx biome check src test` exited 0 with 45 files checked and no fixes required.
- Graphify: final `graphify update .` exited 0 and rebuilt 17,500 nodes, 20,345 edges, and 1,247 communities. HTML visualization remained skipped above the 5,000-node limit.

### Commit

- Findings remediation: `5adac5b99aead72fe0469aaa8a01ffd4ebe20a70` (`fix: harden account logout races`).

### Self-Review

- One epoch: reads, login, cancel, logout, generation-triggered reads, and notification-triggered reads all acquire or invalidate the same monotonic authentication operation epoch. Completion mutates state only while its captured epoch remains current.
- Logout authority: logout installs an active epoch before calling App Server, clears the active login, removes readiness immediately, blocks account notifications and generation/read refreshes, then advances the epoch and reasserts `signed_out` on success. Pre-logout reads that later observe an old ChatGPT account cannot restore readiness.
- Notification barrier: both `account/updated` and `account/login/completed` are ignored while logout is active. They remain delivered through the sole central `HostEventDispatcher`; no competing `CodexHost.events()` iterator was added.
- Session recovery: mutation responses with status `401` or `403` clear the stale CSRF value and bootstrap `/api/state`. JSON parse failures, failed bootstrap responses, and responses without state show a safe reload message; `render` is called only after a state-presence guard.
- Safe serialization: ready exposes exactly `type/email/planType`; login-pending exposes exactly `type/loginId/verificationUrl/userCode`; error exposes exactly `type/code`; signed-out exposes only `type`. Serialized responses are checked against token, API-key, credential, `auth.json`, and home-path patterns.
- Scope and secrets: changes are confined to account operation ordering, admin page recovery, focused tests, and this report. No credentials, generated protocol changes, database files, or graph artifacts are committed; no push or graph publication occurred.

### Concerns

- No blocking concern remains.
- The existing non-blocking Graphify skill/package version warning remains; `graphify-out/` is intentionally untracked.
