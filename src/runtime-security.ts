import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BASELINE_CONFIG_PATH = fileURLToPath(
  new URL("../config/codex/config.toml", import.meta.url),
);
const NEUTRAL_INSTRUCTIONS_PATH = fileURLToPath(
  new URL("../config/codex/neutral-instructions.md", import.meta.url),
);

interface RuntimeFilesystemOptions {
  codexHome: string;
  dataDir: string;
  workingDirectories: string[];
}

function baselineConfig(): string {
  return readFileSync(BASELINE_CONFIG_PATH, "utf8");
}

export function prepareRuntimeFilesystem(
  options: RuntimeFilesystemOptions,
): void {
  process.umask(0o077);
  mkdirSync(options.dataDir, { recursive: true });
  mkdirSync(options.codexHome, { recursive: true, mode: 0o700 });
  chmodSync(options.codexHome, 0o700);
  for (const directory of options.workingDirectories) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }

  const configPath = join(options.codexHome, "config.toml");
  const temporaryPath = join(
    options.codexHome,
    `.config.toml.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, baselineConfig(), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, configPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  chmodSync(configPath, 0o600);
  assertCodexConfiguration(options.codexHome);
}

export function assertCodexConfiguration(codexHome: string): void {
  const configPath = join(codexHome, "config.toml");
  let descriptor: number | undefined;
  try {
    const home = lstatSync(codexHome);
    if (!home.isDirectory() || (home.mode & 0o777) !== 0o700) throw new Error();
    descriptor = openSync(
      configPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const localConfig = fstatSync(descriptor);
    if (
      !localConfig.isFile() ||
      localConfig.nlink !== 1 ||
      (localConfig.mode & 0o777) !== 0o600 ||
      readFileSync(descriptor, "utf8") !== baselineConfig()
    ) {
      throw new Error();
    }
  } catch {
    throw new Error("Codex configuration verification failed");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function readNeutralInstructions(): string {
  return readFileSync(NEUTRAL_INSTRUCTIONS_PATH, "utf8");
}
