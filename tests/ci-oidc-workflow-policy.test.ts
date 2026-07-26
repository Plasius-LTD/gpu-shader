import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

let workflow = "";
let topLevel = "";
let buildTest = "";
let codecov = "";
let publicArtifactIntegrity = "";

function workflowJob(source: string, name: string): string {
  const prefix = `  ${name}:`;
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === prefix);
  if (start < 0) throw new Error(`Workflow job not found: ${name}`);

  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end] ?? "";
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
      end += 1;
      continue;
    }
    const leadingSpaces = /^ */u.exec(line)?.[0].length ?? 0;
    if (leadingSpaces <= 2) break;
    end += 1;
  }
  return lines.slice(start, end).join("\n");
}

beforeAll(async () => {
  workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  topLevel = workflow.slice(0, workflow.indexOf("\njobs:\n"));
  buildTest = workflowJob(workflow, "build-test");
  codecov = workflowJob(workflow, "codecov");
  publicArtifactIntegrity = workflowJob(workflow, "public_artifact_integrity");
});

describe("CI Codecov OIDC isolation policy", () => {
  it("keeps the required build-test job free of OIDC permission", () => {
    expect(topLevel).not.toContain("id-token: write");
    expect(buildTest).toContain("\n    permissions:\n      actions: read\n      contents: read\n");
    expect(buildTest).not.toContain("id-token:");
  });

  it("publishes only the gated LCOV report under an attempt-scoped identity", () => {
    const packGate = buildTest.indexOf("Verify public package contents and exports");
    const artifactUpload = buildTest.indexOf("Upload attempt-scoped LCOV artifact");

    expect(packGate).toBeGreaterThan(-1);
    expect(artifactUpload).toBeGreaterThan(packGate);
    expect(buildTest).toContain(
      "name: coverage-${{ github.run_id }}-attempt-${{ github.run_attempt }}",
    );
    expect(buildTest).toContain("path: ${{ env.LCOV_FILE }}");
    expect(buildTest).toContain("if-no-files-found: error");
  });

  it("grants OIDC only to a data-only Codecov upload job", () => {
    expect(codecov).toContain("needs: build-test");
    expect(codecov).toContain(
      "permissions:\n      actions: read\n      contents: read\n      id-token: write",
    );
    expect(codecov).toContain(
      "name: coverage-${{ github.run_id }}-attempt-${{ github.run_attempt }}",
    );
    expect(codecov).toContain("files: codecov-coverage/lcov.info");
    expect(codecov).toContain("use_oidc: true");
    expect(codecov).not.toContain("actions/checkout@");
    expect(codecov).not.toContain("actions/setup-node@");
    expect(codecov).not.toMatch(/^\s+run:/mu);
    expect(codecov).not.toContain("npm ");
  });

  it("keeps the public artifact gate read-only and outside the OIDC job", () => {
    expect(publicArtifactIntegrity).toContain("contents: read");
    expect(publicArtifactIntegrity).not.toContain("id-token:");
    expect(publicArtifactIntegrity).toContain("scripts/verify-public-artifacts.cjs");
  });
});
