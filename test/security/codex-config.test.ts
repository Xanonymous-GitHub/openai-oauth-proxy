import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const config = read("config/codex/config.toml");
const instructions = read("config/codex/neutral-instructions.md");
const runtimeSecuritySource = read("src/runtime-security.ts");

describe("Codex hardening baseline", () => {
  it("pins every Codex 0.144.1 hardening setting", () => {
    for (const entry of [
      'cli_auth_credentials_store = "file"',
      'forced_login_method = "chatgpt"',
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      'model_instructions_file = "/app/config/codex/neutral-instructions.md"',
      'web_search = "disabled"',
      "check_for_update_on_startup = false",
      "[features]",
      "apps = false",
      "hooks = false",
      "memories = false",
      "multi_agent = false",
      "remote_plugin = false",
      "shell_tool = false",
      "skill_mcp_dependency_install = false",
      "unified_exec = false",
      "network_proxy = false",
    ]) {
      expect(config).toContain(`${entry}\n`);
    }
  });

  it("does not introduce extensibility or writable/network policy", () => {
    expect(config).not.toMatch(
      /^\s*(?:mcp_servers|plugin|skill_root|hook|writable_root|network_access|allowed_domain|allowed_path)(?:\.|\s*=|\s*\])/im,
    );
    expect(config).not.toMatch(
      /^\s*(?:apps|hooks|remote_plugin)\s*=\s*true\s*$/m,
    );
  });

  it("never follows a replaced config path during verification", () => {
    expect(runtimeSecuritySource).toContain("O_NOFOLLOW");
  });

  it("contains only the four approved neutral instruction points", () => {
    expect(
      instructions
        .trim()
        .split("\n")
        .filter((line) => line.length > 0),
    ).toEqual([
      "- Respond only with text or supplied client function tools.",
      "- Internal tools are unavailable.",
      "- Do not assume a repository or workspace is available.",
      "- Follow the requested output format.",
    ]);
    expect(instructions).not.toMatch(
      /coding agent|software engineer|write code|modify files|use the shell/i,
    );
  });
});

interface RuntimeSecurityModule {
  assertCodexConfiguration?: (codexHome: string) => void;
  prepareRuntimeFilesystem?: (options: {
    codexHome: string;
    dataDir: string;
    workingDirectories: string[];
    configFilesystem?: {
      open(path: string, flags: number, mode?: number): number;
      fchmod(descriptor: number, mode: number): void;
      write(descriptor: number, content: string): void;
      fsync(descriptor: number): void;
      close(descriptor: number): void;
      rename(from: string, to: string): void;
      remove(path: string): void;
    };
  }) => void;
}

describe("runtime filesystem hardening", () => {
  it("atomically owns config only and applies private modes", async () => {
    const runtime = (await import("../../src/runtime-security.js").catch(
      () => ({}),
    )) as RuntimeSecurityModule;
    expect(runtime.prepareRuntimeFilesystem).toBeTypeOf("function");
    if (!runtime.prepareRuntimeFilesystem) return;

    const root = mkdtempSync(join(tmpdir(), "codex-security-"));
    const dataDir = join(root, "data");
    const codexHome = join(dataDir, "codex");
    const work = join(root, "tmp", "work");
    const operations = join(root, "tmp", "response-operations");
    mkdirSync(join(codexHome, "sessions"), { recursive: true, mode: 0o755 });
    const authPath = join(codexHome, "auth.json");
    const sessionPath = join(codexHome, "sessions", "fixture.jsonl");
    writeFileSync(authPath, "synthetic-auth-fixture", { mode: 0o600 });
    writeFileSync(sessionPath, "synthetic-session-fixture", { mode: 0o600 });
    writeFileSync(join(codexHome, "config.toml"), "unsafe = true\n", {
      mode: 0o644,
    });
    const authBefore = statSync(authPath);
    const sessionBefore = statSync(sessionPath);
    const previousUmask = process.umask();

    try {
      runtime.prepareRuntimeFilesystem({
        codexHome,
        dataDir,
        workingDirectories: [work, operations],
      });

      expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(config);
      expect(statSync(codexHome).mode & 0o777).toBe(0o700);
      expect(statSync(join(codexHome, "config.toml")).mode & 0o777).toBe(0o600);
      expect(statSync(work).mode & 0o777).toBe(0o700);
      expect(statSync(operations).mode & 0o777).toBe(0o700);
      expect(readdirSync(work)).toEqual([]);
      expect(readdirSync(operations)).toEqual([]);
      expect(statSync(authPath)).toMatchObject({
        ino: authBefore.ino,
        mtimeMs: authBefore.mtimeMs,
        size: authBefore.size,
      });
      expect(statSync(sessionPath)).toMatchObject({
        ino: sessionBefore.ino,
        mtimeMs: sessionBefore.mtimeMs,
        size: sessionBefore.size,
      });
      expect(
        readdirSync(codexHome).filter((name) => name.includes(".tmp")),
      ).toEqual([]);

      const credentialFixture = join(codexHome, "credential-fixture");
      closeSync(openSync(credentialFixture, "wx"));
      expect(statSync(credentialFixture).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails verification when app-owned config differs", async () => {
    const runtime = (await import("../../src/runtime-security.js").catch(
      () => ({}),
    )) as RuntimeSecurityModule;
    expect(runtime.assertCodexConfiguration).toBeTypeOf("function");
    if (!runtime.assertCodexConfiguration) return;

    const root = mkdtempSync(join(tmpdir(), "codex-verify-"));
    try {
      writeFileSync(
        join(root, "config.toml"),
        'sandbox_mode = "workspace-write"\n',
        {
          mode: 0o600,
        },
      );
      expect(() => runtime.assertCodexConfiguration?.(root)).toThrow(
        "Codex configuration verification failed",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed without mutating credentials replaced after rename", async () => {
    const runtime = (await import("../../src/runtime-security.js").catch(
      () => ({}),
    )) as RuntimeSecurityModule;
    expect(runtime.prepareRuntimeFilesystem).toBeTypeOf("function");
    if (!runtime.prepareRuntimeFilesystem) return;

    const root = mkdtempSync(join(tmpdir(), "codex-rename-race-"));
    const dataDir = join(root, "data");
    const codexHome = join(dataDir, "codex");
    const credentialPath = join(codexHome, "credential-fixture");
    const credentialContent = "synthetic-credential-content";
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    writeFileSync(credentialPath, credentialContent, { mode: 0o640 });
    chmodSync(credentialPath, 0o640);
    const credentialMode = statSync(credentialPath).mode & 0o777;
    let temporaryDescriptor: number | undefined;
    let directoryDescriptor: number | undefined;
    let temporaryFlags = 0;
    let temporaryMode: number | undefined;
    let descriptorMode: number | undefined;
    let temporaryWritten = false;
    let temporarySynced = false;
    let directorySynced = false;
    let replaced = false;

    try {
      expect(() =>
        runtime.prepareRuntimeFilesystem?.({
          codexHome,
          dataDir,
          workingDirectories: [join(root, "work")],
          configFilesystem: {
            open: (path, flags, mode) => {
              const descriptor = openSync(path, flags, mode);
              if (path === codexHome) directoryDescriptor = descriptor;
              else {
                temporaryDescriptor = descriptor;
                temporaryFlags = flags;
                temporaryMode = mode;
              }
              return descriptor;
            },
            fchmod: (descriptor, mode) => {
              expect(descriptor).toBe(temporaryDescriptor);
              descriptorMode = mode;
              fchmodSync(descriptor, mode);
            },
            write: (descriptor, content) => {
              expect(descriptor).toBe(temporaryDescriptor);
              temporaryWritten = true;
              writeFileSync(descriptor, content, "utf8");
            },
            fsync: (descriptor) => {
              if (descriptor === temporaryDescriptor) temporarySynced = true;
              if (descriptor === directoryDescriptor) directorySynced = true;
              fsyncSync(descriptor);
            },
            close: (descriptor) => closeSync(descriptor),
            rename: (from, to) => {
              expect(temporaryWritten).toBe(true);
              expect(temporarySynced).toBe(true);
              renameSync(from, to);
              rmSync(to);
              symlinkSync(credentialPath, to);
              replaced = true;
            },
            remove: (path) => {
              expect(replaced).toBe(false);
              rmSync(path, { force: true });
            },
          },
        }),
      ).toThrow("Codex configuration verification failed");
      expect(replaced).toBe(true);
      expect(temporaryFlags & constants.O_CREAT).toBe(constants.O_CREAT);
      expect(temporaryFlags & constants.O_EXCL).toBe(constants.O_EXCL);
      expect(temporaryFlags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
      expect(temporaryMode).toBe(0o600);
      expect(descriptorMode).toBe(0o600);
      expect(directorySynced).toBe(true);
      expect(readFileSync(credentialPath, "utf8")).toBe(credentialContent);
      expect(statSync(credentialPath).mode & 0o777).toBe(credentialMode);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
