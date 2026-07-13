import { describe, expect, it } from "vitest";
import {
  SHADER_VALIDATION_EVIDENCE_VERSION,
  STABLE_WEBGPU_MATRIX_VERSION,
  type ShaderQualificationPreflightManifest,
  type StableWebGpuMatrixCell,
  type StableWebGpuMatrixManifest,
} from "../src/contracts.js";
import { computeSha256 } from "../src/hash.js";
import { createTrustedWorkflowDiagnostic } from "../src/testing/runner/workflow-diagnostic.js";

const callerSha = "a".repeat(40);
const workflowSha = "b".repeat(40);

const cell: StableWebGpuMatrixCell = {
  cellId: "ubuntu-intel-chrome-vulkan",
  runnerLabels: ["self-hosted", "Linux", "X64", "physical-gpu", "gpu-intel", "vulkan"],
  browser: { name: "chrome", channel: "stable" },
  os: { name: "ubuntu", versionRequirement: { kind: "exact", value: "24.04" }, architecture: "x64" },
  adapter: { kind: "physical", vendor: "intel", family: "qualified-intel", backend: "vulkan" },
  automation: { kind: "playwright" },
  timeoutMs: 300_000,
  blocking: true,
  countsTowardStableCoverage: true,
};

const matrix: StableWebGpuMatrixManifest = {
  contractVersion: STABLE_WEBGPU_MATRIX_VERSION,
  matrixId: "test.matrix",
  version: "2026.07.13",
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

function environment(preflight: ShaderQualificationPreflightManifest): Record<string, string> {
  return {
    PLASIUS_CALLER_REPOSITORY: "Plasius-LTD/model-store",
    PLASIUS_CALLER_SHA: callerSha,
    PLASIUS_CALLER_REF: "refs/heads/candidate",
    PLASIUS_WORKFLOW_RUN_ID: "42",
    PLASIUS_WORKFLOW_RUN_ATTEMPT: "1",
    PLASIUS_WORKFLOW_REPOSITORY: "Plasius-LTD/gpu-shader",
    PLASIUS_WORKFLOW_REF: "Plasius-LTD/gpu-shader/.github/workflows/shader-qualification.yml@refs/heads/main",
    PLASIUS_WORKFLOW_SHA: workflowSha,
    RUNNER_NAME: "physical-1",
    RUNNER_ENVIRONMENT: "self-hosted",
    RUNNER_OS: "Linux",
    RUNNER_ARCH: "X64",
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
  };
}

async function setup(): Promise<{ preflight: ShaderQualificationPreflightManifest; matrixBytes: Uint8Array }> {
  const matrixBytes = new TextEncoder().encode(`${JSON.stringify(matrix, null, 4)}\n`);
  const preflight: ShaderQualificationPreflightManifest = {
    contractVersion: SHADER_VALIDATION_EVIDENCE_VERSION,
    kind: "shader-qualification-preflight",
    qualificationId: "qualification-test",
    sourceBlob: {
      host: "account.blob.core.windows.net",
      versionId: "one",
      uri: "https://account.blob.core.windows.net/candidates/shader.tar?versionid=one",
    },
    dataBundleSha256: "c".repeat(64) as any,
    compileUnitInventorySha256: "d".repeat(64) as any,
    matrixSha256: await computeSha256(matrixBytes),
    harnessSha256: "e".repeat(64) as any,
    subjectBindingSha256: "f".repeat(64) as any,
    provenance: {
      repository: "Plasius-LTD/model-store",
      commit: { algorithm: "sha1", hex: callerSha },
      ref: "refs/heads/candidate",
      workflowRef: "Plasius-LTD/gpu-shader/.github/workflows/shader-qualification.yml@refs/heads/main",
      workflowSha: { algorithm: "sha1", hex: workflowSha },
      runId: "42",
      runAttempt: 1,
      job: "prepare",
      eventName: "workflow_call",
      oidcAttestation: {
        issuer: "https://token.actions.githubusercontent.com",
        subject: "repo:Plasius-LTD/model-store:ref:refs/heads/candidate",
        audience: "api://AzureADTokenExchange",
        verifiedClaimsSha256: "1".repeat(64) as any,
        verifiedAt: "2026-07-13T10:00:00.000Z",
        source: "trusted-runner-preflight",
      },
    },
  };
  return { preflight, matrixBytes };
}

describe("trusted workflow diagnostics", () => {
  it("derives the actual physical cell producer and exact matrix identity", async () => {
    const { preflight, matrixBytes } = await setup();
    const diagnostic = await createTrustedWorkflowDiagnostic({
      matrix,
      matrixBytes,
      cell,
      preflight,
      status: "timeout",
      message: "Physical lane exceeded its fixed job timeout.",
      environment: environment(preflight),
    });
    expect(diagnostic.producer.job).toBe("physical");
    expect(diagnostic.matrixSha256).toBe(await computeSha256(matrixBytes));
  });

  it("rejects semantically equal but differently formatted matrix bytes", async () => {
    const { preflight } = await setup();
    const reformatted = new TextEncoder().encode(JSON.stringify(matrix));
    await expect(createTrustedWorkflowDiagnostic({
      matrix,
      matrixBytes: reformatted,
      cell,
      preflight,
      status: "failed",
      message: "runner failed",
      environment: environment(preflight),
    })).rejects.toThrow(/matrix differs/u);
  });
});
