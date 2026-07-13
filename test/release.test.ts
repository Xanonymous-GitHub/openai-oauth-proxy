import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/release.yml", "utf8");

describe("release workflow", () => {
  it("normalizes the GHCR image name before publishing", () => {
    expect(workflow).toContain("id: image");
    expect(workflow).toMatch(
      /ghcr\.io\/\$\{GITHUB_REPOSITORY_OWNER,,\}\/openai-oauth-proxy/,
    );
    expect(workflow).toMatch(
      /name=\$\{\{ steps\.image\.outputs\.image \}\},push-by-digest=true/,
    );
    expect(workflow).toMatch(
      /image: \$\{\{ steps\.image\.outputs\.image \}\}@\$\{\{ steps\.build\.outputs\.digest \}\}/,
    );
    expect(workflow).not.toContain("github.repository_owner");
  });

  it("accepts GHCR's absent-tag response when protecting immutable tags", () => {
    expect(
      workflow.match(/grep -Eiq 'manifest unknown\|not found'/g) ?? [],
    ).toHaveLength(2);
  });

  it("matches the aligned digest output from imagetools inspect", () => {
    expect(
      workflow.match(/grep -Eq "\^Digest:\[\[:space:\]\]\+\$DIGEST\$"/g) ?? [],
    ).toHaveLength(2);
  });
});
