import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

let workflow = "";
let topLevel = "";
let buildTest = "";
let codecov = "";

beforeAll(async () => {
  workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  topLevel = workflow.slice(0, workflow.indexOf("\njobs:\n"));
  buildTest = workflow.slice(workflow.indexOf("\n  build-test:\n"), workflow.indexOf("\n  codecov:\n"));
  codecov = workflow.slice(workflow.indexOf("\n  codecov:\n"));
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
});
