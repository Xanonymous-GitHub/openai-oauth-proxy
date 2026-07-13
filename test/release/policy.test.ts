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
    expect(workflow).toContain("push=true");
    expect(workflow).toContain("ghcr.io");
    expect(workflow).toMatch(/sha256:\[0-9a-f\]\{64\}/);
    expect(workflow).toContain("docker buildx imagetools inspect");
    expect(workflow).toMatch(/linux\/amd64/);
    expect(workflow).toMatch(/linux\/arm64/);
    expect(workflow).toMatch(/provenance: true/);
    expect(workflow).toMatch(/sbom/i);
    expect(workflow).toMatch(/vulnerab|scan/i);
    expect(workflow).toMatch(/already exists|refusing to overwrite/i);
    const concurrency = workflow.slice(
      workflow.indexOf("concurrency:"),
      workflow.indexOf("jobs:"),
    );
    expect(concurrency).toContain("group: release-images");
    expect(concurrency).toContain("cancel-in-progress: false");
    expect(concurrency).not.toContain("github.ref");
    const authenticate = workflow.indexOf("name: Authenticate to GHCR");
    const versionProbe = workflow.indexOf(
      "name: Refuse to overwrite the version tag",
    );
    const sourceProbe = workflow.indexOf(
      "name: Refuse to overwrite the source tag",
    );
    const build = workflow.indexOf("name: Build and push multiarch image");
    const scan = workflow.indexOf("name: Scan SBOM for vulnerabilities");
    const tag = workflow.indexOf("name: Create final release tags");
    const verify = workflow.indexOf("name: Verify published release");
    expect(authenticate).toBeGreaterThan(0);
    expect(authenticate).toBeLessThan(versionProbe);
    expect(authenticate).toBeLessThan(sourceProbe);
    expect(versionProbe).toBeLessThan(sourceProbe);
    expect(sourceProbe).toBeLessThan(build);
    expect(build).toBeLessThan(scan);
    expect(scan).toBeLessThan(tag);
    expect(tag).toBeLessThan(verify);
    const probeSections = [
      workflow.slice(versionProbe, sourceProbe),
      workflow.slice(sourceProbe, build),
    ];
    for (const probe of probeSections) {
      expect(probe).toContain("docker buildx imagetools inspect");
      expect(probe).toMatch(/PROBE_STATUS=\$\?/);
      expect(probe).toMatch(/if \[ "\$[A-Z_]+PROBE_STATUS" -eq 0 \]/);
      expect(probe).toMatch(/if ! grep[^\n]+manifest unknown/i);
      expect(probe).toMatch(/unable to verify[^\n]+tag absence/i);
      expect(probe).toMatch(/exit 1/);
      expect(probe).not.toMatch(/PROBE_STATUS[^\n]*\|\| true/);
    }
    expect(workflow).toContain("push-by-digest=true");
    expect(workflow.slice(build, scan)).not.toContain("tags:");
    expect(workflow).toContain("docker buildx imagetools create");
    expect(workflow).toMatch(/attestation-manifest/);
    const tagSection = workflow.slice(tag, verify);
    expect(tagSection).toContain('--tag "$IMAGE:$GITHUB_REF_NAME"');
    expect(tagSection).toContain('--tag "$IMAGE:sha-$GITHUB_SHA"');
    expect(workflow).not.toContain("$IMAGE:latest");
    const verifySection = workflow.slice(verify);
    expect(verifySection).toContain('"$IMAGE:$GITHUB_REF_NAME"');
    expect(verifySection).toContain('"$IMAGE:sha-$GITHUB_SHA"');
    expect(verifySection).toMatch(/linux\/amd64/);
    expect(verifySection).toMatch(/linux\/arm64/);
    expect(verifySection).toMatch(/attestation-manifest/);
    expect(verifySection).toContain("cosign verify");
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
      "only immutable version and source SHA tags",
    ]) {
      expect(documentation).toContain(phrase);
    }
    expect(documentation).toMatch(
      /OPENAI_PROXY_TOKEN[^\n]+(?:same|equal|match)[^\n]+BIFROST_PROXY_TOKEN/i,
    );
  });
});
