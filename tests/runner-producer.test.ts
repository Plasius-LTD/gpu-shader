import { describe, expect, it } from "vitest";
import {
  SHADER_VALIDATION_EVIDENCE_VERSION,
  type ShaderQualificationPreflightManifest,
  type ShaderTrustedWorkflowProvenance,
} from "../src/contracts.js";
import { createQualificationExecutionProducer } from "../src/testing/runner/producer.js";

const callerCommit = "a".repeat(40);
const workflowCommit = "b".repeat(40);

function provenance(): ShaderTrustedWorkflowProvenance {
  return {
    repository: "Plasius-LTD/model-store",
    commit: { algorithm: "sha1", hex: callerCommit },
    ref: "refs/heads/shader-candidate",
    workflowRef: "Plasius-LTD/gpu-shader/.github/workflows/shader-qualification.yml@refs/heads/main",
    workflowSha: { algorithm: "sha1", hex: workflowCommit },
    runId: "2468",
    runAttempt: 2,
    job: "prepare",
    eventName: "workflow_call",
    oidcAttestation: {
      issuer: "https://token.actions.githubusercontent.com",
      subject: "repo:Plasius-LTD/model-store:ref:refs/heads/shader-candidate",
      audience: "api://AzureADTokenExchange",
      verifiedClaimsSha256: "c".repeat(64) as any,
      verifiedAt: "2026-07-13T12:00:00.000Z",
      source: "trusted-runner-preflight",
    },
  };
}

function preflight(): ShaderQualificationPreflightManifest {
  return {
    contractVersion: SHADER_VALIDATION_EVIDENCE_VERSION,
    kind: "shader-qualification-preflight",
    qualificationId: "qualification-1",
    sourceBlob: {
      host: "account.blob.core.windows.net",
      versionId: "one",
      uri: "https://account.blob.core.windows.net/candidates/candidate.tar?versionid=one",
    },
    dataBundleSha256: "d".repeat(64) as any,
    compileUnitInventorySha256: "e".repeat(64) as any,
    matrixSha256: "f".repeat(64) as any,
    harnessSha256: "1".repeat(64) as any,
    subjectBindingSha256: "2".repeat(64) as any,
    provenance: provenance(),
  };
}

function environment(): Record<string, string> {
  return {
    PLASIUS_CALLER_REPOSITORY: "Plasius-LTD/model-store",
    PLASIUS_CALLER_SHA: callerCommit,
    PLASIUS_CALLER_REF: "refs/heads/shader-candidate",
    PLASIUS_WORKFLOW_RUN_ID: "2468",
    PLASIUS_WORKFLOW_RUN_ATTEMPT: "2",
    PLASIUS_WORKFLOW_REPOSITORY: "Plasius-LTD/gpu-shader",
    PLASIUS_WORKFLOW_REF: "Plasius-LTD/gpu-shader/.github/workflows/shader-qualification.yml@refs/heads/main",
    PLASIUS_WORKFLOW_SHA: workflowCommit,
    RUNNER_NAME: "trusted-runner-7",
    RUNNER_ENVIRONMENT: "self-hosted",
    RUNNER_OS: "Linux",
    RUNNER_ARCH: "X64",
  };
}

describe("qualification execution producer", () => {
  it("separates controller host identity from the target-device result", () => {
    const producer = createQualificationExecutionProducer({
      preflight: preflight(),
      job: "physical",
      environment: environment(),
    });
    expect(producer.runner).toEqual({
      name: "trusted-runner-7",
      environment: "self-hosted",
      os: "Linux",
      architecture: "X64",
    });
  });

  it.each([
    ["PLASIUS_CALLER_SHA", "not-a-git-object"],
    ["PLASIUS_WORKFLOW_RUN_ATTEMPT", "0"],
    ["RUNNER_ENVIRONMENT", "candidate-selected"],
    ["PLASIUS_WORKFLOW_REPOSITORY", "Plasius-LTD/untrusted"],
  ])("rejects forged or missing %s", (name, value) => {
    const values = environment();
    values[name] = value;
    expect(() => createQualificationExecutionProducer({
      preflight: preflight(),
      job: "physical",
      environment: values,
    })).toThrow();
  });

  it("rejects producer identity that differs from preflight subject", () => {
    const values = environment();
    values.PLASIUS_CALLER_REPOSITORY = "Plasius-LTD/other";
    expect(() => createQualificationExecutionProducer({
      preflight: preflight(),
      job: "physical",
      environment: values,
    })).toThrow(/differs from the immutable qualification preflight/u);
  });
});
