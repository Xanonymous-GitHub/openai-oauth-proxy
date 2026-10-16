import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const workflow = parseDocument(
  readFileSync(".github/workflows/ci.yml", "utf8"),
).toJS() as {
  jobs: {
    "release-gate": {
      env: Record<string, string>;
      steps: { name?: string; run?: string }[];
    };
  };
};

describe("CI external agent setup", () => {
  it("keeps the Hermes dependency home available after the installer exits", () => {
    const job = workflow.jobs["release-gate"];
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression, not JavaScript interpolation.
    expect(job.env.HERMES_HOME).toBe("${{ runner.temp }}/hermes-home");

    const install = job.steps.find(
      (step) => step.name === "Install pinned external agent clients",
    )?.run;
    expect(install).toContain('--hermes-home "$HERMES_HOME"');
    expect(install).toContain('--dir "$HERMES_HOME/hermes-agent"');
    expect(install).toContain(
      'git -C "$HERMES_HOME/hermes-agent" rev-parse HEAD',
    );
  });
});
