import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("release policy", () => {
  it("pins exact toolchains and immutable actions in the complete offline gate", () => {
    const workflow = read(".github/workflows/ci.yml");
    expect(workflow).toContain('node-version: "26.5.0"');
    expect(workflow).toContain('bun-version: "1.3.14"');
    expect(workflow).toContain('REQUIRE_EXTERNAL_AGENTS: "1"');
    expect(workflow).toContain("bun install --frozen-lockfile");
    for (const command of [
      "bun run protocol:check",
      "bun run deps:check",
      "bun run check",
      "kubectl kustomize deploy/base",
      "kubectl apply --dry-run=client",
    ]) {
      expect(workflow).toContain(command);
    }
    expect(workflow).toContain("linux/amd64,linux/arm64");
    expect(workflow).toMatch(/sbom/i);
    expect(workflow).toMatch(/vulnerab|scan/i);
    for (const action of workflow.matchAll(/uses:\s*[^@\s]+@([^\s]+)/g)) {
      expect(action[1]).toMatch(/^[a-f0-9]{40}$/);
    }
  });

  it("opens scheduled dependency pull requests and excludes JavaScript Dependabot", () => {
    const workflow = read(".github/workflows/dependencies.yml");
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("npm-check-updates -u");
    expect(workflow).toContain("create-pull-request");
    expect(workflow).not.toMatch(/git push|git commit/);
    const dependabot = read(".github/dependabot.yml");
    expect(dependabot).toContain('package-ecosystem: "github-actions"');
    expect(dependabot).toContain('package-ecosystem: "docker"');
    expect(dependabot).not.toMatch(/package-ecosystem:\s*["']?(npm|bun)/);
  });

  it("publishes immutable multiarch GHCR releases with digest validation and supply-chain evidence", () => {
    const workflow = read(".github/workflows/release.yml");
    expect(workflow).toMatch(/tags:\s*\n\s*- ["']v\*/);
    expect(workflow).toContain("packages: write");
    expect(workflow).toContain("linux/amd64,linux/arm64");
    expect(workflow).toContain("push: true");
    expect(workflow).toContain("ghcr.io");
    expect(workflow).toMatch(/sha256:\[0-9a-f\]\{64\}/);
    expect(workflow).toContain("docker buildx imagetools inspect");
    expect(workflow).toMatch(/linux\/amd64/);
    expect(workflow).toMatch(/linux\/arm64/);
    expect(workflow).toMatch(/provenance: true/);
    expect(workflow).toMatch(/sbom/i);
    expect(workflow).toMatch(/vulnerab|scan/i);
    expect(workflow).toMatch(/already exists|refusing to overwrite/i);
    for (const action of workflow.matchAll(/uses:\s*[^@\s]+@([^\s]+)/g)) {
      expect(action[1]).toMatch(/^[a-f0-9]{40}$/);
    }
  });

  it("documents operator, support, security, and non-goal contracts", () => {
    const documentation = `${read("README.md")}\n${read("deploy/README.md")}`;
    for (const phrase of [
      "Models",
      "Chat Completions",
      "Responses",
      "unsupported",
      "encrypted StorageClass",
      "install",
      "upgrade",
      "Rollback",
      "kubectl port-forward pod/openai-oauth-proxy-0 8081:8081",
      "device login",
      "logout",
      "/healthz",
      "/readyz",
      "/metrics",
      "backups",
      "FQDN-aware",
      "single replica",
      "tool continuation",
      "LIVE_CHATGPT_TESTS=1",
      "LIVE_CHATGPT_CODEX_HOME",
      "Node Current",
      "non-goals",
      "namespace",
      "OPENAI_PROXY_TOKEN",
      "BIFROST_PROXY_TOKEN",
    ]) {
      expect(documentation).toContain(phrase);
    }
    expect(documentation).toMatch(
      /OPENAI_PROXY_TOKEN[^\n]+(?:same|equal|match)[^\n]+BIFROST_PROXY_TOKEN/i,
    );
  });
});
