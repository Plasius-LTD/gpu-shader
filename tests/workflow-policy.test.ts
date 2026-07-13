import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

let workflow = "";
let physical = "";
let swiftshader = "";

beforeAll(async () => {
  workflow = await readFile(new URL("../.github/workflows/shader-qualification.yml", import.meta.url), "utf8");
  physical = workflow.slice(workflow.indexOf("\n  physical:\n"), workflow.indexOf("\n  aggregate:\n"));
  swiftshader = workflow.slice(workflow.indexOf("\n  swiftshader:\n"), workflow.indexOf("\n  physical:\n"));
});

describe("fail-closed shader qualification workflow policy", () => {
  it("trusts only the protected-main reusable workflow identity", () => {
    expect(workflow).toContain(
      "Plasius-LTD/gpu-shader/.github/workflows/shader-qualification.yml@refs/heads/main",
    );
    expect(workflow).toContain("jobWorkflowRef !== requiredTrustedWorkflowRef");
    expect(workflow).toContain("trustedWorkflowRef !== requiredTrustedWorkflowRef");
    expect(workflow).not.toContain("@(?:refs\\/.+|[a-f0-9]{40,64})");
  });

  it("uses run-attempt-scoped immutable artifact identities", () => {
    expect(workflow).toContain('const attemptIdentity = qualificationId + "-attempt-" + runAttempt');
    for (const line of workflow.split("\n").filter((value) =>
      /^\s+(?:name|pattern): shader-(?:evidence|runner-preflight|qualification)-/u.test(value),
    )) {
      expect(line, line).toContain("attempt-");
    }
  });

  it("creates a typed fallback before setup and selects exactly one outcome", () => {
    expect(swiftshader.indexOf("Initialize typed SwiftShader failure outcome")).toBeLessThan(
      swiftshader.indexOf("Check out the fixed trusted harness"),
    );
    expect(physical.indexOf("Initialize isolated physical cell workspace and typed failure outcome")).toBeLessThan(
      physical.indexOf("Check out the fixed trusted harness"),
    );
    for (const job of [swiftshader, physical]) {
      expect(job).toContain("non-qualifying-workflow-diagnostic");
      expect(job).toContain("Select exactly one typed");
      expect(job).toContain("FINALIZE_OUTCOME");
    }
  });

  it("keeps runner.temp at step scope and physical steps shell-neutral", () => {
    const physicalHeader = physical.slice(0, physical.indexOf("\n    steps:\n"));
    expect(physicalHeader).not.toContain("runner.temp");
    expect(physical).not.toContain("shell: bash");
    expect(physical).not.toContain("PLASIUS_CELL_ROOT");
    expect(physical).toContain("uses: actions/github-script@");
  });
});
