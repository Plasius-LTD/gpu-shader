import { describe, expect, it, vi } from "vitest";

import { canonicalizeGpuContract } from "../src/canonical-json.js";
import { createGpuRecordCodec } from "../src/codec/codec.js";
import {
  SHADER_VALIDATION_EVIDENCE_VERSION,
  type ShaderQualificationPhaseEvidence,
  type ShaderQualificationPreflightManifest,
  type ShaderRunnerCellPreflightEvidence,
  type ShaderVersionManifestCore,
  type StableWebGpuMatrixCell,
  type StableWebGpuMatrixManifest,
} from "../src/contracts.js";
import { computeSha256 } from "../src/hash.js";
import type { AdmittedQualificationBundle } from "../src/node/bundle-admission.js";
import {
  computeQualificationInventorySha256,
  computeQualificationSubjectBinding,
} from "../src/testing/evidence.js";
import { runTrustedQualificationCell } from "../src/testing/runner/cell-runner.js";
import {
  assertTrustedPreflightEnvironment,
  createHostedSwiftShaderRunnerPreflight,
  validateTrustedCellIdentity,
} from "../src/testing/runner/identity.js";
import type {
  TrustedAdapterUnitResult,
  TrustedQualificationAdapter,
  TrustedQualificationAdapterFactory,
} from "../src/testing/runner/types.js";
import {
  actualRunnerLabels,
  AUTOMATION_SHA,
  clone,
  type DeepMutable,
  executionProducer,
  provenance,
  qualificationBundle,
  shaderAssets,
  validInventory,
  validQualificationFixture,
  ZERO_SHA,
} from "./fixtures.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const cell: StableWebGpuMatrixCell = {
  cellId: "swiftshader.chromium.ubuntu-x64",
  runnerLabels: ["ubuntu-24.04"],
  browser: { name: "chromium", channel: "playwright-bundled" },
  os: {
    name: "ubuntu",
    versionRequirement: { kind: "exact", value: "24.04" },
    architecture: "x64",
  },
  adapter: {
    kind: "software",
    vendor: "google",
    family: "swiftshader",
    backend: "swiftshader",
  },
  automation: { kind: "playwright" },
  timeoutMs: 10_000,
  blocking: true,
  countsTowardStableCoverage: false,
};

const matrix: StableWebGpuMatrixManifest = {
  contractVersion: "1.0.0",
  matrixId: "coverage-matrix",
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

interface Scenario {
  readonly admitted: AdmittedQualificationBundle;
  readonly matrixBytes: Uint8Array;
  readonly preflight: ShaderQualificationPreflightManifest;
  readonly runnerPreflight: ShaderRunnerCellPreflightEvidence;
  readonly environment: Record<string, string>;
}

async function scenario(): Promise<Scenario> {
  const assets = await shaderAssets();
  const inventory = clone(validInventory());
  const unit = inventory.compileUnits[0] as Mutable<typeof inventory.compileUnits[number]>;
  unit.interfaceRef = assets.interfaceRef;
  unit.modules = [{
    moduleId: "compute",
    sha256: assets.moduleSha256,
    assembly: { kind: "concat-v1", fragmentIds: ["fragment.main"] },
  }];
  (inventory.fragments[0] as Mutable<typeof inventory.fragments[number]>).sha256 = assets.moduleSha256;
  const manifest = clone(await qualificationBundle(matrix));
  (manifest as Mutable<typeof manifest>).inventory = inventory;
  (manifest as Mutable<typeof manifest>).modules = [{
    moduleId: "compute",
    path: "wgsl/main.wgsl",
    sha256: assets.moduleSha256,
  }];
  const inventorySha256 = await computeSha256(canonicalizeGpuContract(inventory));
  (manifest.subject as Mutable<typeof manifest.subject>).compileUnitInventorySha256 = inventorySha256;
  (manifest.subject as Mutable<typeof manifest.subject>).interfaceManifestSha256 = assets.interfaceRef.manifestSha256;
  (manifest.subject as Mutable<typeof manifest.subject>).modelAbiHashes = [assets.gpuInterface.modelAbiHash];
  (manifest.subject as Mutable<typeof manifest.subject>).modules = [{ moduleId: "compute", sha256: assets.moduleSha256 }];
  (manifest.subject as Mutable<typeof manifest.subject>).requiredCellIds = [cell.cellId];

  const shader = clone(assets.shaderManifest);
  (shader as Mutable<typeof shader>).requirements = {
    ...assets.shaderManifest.requirements,
    limits: [
      ...assets.shaderManifest.requirements.limits,
      { name: "maxBufferSize", comparator: "at-most", value: 1_024 },
    ],
    formats: [],
  };
  const shaderManifestCore = Object.fromEntries(
    Object.entries(shader).filter(([key]) => key !== "validationEvidence" && key !== "additionalValidationEvidence"),
  ) as unknown as ShaderVersionManifestCore;
  const fixture = validQualificationFixture();
  const admitted: AdmittedQualificationBundle = {
    root: "/trusted/fixture",
    manifest,
    shaderManifestCore,
    fixtures: new Map([[fixture.fixtureId, fixture]]),
    gpuInterface: assets.gpuInterface,
    modelFixtures: new Map([["model.fixture", assets.model]]),
    fileBytes: new Map([
      ["wgsl/main.wgsl", assets.moduleBytes],
      ["data/model.bin", new Uint8Array(112)],
    ]),
  };
  const matrixBytes = new TextEncoder().encode(JSON.stringify(matrix));
  const matrixSha256 = await computeSha256(matrixBytes);
  const preflightProvenance = provenance();
  const dataBundleSha256 = "4".repeat(64) as typeof ZERO_SHA;
  const harnessSha256 = "5".repeat(64) as typeof ZERO_SHA;
  const subjectBindingSha256 = await computeQualificationSubjectBinding({
    subject: manifest.subject,
    dataBundleSha256,
    compileUnitInventorySha256: inventorySha256,
    matrixSha256,
    harnessSha256,
  });
  const preflight: ShaderQualificationPreflightManifest = {
    contractVersion: SHADER_VALIDATION_EVIDENCE_VERSION,
    kind: "shader-qualification-preflight",
    qualificationId: "qualification.runner-coverage",
    sourceBlob: {
      host: "account.blob.core.windows.net",
      versionId: "immutable-one",
      uri: "https://account.blob.core.windows.net/candidates/candidate.tar?versionid=immutable-one",
    },
    dataBundleSha256,
    compileUnitInventorySha256: inventorySha256,
    matrixSha256,
    harnessSha256,
    subjectBindingSha256,
    provenance: preflightProvenance,
  };
  const labels = actualRunnerLabels(cell);
  const runnerPreflight: ShaderRunnerCellPreflightEvidence = {
    contractVersion: SHADER_VALIDATION_EVIDENCE_VERSION,
    kind: "shader-runner-cell-preflight-evidence",
    qualificationId: preflight.qualificationId,
    cellId: cell.cellId,
    status: "available",
    matrixSha256,
    runnerLabels: cell.runnerLabels,
    matchedRunners: [{ name: `runner-${cell.cellId}`, labels }],
    adapterHarness: {
      id: "coverage-driver",
      version: "1.0.0",
      sha256: AUTOMATION_SHA,
    },
    qualificationPreflightProvenance: preflight.provenance,
    producer: executionProducer(cell, "swiftshader"),
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
    RUNNER_NAME: `runner-${cell.cellId}`,
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: "Linux",
    RUNNER_ARCH: "X64",
  };
  return { admitted, matrixBytes, preflight, runnerPreflight, environment };
}

function browserPhases(): readonly ShaderQualificationPhaseEvidence[] {
  return [
    {
      name: "shader-compilation",
      status: "passed",
      durationMs: 1,
      compilationMessagesSha256: ZERO_SHA,
      errorCount: 0,
    },
    ...[
      "pipeline-layout",
      "pipeline-creation",
      "bind-group-creation",
      "cpu-to-gpu-layout",
      "gpu-to-cpu-layout",
      "bounded-execution",
    ].map((name) => ({
      name,
      status: "passed" as const,
      durationMs: 1,
      evidenceSha256: ZERO_SHA,
    })) as ShaderQualificationPhaseEvidence[],
    {
      name: "semantic-readback",
      status: "passed",
      durationMs: 1,
      expectedSha256: ZERO_SHA,
      actualSha256: ZERO_SHA,
    },
  ];
}

function passingBrowserResult(
  admitted: AdmittedQualificationBundle,
  overrides: Partial<TrustedAdapterUnitResult> = {},
): TrustedAdapterUnitResult {
  const fixture = admitted.fixtures.get("fixture.main")!;
  const probe = fixture.layoutProbes[0]!;
  const outputRecord = admitted.gpuInterface.records.find((record) => record.name === probe.output.recordName)!;
  const expected = createGpuRecordCodec(outputRecord, admitted.gpuInterface.records).encode(
    probe.output.expectedValue as Readonly<Record<string, unknown>>,
  );
  const labels = actualRunnerLabels(cell);
  return {
    status: "passed",
    observed: {
      runner: { id: `runner-${cell.cellId}`, labels },
      os: { name: "ubuntu", version: "24.04", channel: null, architecture: "x64" },
      browser: { name: "chromium", version: "123.4.5.6", channel: "playwright-bundled" },
      adapter: {
        physical: false,
        vendor: "google",
        family: "swiftshader",
        architecture: "subzero",
        device: "swiftshader-device",
        description: "SwiftShader Vulkan adapter",
        backend: "swiftshader",
        driver: "dawn-swiftshader-1",
      },
      features: ["shader-f16"],
      limits: {
        maxBindGroups: 4,
        maxBindingsPerBindGroup: 8,
        maxComputeWorkgroupSizeX: 256,
        maxComputeWorkgroupSizeY: 256,
        maxComputeWorkgroupSizeZ: 64,
        maxComputeInvocationsPerWorkgroup: 256,
        maxStorageBuffersPerShaderStage: 8,
        maxStorageBufferBindingSize: 128 * 1024 * 1024,
        maxBufferSize: 512,
      },
    },
    phases: browserPhases(),
    diagnostics: [],
    layoutProbeOutputs: [{
      probeId: probe.probeId,
      bytesBase64: Buffer.from(expected).toString("base64"),
    }],
    ...overrides,
  };
}

function adapterFactory(
  admitted: AdmittedQualificationBundle,
  result: TrustedAdapterUnitResult = passingBrowserResult(admitted),
): { factory: TrustedQualificationAdapterFactory; adapter: TrustedQualificationAdapter } {
  const adapter: TrustedQualificationAdapter = {
    automation: {
      kind: "playwright",
      driver: "coverage-driver",
      version: "1.0.0",
      sha256: AUTOMATION_SHA,
    },
    runUnit: vi.fn().mockResolvedValue(result),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { factory: { create: vi.fn().mockResolvedValue(adapter) }, adapter };
}

async function runCell(
  current: Scenario,
  options: {
    readonly result?: TrustedAdapterUnitResult;
    readonly admitted?: AdmittedQualificationBundle;
    readonly runnerPreflight?: ShaderRunnerCellPreflightEvidence;
    readonly targetCell?: StableWebGpuMatrixCell;
    readonly observeHost?: Parameters<typeof runTrustedQualificationCell>[0]["observeHost"];
  } = {},
) {
  const admitted = options.admitted ?? current.admitted;
  const routedCell = options.targetCell ?? cell;
  const selected = adapterFactory(admitted, options.result ?? passingBrowserResult(admitted));
  const promise = runTrustedQualificationCell({
    admitted,
    matrix,
    matrixBytes: current.matrixBytes,
    cell: routedCell,
    preflight: current.preflight,
    runnerPreflight: options.runnerPreflight ?? current.runnerPreflight,
    adapterFactory: selected.factory,
    environment: current.environment,
    observeHost: options.observeHost ?? (async (_cell, runner) => ({
      runner: { id: runner.name, labels: runner.labels },
      os: { name: "ubuntu", version: "24.04", channel: null, architecture: "x64" },
    })),
  });
  return { promise, ...selected };
}

describe("trusted cell identity", () => {
  it("binds exact matrix bytes, bundle inventory, source Blob, runner labels and workflow provenance", async () => {
    const current = await scenario();
    expect(await computeQualificationInventorySha256(current.admitted.manifest)).toBe(current.preflight.compileUnitInventorySha256);
    const producer = await validateTrustedCellIdentity({
      admitted: current.admitted,
      matrix,
      matrixBytes: current.matrixBytes,
      cell,
      preflight: current.preflight,
      runnerPreflight: current.runnerPreflight,
      environment: current.environment,
    });
    expect(producer).toMatchObject({
      job: "swiftshader",
      runner: { name: `runner-${cell.cellId}` },
    });
    expect(() => assertTrustedPreflightEnvironment({
      preflight: current.preflight,
      environment: current.environment,
    })).not.toThrow();
  });

  it("rejects malformed and reserialized matrix artifacts", async () => {
    const current = await scenario();
    await expect(validateTrustedCellIdentity({
      ...current,
      matrix,
      cell,
      matrixBytes: new TextEncoder().encode("not-json"),
    })).rejects.toThrow(/not UTF-8 JSON/u);
    await expect(validateTrustedCellIdentity({
      ...current,
      matrix,
      cell,
      matrixBytes: new TextEncoder().encode(JSON.stringify({ ...matrix, matrixId: "changed" })),
    })).rejects.toThrow(/matrix artifact differs/u);
  });

  it("rejects unsupported preflight, stale inventory and stale subject bindings", async () => {
    const current = await scenario();
    const unsupported = clone(current.preflight) as Mutable<ShaderQualificationPreflightManifest>;
    unsupported.contractVersion = "0.0.0" as typeof unsupported.contractVersion;
    await expect(validateTrustedCellIdentity({ ...current, matrix, cell, preflight: unsupported })).rejects.toThrow(/contract is unsupported/u);

    const inventory = clone(current.preflight) as Mutable<ShaderQualificationPreflightManifest>;
    inventory.compileUnitInventorySha256 = ZERO_SHA;
    await expect(validateTrustedCellIdentity({ ...current, matrix, cell, preflight: inventory })).rejects.toThrow(/inventory differs/u);

    const binding = clone(current.preflight) as Mutable<ShaderQualificationPreflightManifest>;
    binding.subjectBindingSha256 = ZERO_SHA;
    await expect(validateTrustedCellIdentity({ ...current, matrix, cell, preflight: binding })).rejects.toThrow(/binding is stale/u);
  });

  it("rejects missing/different environment and immutable Blob claims", async () => {
    const current = await scenario();
    const missing = { ...current.environment };
    delete missing.PLASIUS_QUALIFICATION_ID;
    expect(() => assertTrustedPreflightEnvironment({ preflight: current.preflight, environment: missing })).toThrow(/is required/u);
    expect(() => assertTrustedPreflightEnvironment({
      preflight: current.preflight,
      environment: { ...current.environment, PLASIUS_MATRIX_SHA256: ZERO_SHA },
    })).toThrow(/differs/u);

    const source = clone(current.preflight) as Mutable<ShaderQualificationPreflightManifest>;
    source.sourceBlob = { ...source.sourceBlob, versionId: "different" };
    await expect(validateTrustedCellIdentity({
      ...current,
      matrix,
      cell,
      preflight: source,
      environment: { ...current.environment, PLASIUS_SOURCE_BLOB_VERSION_ID: "different" },
    })).rejects.toThrow(/Blob identity differs/u);
  });

  it("rejects runner authorization and selector-producer drift", async () => {
    const current = await scenario();
    const unauthorized = clone(current.runnerPreflight) as Mutable<ShaderRunnerCellPreflightEvidence>;
    unauthorized.matchedRunners = [];
    await expect(validateTrustedCellIdentity({
      ...current,
      matrix,
      cell,
      runnerPreflight: unauthorized,
    })).rejects.toThrow(/does not authorize/u);

    const staleProducer = clone(current.runnerPreflight) as Mutable<ShaderRunnerCellPreflightEvidence>;
    (staleProducer.producer as Mutable<typeof staleProducer.producer>).runAttempt = 2;
    await expect(validateTrustedCellIdentity({
      ...current,
      matrix,
      cell,
      runnerPreflight: staleProducer,
    })).rejects.toThrow(/producer differs/u);
  });

  it("fails hosted preflight creation before execution for non-SwiftShader and wrong hosted routes", async () => {
    const current = await scenario();
    const physical = {
      ...cell,
      cellId: "physical",
      adapter: { ...cell.adapter, kind: "physical" as const },
    };
    await expect(createHostedSwiftShaderRunnerPreflight({
      matrix,
      matrixBytes: current.matrixBytes,
      cell: physical,
      preflight: current.preflight,
      environment: current.environment,
    })).rejects.toThrow(/restricted/u);
    await expect(createHostedSwiftShaderRunnerPreflight({
      matrix,
      matrixBytes: current.matrixBytes,
      cell,
      preflight: current.preflight,
      environment: { ...current.environment, RUNNER_ENVIRONMENT: "self-hosted" },
    })).rejects.toThrow(/fixed GitHub-hosted/u);
  });
});

describe("trusted qualification cell orchestration", () => {
  it("returns exact evidence only after reflection, codec probes and all browser phases pass", async () => {
    const current = await scenario();
    const execution = await runCell(current);
    const evidence = await execution.promise;

    expect(evidence).toMatchObject({
      qualificationId: current.preflight.qualificationId,
      cellId: cell.cellId,
      harness: { id: "@plasius/gpu-shader", sha256: current.preflight.harnessSha256 },
      automation: { driver: "coverage-driver", sha256: AUTOMATION_SHA },
    });
    expect(evidence.results[0]!.phases.map((phase) => phase.name)).toEqual([
      "assembly",
      "reflection-schema",
      "shader-compilation",
      "pipeline-layout",
      "pipeline-creation",
      "bind-group-creation",
      "cpu-to-gpu-layout",
      "gpu-to-cpu-layout",
      "bounded-execution",
      "semantic-readback",
    ]);
    expect(execution.adapter.runUnit).toHaveBeenCalledOnce();
    expect(execution.adapter.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["a failed adapter status", (result: DeepMutable<TrustedAdapterUnitResult>) => { result.status = "failed"; }, /execution failed closed/u],
    ["an error diagnostic on passed status", (result: DeepMutable<TrustedAdapterUnitResult>) => {
      result.diagnostics = [{ code: "compilation-error", severity: "error", message: "bad" }];
    }, /passed with an error diagnostic/u],
    ["missing browser phases", (result: DeepMutable<TrustedAdapterUnitResult>) => { result.phases = result.phases.slice(1); }, /all eight browser phases/u],
    ["runner identity drift", (result: DeepMutable<TrustedAdapterUnitResult>) => { result.observed.runner.id = "other"; }, /runner identity differs/u],
    ["OS build drift", (result: DeepMutable<TrustedAdapterUnitResult>) => { result.observed.os.version = "22.04"; }, /OS\/build differs/u],
    ["browser build drift", (result: DeepMutable<TrustedAdapterUnitResult>) => { result.observed.browser.version = "unknown"; }, /browser name\/channel\/build differs/u],
    ["adapter route drift", (result: DeepMutable<TrustedAdapterUnitResult>) => { result.observed.adapter.vendor = "intel"; }, /adapter physical\/vendor/u],
    ["non-concrete adapter identity", (result: DeepMutable<TrustedAdapterUnitResult>) => { result.observed.adapter.driver = "unavailable"; }, /driver was not observed concretely/u],
    ["duplicate feature observations", (result: DeepMutable<TrustedAdapterUnitResult>) => { result.observed.features = ["shader-f16", "shader-f16"]; }, /features contain duplicates/u],
    ["a missing feature", (result: DeepMutable<TrustedAdapterUnitResult>) => { result.observed.features = []; }, /lacks required feature/u],
    ["an insufficient minimum limit", (result: DeepMutable<TrustedAdapterUnitResult>) => { result.observed.limits.maxStorageBuffersPerShaderStage = 0; }, /does not satisfy at-least/u],
    ["an excessive maximum limit", (result: DeepMutable<TrustedAdapterUnitResult>) => { result.observed.limits.maxBufferSize = 2_048; }, /does not satisfy at-most/u],
  ])("fails closed for %s", async (_label, mutate, expected) => {
    const current = await scenario();
    const result = clone(passingBrowserResult(current.admitted)) as DeepMutable<TrustedAdapterUnitResult>;
    mutate(result);
    const execution = await runCell(current, { result });
    await expect(execution.promise).rejects.toThrow(expected);
    expect(execution.adapter.close).toHaveBeenCalledOnce();
  });

  it("rejects host, adapter, format, fixture and fixture-byte drift without retaining a replacement", async () => {
    const current = await scenario();
    const host = await runCell(current, {
      observeHost: async (_cell, runner) => ({
        runner: { id: "other", labels: runner.labels },
        os: { name: "ubuntu", version: "24.04", channel: null, architecture: "x64" },
      }),
    });
    await expect(host.promise).rejects.toThrow(/controller runner differs/u);

    const adapterPreflight = clone(current.runnerPreflight) as Mutable<ShaderRunnerCellPreflightEvidence>;
    if (!adapterPreflight.adapterHarness) throw new Error("Expected adapter preflight.");
    (adapterPreflight.adapterHarness as Mutable<NonNullable<typeof adapterPreflight.adapterHarness>>).sha256 = ZERO_SHA;
    const adapter = await runCell(current, { runnerPreflight: adapterPreflight });
    await expect(adapter.promise).rejects.toThrow(/adapter differs/u);
    expect(adapter.adapter.close).toHaveBeenCalledOnce();

    const formatAdmitted = {
      ...current.admitted,
      shaderManifestCore: {
        ...current.admitted.shaderManifestCore,
        requirements: { ...current.admitted.shaderManifestCore.requirements, formats: ["rgba8unorm"] },
      },
    };
    const format = await runCell(current, { admitted: formatAdmitted });
    await expect(format.promise).rejects.toThrow(/Required format rgba8unorm/u);

    const noFixture = { ...current.admitted, fixtures: new Map() };
    const fixture = await runCell(current, {
      admitted: noFixture,
      result: passingBrowserResult(current.admitted),
    });
    await expect(fixture.promise).rejects.toThrow(/lacks its admitted qualification fixture/u);
    expect(fixture.adapter.close).toHaveBeenCalledOnce();

    const missingBytes = new Map(current.admitted.fileBytes);
    missingBytes.delete("data/model.bin");
    const bytes = await runCell(current, { admitted: { ...current.admitted, fileBytes: missingBytes } });
    await expect(bytes.promise).rejects.toThrow(/admitted input bytes are incomplete/u);
    expect(bytes.adapter.close).toHaveBeenCalledOnce();
  });

  it("closes the adapter when browser execution throws and fails a zero-duration matrix deadline", async () => {
    const current = await scenario();
    const execution = await runCell(current);
    (execution.adapter.runUnit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("browser boundary failed"));
    await expect(execution.promise).rejects.toThrow(/browser boundary failed/u);
    expect(execution.adapter.close).toHaveBeenCalledOnce();

    const expiredCell = { ...cell, timeoutMs: 0 };
    const expired = await runCell(current, { targetCell: expiredCell });
    await expect(expired.promise).rejects.toThrow(/exceeded its matrix deadline/u);
  });
});
