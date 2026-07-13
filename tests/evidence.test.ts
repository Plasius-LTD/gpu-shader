import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { canonicalizeGpuContract } from "../src/canonical-json.js";
import {
  SHADER_VALIDATION_EVIDENCE_VERSION,
  type ShaderCellEvidence,
  type ShaderNonQualifyingWorkflowDiagnostic,
  type ShaderQualificationResult,
  type ShaderTrustedWorkflowProvenance,
  type ShaderValidationEvidence,
  type ShaderValidationEvidenceAttestationRef,
  type StableWebGpuMatrixManifest,
} from "../src/contracts.js";
import { computeSha256 } from "../src/hash.js";
import {
  aggregateShaderValidationEvidence,
  computeQualificationInventorySha256,
  computeQualificationSubjectBinding,
  createQualificationPreflight,
  parseShaderValidationEvidenceAttestationRef,
  parseTrustedWorkflowProvenance,
  validateShaderValidationEvidence,
  verifyShaderValidationEvidenceAttestation,
} from "../src/testing/evidence.js";
import {
  artifact,
  AUTOMATION_SHA,
  clone,
  evidenceScenario,
  ONE_SHA,
  provenance,
  qualificationBundle,
  TWO_SHA,
  ZERO_SHA,
} from "./fixtures.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

async function stableMatrixArtifact(): Promise<{
  readonly matrix: StableWebGpuMatrixManifest;
  readonly matrixBytes: Uint8Array;
}> {
  const matrixBytes = new Uint8Array(await readFile(
    new URL("../matrices/stable-webgpu-2026-07-13.json", import.meta.url),
  ));
  return {
    matrix: JSON.parse(new TextDecoder().decode(matrixBytes)) as StableWebGpuMatrixManifest,
    matrixBytes,
  };
}

async function aggregatePassing() {
  const { matrix, matrixBytes } = await stableMatrixArtifact();
  const scenario = await evidenceScenario(matrix, matrixBytes);
  const evidence = await aggregateShaderValidationEvidence({
    bundle: scenario.bundle,
    matrix,
    matrixBytes,
    preflight: scenario.preflightArtifact,
    cellEvidence: scenario.cellEvidence,
    runnerPreflights: scenario.runnerPreflights,
    workflowDiagnostics: [],
    harness: scenario.harness,
    packageVersion: "0.1.0-test",
    generatedAt: "2026-07-13T12:05:00.000Z",
  });
  return { matrix, matrixBytes, scenario, evidence };
}

describe("trusted qualification preflight", () => {
  it("binds exact inventory, bundle, matrix and harness identities", async () => {
    const { matrix, matrixBytes } = await stableMatrixArtifact();
    const bundle = await qualificationBundle(matrix);
    const matrixSha256 = await computeSha256(matrixBytes);
    const preflight = await createQualificationPreflight({
      qualificationId: "qualification.preflight",
      bundle,
      matrix,
      matrixBytes,
      sourceUri: "https://account.blob.core.windows.net/candidates/shader.tar?versionid=immutable-one",
      dataBundleSha256: TWO_SHA,
      matrixSha256,
      harnessSha256: ONE_SHA,
      provenance: provenance(),
    });
    const inventorySha256 = await computeQualificationInventorySha256(bundle);
    const subjectBindingSha256 = await computeQualificationSubjectBinding({
      subject: bundle.subject,
      dataBundleSha256: TWO_SHA,
      compileUnitInventorySha256: inventorySha256,
      matrixSha256,
      harnessSha256: ONE_SHA,
    });
    expect(preflight.compileUnitInventorySha256).toBe(inventorySha256);
    expect(preflight.subjectBindingSha256).toBe(subjectBindingSha256);
    expect(preflight.sourceBlob).toEqual({
      host: "account.blob.core.windows.net",
      versionId: "immutable-one",
      uri: "https://account.blob.core.windows.net/candidates/shader.tar?versionid=immutable-one",
    });
  });

  it("binds the exact pretty-printed matrix artifact instead of a canonical reserialization", async () => {
    const { matrix, matrixBytes } = await stableMatrixArtifact();
    const canonicalBytes = new TextEncoder().encode(canonicalizeGpuContract(matrix));
    const matrixSha256 = await computeSha256(matrixBytes);
    expect(await computeSha256(canonicalBytes)).not.toBe(matrixSha256);

    await expect(createQualificationPreflight({
      qualificationId: "qualification.matrix-bytes",
      bundle: await qualificationBundle(matrix),
      matrix,
      matrixBytes: canonicalBytes,
      sourceUri: "https://account.blob.core.windows.net/candidates/shader.tar?versionid=immutable-one",
      dataBundleSha256: TWO_SHA,
      matrixSha256,
      harnessSha256: ONE_SHA,
      provenance: provenance(),
    })).rejects.toThrow(/matrix.*(?:artifact|digest|bytes)/u);

    const scenario = await evidenceScenario(matrix, matrixBytes);
    await expect(aggregateShaderValidationEvidence({
      bundle: scenario.bundle,
      matrix,
      matrixBytes: canonicalBytes,
      preflight: scenario.preflightArtifact,
      cellEvidence: scenario.cellEvidence,
      runnerPreflights: scenario.runnerPreflights,
      workflowDiagnostics: [],
      harness: scenario.harness,
      packageVersion: "0.1.0-test",
      generatedAt: "2026-07-13T12:05:00.000Z",
    })).rejects.toThrow(/matrix.*(?:artifact|digest|bytes)/u);

    const evidence = await aggregateShaderValidationEvidence({
      bundle: scenario.bundle,
      matrix,
      matrixBytes,
      preflight: scenario.preflightArtifact,
      cellEvidence: scenario.cellEvidence,
      runnerPreflights: scenario.runnerPreflights,
      workflowDiagnostics: [],
      harness: scenario.harness,
      packageVersion: "0.1.0-test",
      generatedAt: "2026-07-13T12:05:00.000Z",
    });
    const final = await validateShaderValidationEvidence({
      evidence,
      bundle: scenario.bundle,
      matrix,
      matrixBytes: canonicalBytes,
    });
    expect(final.ok).toBe(false);
    if (!final.ok) expect(final.diagnostics[0]?.message).toMatch(/matrix.*(?:artifact|digest|bytes)/u);
  });

  it.each([
    "http://account.blob.core.windows.net/candidates/a.tar?versionid=one",
    "https://user:password@account.blob.core.windows.net/candidates/a.tar?versionid=one",
    "https://account.blob.core.windows.net/candidates/a.tar",
    "https://account.blob.core.windows.net/candidates/a.tar?versionid=one&versionid=two",
    "https://account.blob.core.windows.net/candidates/a.tar?versionid=one&sig=secret",
    "https://account.blob.core.windows.net/candidates/a.tar?versionid=one#fragment",
    "https://evil.example.invalid/candidates/a.tar?versionid=one",
    "https://account.blob.core.windows.net/candidates/a.tar?versionid=one&unbound=value",
  ])("rejects non-exact source archive URI %s", async (sourceUri) => {
    const { matrix, matrixBytes } = await stableMatrixArtifact();
    await expect(createQualificationPreflight({
      qualificationId: "qualification.uri",
      bundle: await qualificationBundle(matrix),
      matrix,
      matrixBytes,
      sourceUri,
      dataBundleSha256: ZERO_SHA,
      matrixSha256: ZERO_SHA,
      harnessSha256: ONE_SHA,
      provenance: provenance(),
    })).rejects.toThrow();
  });

  it("rejects stale inventory and incomplete cell identities before any runner starts", async () => {
    const { matrix, matrixBytes } = await stableMatrixArtifact();
    const matrixSha256 = await computeSha256(matrixBytes);
    const staleInventory = await qualificationBundle(matrix);
    (staleInventory.subject as Mutable<typeof staleInventory.subject>).compileUnitInventorySha256 = ZERO_SHA;
    await expect(createQualificationPreflight({
      qualificationId: "qualification.stale",
      bundle: staleInventory,
      matrix,
      matrixBytes,
      sourceUri: "https://account.blob.core.windows.net/candidates/a.tar?versionid=one",
      dataBundleSha256: ZERO_SHA,
      matrixSha256,
      harnessSha256: ONE_SHA,
      provenance: provenance(),
    })).rejects.toThrow(/stale compile-unit inventory/u);

    const incomplete = await qualificationBundle(matrix);
    (incomplete.subject as Mutable<typeof incomplete.subject>).requiredCellIds = incomplete.subject.requiredCellIds.slice(1);
    await expect(createQualificationPreflight({
      qualificationId: "qualification.incomplete",
      bundle: incomplete,
      matrix,
      matrixBytes,
      sourceUri: "https://account.blob.core.windows.net/candidates/a.tar?versionid=one",
      dataBundleSha256: ZERO_SHA,
      matrixSha256,
      harnessSha256: ONE_SHA,
      provenance: provenance(),
    })).rejects.toThrow(/cell set differs/u);
  });
});

describe("qualification evidence aggregation and validation", () => {
  it("round-trips an exact 1 compile-unit × 16-cell passed Cartesian product", async () => {
    const { matrix, matrixBytes, scenario, evidence } = await aggregatePassing();
    expect(evidence.status).toBe("passed");
    expect(evidence.counts).toEqual({ compileUnits: 1, cells: 16, expectedResults: 16, passedResults: 16 });
    expect(evidence.results).toHaveLength(16);
    expect(evidence.cellRuns).toHaveLength(16);
    expect(evidence.evidenceId).toMatch(/^qualification-[a-f0-9]{24}$/u);
    const validated = await validateShaderValidationEvidence({ evidence, bundle: scenario.bundle, matrix, matrixBytes });
    expect(validated.ok).toBe(true);
  });

  it("accepts an actual physical runner label set that strictly contains its routing labels", async () => {
    const { matrix, scenario, evidence } = await aggregatePassing();
    const cell = matrix.cells.find((candidate) => candidate.cellId === "ubuntu-intel-chrome-vulkan")!;
    const preflight = scenario.runnerPreflights.find((candidate) => candidate.value.cellId === cell.cellId)!.value;
    const matched = preflight.matchedRunners[0]!;
    const result = evidence.results.find((candidate) => candidate.cellId === cell.cellId)!;

    expect(preflight.runnerLabels).toEqual(cell.runnerLabels);
    expect(matched.labels).toEqual([...cell.runnerLabels, "fleet-observed"]);
    expect(matched.labels.length).toBeGreaterThan(cell.runnerLabels.length);
    expect(result.observed.runner).toEqual({ id: matched.name, labels: matched.labels });
  });

  it("retains an execution-bound automation hash when physical preflight cannot observe the adapter", async () => {
    const { matrix, matrixBytes, scenario, evidence } = await aggregatePassing();
    const cellId = "ubuntu-intel-chrome-vulkan";
    const preflight = scenario.runnerPreflights.find((candidate) => candidate.value.cellId === cellId)!.value;
    const cell = scenario.cellEvidence.find((candidate) => candidate.value.cellId === cellId)!.value;
    const run = evidence.cellRuns.find((candidate) => candidate.cellId === cellId)!;

    expect(preflight.adapterHarness).toBeNull();
    expect(cell.automation.sha256).toBe(AUTOMATION_SHA);
    expect(run.automation).toEqual(cell.automation);

    const changed = clone(evidence) as Mutable<ShaderValidationEvidence>;
    const changedRun = changed.cellRuns.find((candidate) => candidate.cellId === cellId)!;
    if (!changedRun.automation) throw new Error("Completed physical run must retain automation identity.");
    (changedRun.automation as Mutable<NonNullable<typeof changedRun.automation>>).sha256 = ZERO_SHA;
    expect((await validateShaderValidationEvidence({
      evidence: changed,
      bundle: scenario.bundle,
      matrix,
      matrixBytes,
    })).ok).toBe(false);
  });

  it.each([
    ["swiftshader.chromium.ubuntu-x64", "swiftshader"],
    ["ubuntu-intel-chrome-vulkan", "physical"],
  ] as const)("attributes %s diagnostics to the actual %s execution job", async (cellId, expectedJob) => {
    const { matrix, matrixBytes } = await stableMatrixArtifact();
    const scenario = await evidenceScenario(matrix, matrixBytes);
    const cellIndex = scenario.cellEvidence.findIndex((candidate) => candidate.value.cellId === cellId);
    const producer = scenario.cellEvidence[cellIndex]!.value.producer;
    const diagnostic: ShaderNonQualifyingWorkflowDiagnostic = {
      contractVersion: SHADER_VALIDATION_EVIDENCE_VERSION,
      kind: "non-qualifying-workflow-diagnostic",
      qualificationId: scenario.preflight.qualificationId,
      cellId,
      status: "timeout",
      matrixSha256: scenario.preflight.matrixSha256,
      message: "Trusted execution exceeded its bounded deadline.",
      qualificationPreflightProvenance: scenario.preflight.provenance,
      producer,
    };
    const evidence = await aggregateShaderValidationEvidence({
      bundle: scenario.bundle,
      matrix,
      matrixBytes,
      preflight: scenario.preflightArtifact,
      cellEvidence: scenario.cellEvidence.filter((_, index) => index !== cellIndex),
      runnerPreflights: scenario.runnerPreflights,
      workflowDiagnostics: [await artifact(diagnostic)],
      harness: scenario.harness,
      packageVersion: "0.1.0-test",
      generatedAt: "2026-07-13T12:05:00.000Z",
    });
    const run = evidence.cellRuns.find((candidate) => candidate.cellId === cellId)!;

    expect(evidence.status).toBe("failed");
    expect(run.source).toBe("workflow-diagnostic");
    expect(run.producer.job).toBe(expectedJob);
    expect(run.automation).toBeNull();
  });

  it("rejects raw artifact byte/digest mismatch and value/byte substitution", async () => {
    const { matrix, matrixBytes } = await stableMatrixArtifact();
    const scenario = await evidenceScenario(matrix, matrixBytes);
    const bytesChanged = {
      ...scenario.preflightArtifact,
      bytes: Uint8Array.of(...scenario.preflightArtifact.bytes, 0),
    };
    await expect(aggregateShaderValidationEvidence({
      bundle: scenario.bundle,
      matrix,
      matrixBytes,
      preflight: bytesChanged,
      cellEvidence: scenario.cellEvidence,
      runnerPreflights: scenario.runnerPreflights,
      workflowDiagnostics: [],
      harness: scenario.harness,
      packageVersion: "0.1.0-test",
      generatedAt: "2026-07-13T12:05:00.000Z",
    })).rejects.toThrow(/artifact digest/u);

    const substitutedValue = clone(scenario.preflight);
    (substitutedValue as Mutable<typeof substitutedValue>).qualificationId = "qualification.substituted";
    await expect(aggregateShaderValidationEvidence({
      bundle: scenario.bundle,
      matrix,
      matrixBytes,
      preflight: { ...scenario.preflightArtifact, value: substitutedValue },
      cellEvidence: scenario.cellEvidence,
      runnerPreflights: scenario.runnerPreflights,
      workflowDiagnostics: [],
      harness: scenario.harness,
      packageVersion: "0.1.0-test",
      generatedAt: "2026-07-13T12:05:00.000Z",
    })).rejects.toThrow(/exact bytes|artifact.*value|qualification/u);
  });

  it("rejects stale cell matrix identity even when an attacker recomputes that artifact digest", async () => {
    const { matrix, matrixBytes } = await stableMatrixArtifact();
    const scenario = await evidenceScenario(matrix, matrixBytes);
    const changed = clone(scenario.cellEvidence[0]!.value);
    (changed as Mutable<ShaderCellEvidence>).matrixId = "different-matrix";
    const cellEvidence = [await artifact(changed), ...scenario.cellEvidence.slice(1)];
    await expect(aggregateShaderValidationEvidence({
      bundle: scenario.bundle,
      matrix,
      matrixBytes,
      preflight: scenario.preflightArtifact,
      cellEvidence,
      runnerPreflights: scenario.runnerPreflights,
      workflowDiagnostics: [],
      harness: scenario.harness,
      packageVersion: "0.1.0-test",
      generatedAt: "2026-07-13T12:05:00.000Z",
    })).rejects.toThrow(/matrix/u);
  });

  it("rejects per-cell OS/browser/adapter-family/automation route mismatches", async () => {
    const { matrix, matrixBytes } = await stableMatrixArtifact();
    const scenario = await evidenceScenario(matrix, matrixBytes);
    const mutations: ((value: Mutable<ShaderCellEvidence>) => void)[] = [
      (value) => { (value.results[0]!.observed.os as Mutable<typeof value.results[number]["observed"]["os"]>).name = "wrong-os"; },
      (value) => { (value.results[0]!.observed.browser as Mutable<typeof value.results[number]["observed"]["browser"]>).channel = "wrong-channel"; },
      (value) => { (value.results[0]!.observed.adapter as Mutable<typeof value.results[number]["observed"]["adapter"]>).family = "wrong-family"; },
      (value) => { (value.automation as Mutable<typeof value.automation>).kind = "webdriver"; },
    ];
    for (const mutate of mutations) {
      const changed = clone(scenario.cellEvidence[0]!.value) as Mutable<ShaderCellEvidence>;
      mutate(changed);
      const cellEvidence = [await artifact(changed), ...scenario.cellEvidence.slice(1)];
      await expect(aggregateShaderValidationEvidence({
        bundle: scenario.bundle,
        matrix,
        matrixBytes,
        preflight: scenario.preflightArtifact,
        cellEvidence,
        runnerPreflights: scenario.runnerPreflights,
        workflowDiagnostics: [],
        harness: scenario.harness,
        packageVersion: "0.1.0-test",
        generatedAt: "2026-07-13T12:05:00.000Z",
      })).rejects.toThrow();
    }
  });

  it("accepts concrete target OS builds while keeping controller-host identity separate", async () => {
    const { evidence } = await aggregatePassing();
    const android = evidence.results.find((result) => result.cellId === "android-adreno-chrome-vulkan")!;
    const chromeOs = evidence.results.find((result) => result.cellId === "chromeos-arm-chrome-vulkan")!;
    const windows = evidence.results.find((result) => result.cellId === "win11-intel-chrome-d3d12")!;
    const apple = evidence.results.find((result) => result.cellId === "ios-iphone-safari-metal")!;
    const androidRun = evidence.cellRuns.find((run) => run.cellId === android.cellId)!;

    expect(android.observed.os).toMatchObject({ name: "android", version: "12.1", channel: null });
    expect(chromeOs.observed.os).toMatchObject({ name: "chromeos", version: "16093.59.0", channel: "stable" });
    expect(windows.observed.os).toMatchObject({ name: "windows", version: "11.0.26100", channel: null });
    expect(apple.observed.os).toMatchObject({ name: "ios", version: "26.1", channel: null });
    expect(androidRun.producer.runner).toMatchObject({ os: "ubuntu", architecture: "x64" });
    expect(androidRun.producer.runner.os).not.toBe(android.observed.os.name);
  });

  it("rejects policy literals, unknown builds, wrong majors, and controller OS substituted as target OS", async () => {
    const { matrix, matrixBytes } = await stableMatrixArtifact();
    const scenario = await evidenceScenario(matrix, matrixBytes);
    const cases: readonly {
      readonly name: string;
      readonly cellId: string;
      readonly mutate: (os: Mutable<ShaderQualificationResult["observed"]["os"]>) => void;
    }[] = [
      { name: "Android requirement literal", cellId: "android-adreno-chrome-vulkan", mutate: (os) => { os.version = "12+"; } },
      { name: "Android below minimum", cellId: "android-adreno-chrome-vulkan", mutate: (os) => { os.version = "11.9"; } },
      { name: "Android unknown version", cellId: "android-adreno-chrome-vulkan", mutate: (os) => { os.version = "unknown"; } },
      { name: "Android unexpected channel", cellId: "android-adreno-chrome-vulkan", mutate: (os) => { os.channel = "stable"; } },
      { name: "controller host substituted for Android target", cellId: "android-adreno-chrome-vulkan", mutate: (os) => { os.name = "ubuntu"; os.version = "24.04"; } },
      { name: "ChromeOS policy literal", cellId: "chromeos-arm-chrome-vulkan", mutate: (os) => { os.version = "stable"; } },
      { name: "ChromeOS missing stable channel", cellId: "chromeos-arm-chrome-vulkan", mutate: (os) => { os.channel = null; } },
      { name: "Windows wrong major", cellId: "win11-intel-chrome-d3d12", mutate: (os) => { os.version = "10.0.19045"; } },
      { name: "Windows unknown version", cellId: "win11-intel-chrome-d3d12", mutate: (os) => { os.version = "unknown"; } },
      { name: "Apple wrong major", cellId: "ios-iphone-safari-metal", mutate: (os) => { os.version = "25.9"; } },
      { name: "Apple unknown version", cellId: "ios-iphone-safari-metal", mutate: (os) => { os.version = "unknown"; } },
      { name: "Ubuntu exact requirement", cellId: "ubuntu-intel-chrome-vulkan", mutate: (os) => { os.version = "24.04.1"; } },
    ];
    for (const testCase of cases) {
      const index = scenario.cellEvidence.findIndex((candidate) => candidate.value.cellId === testCase.cellId);
      const changed = clone(scenario.cellEvidence[index]!.value) as Mutable<ShaderCellEvidence>;
      testCase.mutate(changed.results[0]!.observed.os as Mutable<ShaderQualificationResult["observed"]["os"]>);
      const cellEvidence = [...scenario.cellEvidence];
      cellEvidence[index] = await artifact(changed);
      await expect(aggregateShaderValidationEvidence({
        bundle: scenario.bundle,
        matrix,
        matrixBytes,
        preflight: scenario.preflightArtifact,
        cellEvidence,
        runnerPreflights: scenario.runnerPreflights,
        workflowDiagnostics: [],
        harness: scenario.harness,
        packageVersion: "0.1.0-test",
        generatedAt: "2026-07-13T12:05:00.000Z",
      }), testCase.name).rejects.toThrow(/OS target|version requirement/u);
    }
  });

  it("recomputes matrix/inventory/subject/evidence identities during final validation", async () => {
    const { matrix, matrixBytes, scenario, evidence } = await aggregatePassing();
    const mutations: ((value: Mutable<ShaderValidationEvidence>) => void)[] = [
      (value) => { (value.matrixRef as Mutable<typeof value.matrixRef>).sha256 = ZERO_SHA; },
      (value) => { (value.matrixRef as Mutable<typeof value.matrixRef>).matrixId = "other"; },
      (value) => { (value.matrixRef as Mutable<typeof value.matrixRef>).version = "other"; },
      (value) => { value.evidenceId = "qualification-forged"; },
      (value) => { (value.subject as Mutable<typeof value.subject>).compileUnitInventorySha256 = ZERO_SHA; },
      (value) => { (value.subject as Mutable<typeof value.subject>).dataBundleSha256 = ZERO_SHA; },
    ];
    for (const mutate of mutations) {
      const changed = clone(evidence) as Mutable<ShaderValidationEvidence>;
      mutate(changed);
      const result = await validateShaderValidationEvidence({ evidence: changed, bundle: scenario.bundle, matrix, matrixBytes });
      expect(result.ok).toBe(false);
    }
  });

  it("cross-links every cellRun source/status/digest/provenance/driver to its results", async () => {
    const { matrix, matrixBytes, scenario, evidence } = await aggregatePassing();
    const mutations: readonly {
      readonly name: string;
      readonly mutate: (value: Mutable<ShaderValidationEvidence>) => void;
    }[] = [
      { name: "source", mutate: (value) => { (value.cellRuns[0] as Mutable<typeof value.cellRuns[number]>).source = "runner-preflight"; } },
      { name: "status", mutate: (value) => { (value.cellRuns[0] as Mutable<typeof value.cellRuns[number]>).status = "runner-unavailable"; } },
      { name: "source artifact digest", mutate: (value) => { (value.cellRuns[0] as Mutable<typeof value.cellRuns[number]>).sourceArtifactSha256 = ZERO_SHA; } },
      { name: "automation driver", mutate: (value) => {
        const automation = value.cellRuns[0]!.automation;
        if (!automation) throw new Error("Passing cell run must retain automation identity.");
        (automation as Mutable<NonNullable<typeof value.cellRuns[number]["automation"]>>).driver = "different-driver";
      } },
      { name: "preflight provenance", mutate: (value) => { (value.cellRuns[0]!.qualificationPreflightProvenance as Mutable<ShaderTrustedWorkflowProvenance>).runId = "other-run"; } },
    ];
    for (const { name, mutate } of mutations) {
      const changed = clone(evidence) as Mutable<ShaderValidationEvidence>;
      mutate(changed);
      const result = await validateShaderValidationEvidence({ evidence: changed, bundle: scenario.bundle, matrix, matrixBytes });
      expect(result.ok, name).toBe(false);
    }
  });

  it("rejects duplicated/missing result cells and any skipped result in a required gate", async () => {
    const { matrix, matrixBytes, scenario, evidence } = await aggregatePassing();
    const duplicated = clone(evidence) as Mutable<ShaderValidationEvidence>;
    duplicated.results = [duplicated.results[0]!, duplicated.results[0]!, ...duplicated.results.slice(2)];
    expect((await validateShaderValidationEvidence({ evidence: duplicated, bundle: scenario.bundle, matrix, matrixBytes })).ok).toBe(false);

    const skipped = clone(evidence) as Mutable<ShaderValidationEvidence>;
    (skipped.results[0] as Mutable<typeof skipped.results[number]>).status = "skipped";
    expect((await validateShaderValidationEvidence({ evidence: skipped, bundle: scenario.bundle, matrix, matrixBytes })).ok).toBe(false);
  });
});

describe("trusted workflow provenance and external attestation", () => {
  it("strictly parses Git object algorithms and GitHub OIDC preflight provenance", () => {
    expect(parseTrustedWorkflowProvenance(provenance())).toEqual(provenance());
    const wrongLength = clone(provenance());
    (wrongLength.commit as Mutable<typeof wrongLength.commit>).hex = "a".repeat(64);
    expect(() => parseTrustedWorkflowProvenance(wrongLength)).toThrow(/algorithm/u);

    const wrongIssuer = clone(provenance());
    (wrongIssuer.oidcAttestation as Mutable<typeof wrongIssuer.oidcAttestation>).issuer = "https://evil.invalid" as typeof wrongIssuer.oidcAttestation.issuer;
    expect(() => parseTrustedWorkflowProvenance(wrongIssuer)).toThrow(/trusted-preflight/u);
  });

  it("verifies exact evidence/bundle bytes and a cryptographic provenance callback", async () => {
    const evidenceBytes = new TextEncoder().encode("evidence");
    const bundleBytes = new TextEncoder().encode("bundle");
    const ref: ShaderValidationEvidenceAttestationRef = {
      contractVersion: SHADER_VALIDATION_EVIDENCE_VERSION,
      kind: "shader-validation-evidence-attestation-ref",
      evidence: { name: "evidence.json", sha256: await computeSha256(evidenceBytes) },
      attestation: {
        id: "attestation-1",
        url: "https://github.com/Plasius-LTD/model-store/attestations/1",
        bundle: { name: "attestation.json", sha256: await computeSha256(bundleBytes) },
      },
      producer: {
        repository: "Plasius-LTD/model-store",
        runId: "123",
        runAttempt: 1,
        trustedWorkflowRepository: "Plasius-LTD/gpu-shader",
        trustedWorkflowRef: "Plasius-LTD/gpu-shader/.github/workflows/shader-qualification.yml@refs/heads/main",
        trustedWorkflowSha: { algorithm: "sha1", hex: "b".repeat(40) },
      },
    };
    expect(parseShaderValidationEvidenceAttestationRef(ref)).toEqual(ref);
    const callback = vi.fn(async () => true);
    const verified = await verifyShaderValidationEvidenceAttestation({
      ref,
      evidenceBytes,
      bundleBytes,
      verifyCryptographicBundle: callback,
    });
    expect(verified.ok).toBe(true);
    expect(callback).toHaveBeenCalledOnce();

    expect((await verifyShaderValidationEvidenceAttestation({
      ref,
      evidenceBytes: Uint8Array.of(1),
      bundleBytes,
      verifyCryptographicBundle: callback,
    })).ok).toBe(false);
    expect((await verifyShaderValidationEvidenceAttestation({
      ref,
      evidenceBytes,
      bundleBytes,
      verifyCryptographicBundle: async () => false,
    })).ok).toBe(false);
  });

  it("rejects post-aggregate automation-driver mutation against the attested evidence digest", async () => {
    const { evidence, scenario } = await aggregatePassing();
    const evidenceBytes = new TextEncoder().encode(canonicalizeGpuContract(evidence));
    const bundleBytes = new TextEncoder().encode(canonicalizeGpuContract(scenario.bundle));
    const ref: ShaderValidationEvidenceAttestationRef = {
      contractVersion: SHADER_VALIDATION_EVIDENCE_VERSION,
      kind: "shader-validation-evidence-attestation-ref",
      evidence: { name: "evidence.json", sha256: await computeSha256(evidenceBytes) },
      attestation: {
        id: "attestation-driver-binding",
        url: "https://github.com/Plasius-LTD/model-store/attestations/driver-binding",
        bundle: { name: "attestation.json", sha256: await computeSha256(bundleBytes) },
      },
      producer: {
        repository: "Plasius-LTD/model-store",
        runId: "123",
        runAttempt: 1,
        trustedWorkflowRepository: "Plasius-LTD/gpu-shader",
        trustedWorkflowRef: "Plasius-LTD/gpu-shader/.github/workflows/shader-qualification.yml@refs/heads/main",
        trustedWorkflowSha: { algorithm: "sha1", hex: "b".repeat(40) },
      },
    };
    const changed = clone(evidence) as Mutable<ShaderValidationEvidence>;
    const automation = changed.cellRuns[0]!.automation;
    if (!automation) throw new Error("Passing cell run must retain automation identity.");
    (automation as Mutable<NonNullable<typeof changed.cellRuns[number]["automation"]>>).driver = "forged-driver";
    const changedBytes = new TextEncoder().encode(canonicalizeGpuContract(changed));
    const verifier = vi.fn(async () => true);
    const result = await verifyShaderValidationEvidenceAttestation({
      ref,
      evidenceBytes: changedBytes,
      bundleBytes,
      verifyCryptographicBundle: verifier,
    });
    expect(result.ok).toBe(false);
    expect(verifier).not.toHaveBeenCalled();
  });

  it("rejects untrusted caller and workflow identities", async () => {
    const base: ShaderValidationEvidenceAttestationRef = {
      contractVersion: SHADER_VALIDATION_EVIDENCE_VERSION,
      kind: "shader-validation-evidence-attestation-ref",
      evidence: { name: "evidence.json", sha256: ZERO_SHA },
      attestation: {
        id: "attestation-1",
        url: "https://github.com/Plasius-LTD/model-store/attestations/1",
        bundle: { name: "bundle.json", sha256: ONE_SHA },
      },
      producer: {
        repository: "Plasius-LTD/model-store",
        runId: "123",
        runAttempt: 1,
        trustedWorkflowRepository: "Plasius-LTD/gpu-shader",
        trustedWorkflowRef: "Plasius-LTD/gpu-shader/.github/workflows/shader-qualification.yml@refs/heads/main",
        trustedWorkflowSha: { algorithm: "sha1", hex: "b".repeat(40) },
      },
    };
    const outsider = clone(base);
    (outsider.producer as Mutable<typeof outsider.producer>).repository = "attacker/repo";
    expect(() => parseShaderValidationEvidenceAttestationRef(outsider)).toThrow(/outside Plasius-LTD/u);

    const wrongWorkflow = clone(base);
    (wrongWorkflow.producer as Mutable<typeof wrongWorkflow.producer>).trustedWorkflowRef =
      "Plasius-LTD/gpu-shader/.github/workflows/untrusted.yml@refs/heads/main";
    expect(() => parseShaderValidationEvidenceAttestationRef(wrongWorkflow)).toThrow(/workflow/u);

    const wrongHost = clone(base);
    (wrongHost.attestation as Mutable<typeof wrongHost.attestation>).url = "https://evil.invalid/attestation";
    expect(() => parseShaderValidationEvidenceAttestationRef(wrongHost)).toThrow(/GitHub|trusted/u);
  });
});
