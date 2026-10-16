import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("initializes Hermes home on the runner before installing external agents", () => {
    const job = workflow.jobs["release-gate"];
    expect(job.env).not.toHaveProperty("HERMES_HOME");

    const setupIndex = job.steps.findIndex(
      (step) => step.name === "Set Hermes home",
    );
    const installIndex = job.steps.findIndex(
      (step) => step.name === "Install pinned external agent clients",
    );
    expect(setupIndex).toBeGreaterThanOrEqual(0);
    expect(installIndex).toBeGreaterThan(setupIndex);

    const setup = job.steps[setupIndex]?.run;
    expect(setup).toBeDefined();
    const directory = mkdtempSync(join(tmpdir(), "ci-hermes-home-"));
    const runnerTemp = join(directory, "runner temp");
    const githubEnv = join(directory, "github-env");
    try {
      execFileSync("bash", ["-e", "-u", "-c", setup ?? ""], {
        env: { ...process.env, RUNNER_TEMP: runnerTemp, GITHUB_ENV: githubEnv },
      });
      expect(readFileSync(githubEnv, "utf8")).toBe(
        `HERMES_HOME=${runnerTemp}/hermes-home\n`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the Hermes dependency home available after the installer exits", () => {
    const job = workflow.jobs["release-gate"];
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
