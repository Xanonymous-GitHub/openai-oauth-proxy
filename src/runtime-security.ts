import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
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
  configFilesystem?: ConfigFilesystem;
}

export interface ConfigFilesystem {
  open(path: string, flags: number, mode?: number): number;
  fchmod(descriptor: number, mode: number): void;
  write(descriptor: number, content: string): void;
  fsync(descriptor: number): void;
  close(descriptor: number): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
}

const nodeConfigFilesystem: ConfigFilesystem = {
  open: (path, flags, mode) => openSync(path, flags, mode),
  fchmod: (descriptor, mode) => fchmodSync(descriptor, mode),
  write: (descriptor, content) => writeFileSync(descriptor, content, "utf8"),
  fsync: (descriptor) => fsyncSync(descriptor),
  close: (descriptor) => closeSync(descriptor),
  rename: (from, to) => renameSync(from, to),
  remove: (path) => rmSync(path, { force: true }),
};

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
  const filesystem = options.configFilesystem ?? nodeConfigFilesystem;
  let temporaryDescriptor: number | undefined;
  let directoryDescriptor: number | undefined;
  let renamed = false;
  try {
    temporaryDescriptor = filesystem.open(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    filesystem.fchmod(temporaryDescriptor, 0o600);
    filesystem.write(temporaryDescriptor, baselineConfig());
    filesystem.fsync(temporaryDescriptor);
    filesystem.close(temporaryDescriptor);
    temporaryDescriptor = undefined;

    directoryDescriptor = filesystem.open(
      options.codexHome,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    filesystem.rename(temporaryPath, configPath);
    renamed = true;
    filesystem.fsync(directoryDescriptor);
    filesystem.close(directoryDescriptor);
    directoryDescriptor = undefined;
    assertCodexConfiguration(options.codexHome);
  } finally {
    if (temporaryDescriptor !== undefined) {
      filesystem.close(temporaryDescriptor);
    }
    if (directoryDescriptor !== undefined) {
      filesystem.close(directoryDescriptor);
    }
    if (!renamed) filesystem.remove(temporaryPath);
  }
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
