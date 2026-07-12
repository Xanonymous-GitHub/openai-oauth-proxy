import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const dockerfile = read("Dockerfile");
const dockerignore = read(".dockerignore");
const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

describe("production container", () => {
  it("pins exact builder and runtime versions to current multiarch indexes", () => {
    expect(dockerfile).toContain(
      "oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4",
    );
    expect(dockerfile).toContain(
      "node:26.5.0-bookworm-slim@sha256:e999d087492c7227c85adc70574cf9d3cce774c3e6d7b8dfe473ee6b142c8f2c",
    );
    expect(dockerfile.match(/^FROM\b/gm)).toHaveLength(3);
    expect(dockerfile).not.toMatch(/(?:^|[:@])latest(?:\s|$)/m);
  });

  it("installs the Codex native package for each target architecture", () => {
    expect(dockerfile).toContain("ARG TARGETARCH");
    expect(dockerfile).toMatch(/amd64[^\n]+x64/);
    expect(dockerfile).toMatch(/arm64[^\n]+arm64/);
    expect(dockerfile).toContain('--cpu="$BUN_CPU" --os=linux');
    expect(dockerfile).toContain("@openai/codex-linux-$BUN_CPU");
  });

  it("regenerates protocol, compiles, and ships production inputs only", () => {
    expect(dockerfile).toContain("bun install --frozen-lockfile");
    expect(dockerfile).toContain("bun run protocol:generate");
    expect(dockerfile).toContain("bun run build");
    expect(dockerfile).toMatch(/COPY --from=prod-deps \/app\/node_modules/);
    expect(dockerfile).toMatch(/COPY --from=build \/app\/dist/);
    expect(dockerfile).toMatch(/COPY --from=build \/app\/config/);
    expect(dockerfile).not.toMatch(/COPY[^\n]*(?:\.env|auth\.json)/);
  });

  it("runs Node as UID/GID 10001 without a shell entrypoint", () => {
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain('ENTRYPOINT ["node", "dist/main.js"]');
    expect(dockerfile).not.toMatch(/^ENTRYPOINT\s+(?!\[)/m);
    expect(dockerfile).not.toMatch(/COPY --from=\S+\s+\/usr\/local\/bin\/bun/);
    expect(dockerfile).toMatch(/\/tmp\/work/);
    expect(dockerfile).toMatch(/\/tmp\/response-operations/);
    expect(dockerfile).toMatch(/\/data/);
  });

  it("excludes credentials, state, Git, and graph outputs from context", () => {
    for (const entry of [".git", ".env", "data", "auth.json", "graphify-out"]) {
      expect(dockerignore.split("\n")).toContain(entry);
    }
  });

  it.skipIf(!dockerAvailable)(
    "runs the pinned Node runtime",
    () => {
      const tag = `openai-oauth-proxy-test:${randomUUID()}`;
      try {
        execFileSync(
          "docker",
          [
            "buildx",
            "build",
            "--load",
            "--platform",
            `linux/${process.arch === "arm64" ? "arm64" : "amd64"}`,
            "--tag",
            tag,
            ".",
          ],
          { stdio: "inherit" },
        );
        expect(
          execFileSync(
            "docker",
            ["run", "--rm", "--entrypoint", "node", tag, "--version"],
            { encoding: "utf8" },
          ).trim(),
        ).toBe("v26.5.0");
      } finally {
        spawnSync("docker", ["image", "rm", "--force", tag], {
          stdio: "ignore",
        });
      }
    },
    300_000,
  );
});
