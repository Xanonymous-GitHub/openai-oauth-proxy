# Task 13 Report: Harden Codex And Build The Production Image

## Status

Complete. Task 13 adds a pinned Codex 0.144.1 hardening baseline, app-owned atomic runtime configuration, fail-closed verification before every App Server spawn, private filesystem modes, and a digest-pinned amd64/arm64 production image running Node as UID/GID 10001.

Implementation commit: `88df5ca340c348a4d26ea8dd071a16ebff584372` (`build: harden Codex runtime image`).

## Files

- Added `config/codex/config.toml` with the pinned authentication, approval, sandbox, instruction-file, web-search, update, and feature hardening keys.
- Added `config/codex/neutral-instructions.md` with exactly the four approved neutral instruction points and no coding persona.
- Added `src/runtime-security.ts` for `umask 077`, private directory modes, same-directory atomic config replacement, no-follow verification, and neutral-instruction loading.
- Modified `src/codex/supervisor.ts` to execute a synchronous configuration guard before every initial or recovery spawn and become unhealthy without invoking the child factory when verification fails.
- Modified `src/main.ts` to harden the runtime filesystem before any application write, force SQLite to `0600`, compose pre-spawn verification, and load the neutral instruction file.
- Added `Dockerfile` with digest-pinned Bun 1.3.14 build/dependency stages and Node 26.5.0 runtime, target-architecture Codex optional dependencies, protocol regeneration, compilation, UID/GID 10001, and read-only application files.
- Added `.dockerignore` exclusions for Git metadata, graph output, environment files, credentials, data, databases, dependencies, build output, and local agent configuration.
- Modified `.gitignore` to exclude generated `graphify-out/` artifacts from source checks and commits.
- Added `test/security/codex-config.test.ts` for baseline keys, forbidden extensibility, neutral instructions, atomic ownership, auth/session separation, modes, credential-compatible umask, fail-closed verification, and no-follow enforcement.
- Added `test/container.test.ts` for immutable image references, target-native Codex dependencies, build steps, production-only copies, non-root Node execution, context exclusions, and a real runtime version build/run check when Docker is available.
- Modified `test/codex/supervisor.test.ts` with a regression proving failed verification prevents child spawn.
- Modified `test/app.test.ts` with a regression proving an existing permissive SQLite file is corrected to `0600` before supervisor start.

## RED Evidence

1. Static policy and container artifacts:

   ```bash
   bunx vitest run test/security/codex-config.test.ts test/container.test.ts
   ```

   Result: `2` test files failed; `7` assertions failed and `1` passed. The failures were the expected absent hardening entries, four-line instruction baseline, pinned image references, target architecture installation, Node entrypoint, runtime directories, and `.dockerignore` exclusions.

2. Runtime ownership and fail-closed spawn:

   ```bash
   bunx vitest run test/security/codex-config.test.ts test/codex/supervisor.test.ts
   ```

   Result: `3` tests failed and `21` passed. `prepareRuntimeFilesystem` and `assertCodexConfiguration` were absent, and the supervisor invoked its child factory despite a throwing `beforeSpawn` guard.

3. Existing SQLite mode correction:

   ```bash
   bunx vitest run test/app.test.ts -t 'starts two listeners and removes shutdown handlers when closed'
   ```

   Result: `1` test failed and `7` were skipped. The existing database remained decimal mode `438` (`0666`) instead of decimal `384` (`0600`).

4. Real production image construction:

   ```bash
   bunx vitest run test/container.test.ts
   ```

   Result: `5` structural tests passed and the real image test failed. `node:26.5.0-bookworm-slim` already contained group name `proxy`, so `groupadd --gid 10001 proxy` exited `9`; changing only the account name to `app` preserved UID/GID 10001 and removed the collision.

5. Replaced-config no-follow guard:

   ```bash
   bunx vitest run test/security/codex-config.test.ts -t 'never follows a replaced config path during verification'
   ```

   Result: `1` test failed and `5` were skipped because verification did not yet use `O_NOFOLLOW`. GREEN opens `config.toml` with `O_NOFOLLOW`, verifies a regular single-link `0600` file by descriptor, and only then reads the app-owned config bytes.

## GREEN Evidence

### Codex 0.144.1 Configuration Probe

The installed binary reported `codex-cli 0.144.1`. The following strict probe exited `0` with stdin closed and no output, proving Codex 0.144.1 accepted every configured key and value. The instruction path alone is overridden to the equivalent local tracked file because `/app/config/codex/neutral-instructions.md` exists only inside the image.

```bash
bunx --bun codex app-server --strict-config --stdio \
  -c 'cli_auth_credentials_store="file"' \
  -c 'forced_login_method="chatgpt"' \
  -c 'approval_policy="never"' \
  -c 'sandbox_mode="read-only"' \
  -c 'model_instructions_file="/Users/xanonymous/PROJECTS/openai-oauth-proxy/.worktrees/codex-oauth-proxy/config/codex/neutral-instructions.md"' \
  -c 'web_search="disabled"' \
  -c 'check_for_update_on_startup=false' \
  -c 'features.apps=false' \
  -c 'features.hooks=false' \
  -c 'features.memories=false' \
  -c 'features.multi_agent=false' \
  -c 'features.remote_plugin=false' \
  -c 'features.shell_tool=false' \
  -c 'features.skill_mcp_dependency_install=false' \
  -c 'features.unified_exec=false' \
  -c 'features.network_proxy=false' \
  </dev/null
```

Result: exit `0`, no diagnostics.

### Immutable Multiarch Base Digests

```bash
docker buildx imagetools inspect oven/bun:1.3.14
```

Result: top-level OCI image index digest `sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4`, with Linux amd64 and arm64 manifests.

```bash
docker buildx imagetools inspect node:26.5.0-bookworm-slim
```

Result: top-level OCI image index digest `sha256:e999d087492c7227c85adc70574cf9d3cce774c3e6d7b8dfe473ee6b142c8f2c`, with Linux amd64 and arm64/v8 manifests.

### Security, Runtime, And Full Suite

```bash
bun run protocol:check
```

Result: exit `0`; Codex 0.144.1 regenerated TypeScript and JSON Schema protocol files and `git diff --exit-code -- src/codex/generated` found no drift.

```bash
bun run typecheck
```

Result: exit `0`; no TypeScript diagnostics.

```bash
bun run build
```

Result: exit `0`; production TypeScript compilation completed.

```bash
bunx biome check .
```

Result: exit `0`; `65` files checked, no fixes required.

```bash
bun run test
```

Result: exit `0`; `26` test files and `371` tests passed. This includes `6` container tests, the real target-platform image build, and an assertion that the runtime returns exactly `v26.5.0` from `node --version`.

`bun test` is not the project gate: it invokes Bun's built-in test runner, which does not provide the Vitest APIs used by this repository. The exact full-suite command is `bun run test`.

### Multiarch Image

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --output type=oci,dest=/var/folders/mk/plqz85z94cgdrcndslp87gzm0000gn/T/opencode/openai-oauth-proxy.oci \
  .
```

Result: exit `0`; both target platforms completed and the OCI exporter emitted manifest list `sha256:8fe334910f67b204e35aebbc173dea29a4678f5038bb1d7f7e2fc2b8336a306e`. Build-stage logs showed protocol generation and compilation. The target dependency stages mapped `amd64` to Bun CPU `x64` and `arm64` to `arm64`, installed with `--os=linux`, and required the corresponding executable `@openai/codex-linux-$BUN_CPU` native binary before continuing.

### Graphify

```bash
graphify update .
```

Result: exit `0`; `17,621` nodes, `20,624` edges, and `1,229` communities. `graphify-out/` remains ignored and was not committed or published.

## Self-Review

### Config And Auth Separation

- Runtime code creates or modifies only `${CODEX_HOME}/config.toml`; it does not enumerate, open, parse, rewrite, chmod, or remove `auth.json` or session files.
- The security fixture compares inode, modification time, and size before and after hardening to prove synthetic auth and session files remain untouched.
- `config/read` was not added to the App Server RPC facade or allowlist.

### No-Follow, Atomicity, And Modes

- `process.umask(0o077)` is the first operation in runtime filesystem preparation and precedes directory, config, SQLite, credential, and operation-directory writes.
- `CODEX_HOME` and empty working roots are enforced as `0700`; atomically replaced config and existing/new SQLite files are enforced as `0600`; the inherited umask makes App Server credential creation compatible with `0600`.
- Config is written with exclusive `wx` creation and mode `0600` to a randomized same-directory temporary path, renamed atomically over only `config.toml`, then verified.
- Verification opens `config.toml` with `O_NOFOLLOW`, checks the descriptor is one regular single-link `0600` file, compares exact baseline bytes, and rejects any failure with a fixed error.

### Every Spawn Verification

- The supervisor calls `beforeSpawn` synchronously before generation increment, restart notification, or child-factory invocation.
- The same `launch()` path handles the initial child and every recovery attempt, so each App Server spawn re-verifies the completed local config.
- A verification exception moves the supervisor directly to terminal unhealthy state, rejects initial startup, and never calls `spawn`.

### Native Architecture Dependencies

- Build-platform dependencies execute the pinned Codex binary for protocol generation and compilation.
- A separate production dependency stage consumes Docker's `TARGETARCH`, maps only `amd64` and `arm64`, installs Linux optional dependencies for that target, and fails unless the matching Codex native executable exists.
- The combined OCI build exercised both dependency branches successfully.

### Docker Runtime

- Builder and runtime references include exact versions and immutable top-level multiarch digests; no `latest` reference exists.
- The production stage starts from Node 26.5.0 only, does not copy Bun, runs an exec-form Node entrypoint, and switches to UID/GID `10001`.
- Application dependencies, `dist/`, and baseline config are root-owned and made non-writable; runtime writes are confined to `/tmp` and `/data`, matching read-only-root deployment expectations.
- Source, Git metadata, environment files, auth files, databases, data directories, graph output, and local agent files are excluded from the build context or final image as applicable.

### Scope

- Changes are limited to Task 13 runtime hardening, container construction, focused regressions, and generated-output exclusion needed for the requested Biome/Graphify gates.
- No generated protocol drift, credentials, databases, environment files, graph artifacts, deployment manifests, or unrelated refactors are included.
- The report adds no implementation change after `88df5ca340c348a4d26ea8dd071a16ebff584372`.

## Concerns

- No blocking implementation concern remains.
- A real authenticated App Server session was not started because no credentials were provided; strict config parsing, spawn gating, protocol generation, native binary presence, Node runtime, and both image platforms were verified offline.
- Graphify reports its existing non-blocking version warning: installed skill `0.4.3`, package `0.9.4`.
- The multiarch OCI archive is a temporary local verification artifact outside the repository and is not committed or published.
