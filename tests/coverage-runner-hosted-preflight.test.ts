import { describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  hostName: "ubuntu",
  hostVersion: "24.04",
  hostArchitecture: "x64",
}));

vi.mock("playwright-core", () => ({
  chromium: { executablePath: () => "/trusted/chromium-1234/chrome" },
}));

vi.mock("../src/testing/runner/host.js", () => ({
  observeTrustedRunnerHost: async (
    _cell: unknown,
    runner: { readonly name: string; readonly labels: readonly string[] },
  ) => ({
    runner: { id: runner.name, labels: runner.labels },
    os: {
      name: boundary.hostName,
      version: boundary.hostVersion,
      channel: null,
      architecture: boundary.hostArchitecture,
    },
  }),
}));

vi.mock("../src/testing/runner/playwright-integrity.js", () => ({
  observePlaywrightAdapterHarness: async () => ({
    id: "playwright-core" as const,
    version: "1.62.1",
    sha256: "a".repeat(64),
  }),
}));

import {
  SHADER_VALIDATION_EVIDENCE_VERSION,
  type ShaderQualificationPreflightManifest,
  type StableWebGpuMatrixCell,
  type StableWebGpuMatrixManifest,
} from "../src/contracts.js";
import { computeSha256 } from "../src/hash.js";
import { createHostedSwiftShaderRunnerPreflight } from "../src/testing/runner/identity.js";
import { provenance, ZERO_SHA } from "./fixtures.js";

const cell: StableWebGpuMatrixCell = {
  cellId: "swiftshader.chromium.ubuntu-x64",
  runnerLabels: ["ubuntu-24.04"],
  browser: { name: "chromium", channel: "playwright-bundled" },
  os: { name: "ubuntu", versionRequirement: { kind: "exact", value: "24.04" }, architecture: "x64" },
  adapter: { kind: "software", vendor: "google", family: "swiftshader", backend: "swiftshader" },
  automation: { kind: "playwright" },
  timeoutMs: 10_000,
  blocking: true,
  countsTowardStableCoverage: false,
};

const matrix: StableWebGpuMatrixManifest = {
  contractVersion: "1.0.0",
  matrixId: "hosted-preflight-coverage",
  version: "1.0.0",
  policy: {
    coverage: "all-cells-required",
    unavailable: "fail",
    skipped: "fail",
    timeout: "fail",
    deviceLoss: "fail",
    requiredPhysicalCellCount: 15,
    requiredBlockingCellCount: 16,
  },
  cells: [cell],
};

async function scenario() {
  const matrixBytes = new TextEncoder().encode(JSON.stringify(matrix));
  const matrixSha256 = await computeSha256(matrixBytes);
  const trustedProvenance = provenance();
  const preflight: ShaderQualificationPreflightManifest = {
    contractVersion: SHADER_VALIDATION_EVIDENCE_VERSION,
    kind: "shader-qualification-preflight",
    qualificationId: "qualification.hosted-preflight",
    sourceBlob: {
      host: "account.blob.core.windows.net",
      versionId: "one",
      uri: "https://account.blob.core.windows.net/candidates/candidate.tar?versionid=one",
    },
    dataBundleSha256: ZERO_SHA,
    compileUnitInventorySha256: ZERO_SHA,
    matrixSha256,
    harnessSha256: ZERO_SHA,
    subjectBindingSha256: ZERO_SHA,
    provenance: trustedProvenance,
  };
  const environment = {
    PLASIUS_QUALIFICATION_ID: preflight.qualificationId,
    PLASIUS_CANDIDATE_BUNDLE_SHA256: preflight.dataBundleSha256,
    PLASIUS_MATRIX_SHA256: preflight.matrixSha256,
    PLASIUS_HARNESS_SHA256: preflight.harnessSha256,
    PLASIUS_SOURCE_BLOB_HOST: preflight.sourceBlob.host,
    PLASIUS_SOURCE_BLOB_VERSION_ID: preflight.sourceBlob.versionId,
    PLASIUS_SOURCE_BLOB_OIDC_VERIFIED_BY_PREPARE: "true",
    PLASIUS_SOURCE_BLOB_PREPARE_JOB: "prepare",
    PLASIUS_SOURCE_BLOB_PREPARE_OIDC_SUBJECT: preflight.provenance.oidcAttestation.subject,
    PLASIUS_SOURCE_BLOB_PREPARE_WORKFLOW_REF: preflight.provenance.workflowRef,
    PLASIUS_SOURCE_BLOB_PREPARE_WORKFLOW_SHA: preflight.provenance.workflowSha.hex,
    PLASIUS_CALLER_REPOSITORY: preflight.provenance.repository,
    PLASIUS_CALLER_SHA: preflight.provenance.commit.hex,
    PLASIUS_CALLER_REF: preflight.provenance.ref,
    PLASIUS_WORKFLOW_RUN_ID: preflight.provenance.runId,
    PLASIUS_WORKFLOW_RUN_ATTEMPT: String(preflight.provenance.runAttempt),
    PLASIUS_WORKFLOW_REPOSITORY: "Plasius-LTD/gpu-shader",
    PLASIUS_WORKFLOW_REF: preflight.provenance.workflowRef,
    PLASIUS_WORKFLOW_SHA: preflight.provenance.workflowSha.hex,
    RUNNER_NAME: "hosted-runner",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: "Linux",
    RUNNER_ARCH: "X64",
  };
  return { matrixBytes, preflight, environment };
}

describe("hosted SwiftShader runner preflight", () => {
  it("records the actual hosted image label and independently observed Playwright executable identity", async () => {
    const current = await scenario();
    const evidence = await createHostedSwiftShaderRunnerPreflight({
      matrix,
      matrixBytes: current.matrixBytes,
      cell,
      preflight: current.preflight,
      environment: current.environment,
    });

    expect(evidence).toMatchObject({
      qualificationId: current.preflight.qualificationId,
      cellId: cell.cellId,
      status: "available",
      runnerLabels: ["ubuntu-24.04"],
      matchedRunners: [{ name: "hosted-runner", labels: ["ubuntu-24.04"] }],
      adapterHarness: { id: "playwright-core", version: "1.62.1", sha256: "a".repeat(64) },
      producer: { job: "swiftshader", runner: { environment: "github-hosted", os: "Linux", architecture: "X64" } },
    });
  });

  it("rejects malformed, changed and scheduler-label-different matrix routes", async () => {
    const current = await scenario();
    await expect(createHostedSwiftShaderRunnerPreflight({
      matrix,
      matrixBytes: new TextEncoder().encode("not-json"),
      cell,
      preflight: current.preflight,
      environment: current.environment,
    })).rejects.toThrow(/not UTF-8 JSON/u);

    await expect(createHostedSwiftShaderRunnerPreflight({
      matrix,
      matrixBytes: new TextEncoder().encode(JSON.stringify({ ...matrix, matrixId: "changed" })),
      cell,
      preflight: current.preflight,
      environment: current.environment,
    })).rejects.toThrow(/matrix artifact differs/u);

    boundary.hostVersion = "24.10";
    await expect(createHostedSwiftShaderRunnerPreflight({
      matrix,
      matrixBytes: current.matrixBytes,
      cell,
      preflight: current.preflight,
      environment: current.environment,
    })).rejects.toThrow(/does not derive the fixed matrix scheduler label/u);
    boundary.hostVersion = "24.04";
  });
});
