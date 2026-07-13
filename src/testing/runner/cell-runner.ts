import { canonicalizeGpuContract } from "../../canonical-json.js";
import {
  SHADER_VALIDATION_EVIDENCE_VERSION,
  type ShaderCellEvidence,
  type ShaderQualificationPhaseEvidence,
  type ShaderQualificationPreflightManifest,
  type ShaderQualificationResult,
  type ShaderRunnerCellPreflightEvidence,
  type StableWebGpuMatrixCell,
  type StableWebGpuMatrixManifest,
} from "../../contracts.js";
import { asSha256Hex, computeSha256 } from "../../hash.js";
import type { AdmittedQualificationBundle } from "../../node/bundle-admission.js";
import { createProvisionedTrustedAdapter, defaultTrustedQualificationAdapterFactory } from "./adapter-factory.js";
import { observeTrustedRunnerHost } from "./host.js";
import { validateTrustedCellIdentity } from "./identity.js";
import { prepareReflectedLayoutProbes, verifyReflectedLayoutProbeOutputs } from "./layout-probes.js";
import { readTrustedHarnessPackageMetadata } from "./package-metadata.js";
import { createTrustedReflectionProof, unitModuleSources } from "./reflection-proof.js";
import type {
  TrustedAdapterUnitResult,
  TrustedGpuObservation,
  TrustedQualificationAdapterFactory,
  TrustedRunnerHostObservation,
} from "./types.js";
import type { TrustedQualificationEnvironment } from "./producer.js";

const BROWSER_PHASES = [
  "shader-compilation",
  "pipeline-layout",
  "pipeline-creation",
  "bind-group-creation",
  "cpu-to-gpu-layout",
  "gpu-to-cpu-layout",
  "bounded-execution",
  "semantic-readback",
] as const;

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalizeGpuContract(left) === canonicalizeGpuContract(right);
}

function concrete(value: string, label: string): void {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "unknown" || normalized === "unavailable") {
    throw new TypeError(`${label} was not observed concretely by the trusted runner.`);
  }
}

function versionMatches(cell: StableWebGpuMatrixCell, version: string, channel: string | null): boolean {
  if (!/^\d+(?:\.\d+)*(?:[-+][A-Za-z0-9.]+)?$/u.test(version)) return false;
  const requirement = cell.os.versionRequirement;
  if (requirement.kind === "exact") return channel === null && version === requirement.value;
  const major = Number.parseInt(version.split(".")[0]!, 10);
  if (requirement.kind === "major") return channel === null && major === requirement.value;
  if (requirement.kind === "minimum-major") return channel === null && major >= requirement.value;
  return channel === requirement.channel;
}

function validateObservation(input: {
  readonly result: TrustedAdapterUnitResult;
  readonly cell: StableWebGpuMatrixCell;
  readonly runnerName: string;
  readonly expectedRunner: { readonly name: string; readonly labels: readonly string[] };
  readonly requirements: AdmittedQualificationBundle["shaderManifestCore"]["requirements"];
}): TrustedGpuObservation {
  const { result, cell, runnerName, expectedRunner, requirements } = input;
  if (result.status !== "passed") {
    const detail = result.diagnostics.map((item) => item.message).join("; ") || result.status;
    throw new TypeError(`Trusted WebGPU execution failed closed: ${detail}`);
  }
  if (result.diagnostics.some((item) => item.severity === "error")) {
    throw new TypeError("Trusted WebGPU execution returned passed with an error diagnostic.");
  }
  if (result.phases.length !== BROWSER_PHASES.length
    || !BROWSER_PHASES.every((name, index) => result.phases[index]?.name === name && result.phases[index]?.status === "passed")) {
    throw new TypeError("Trusted WebGPU execution did not pass all eight browser phases in fixed order.");
  }
  const observed = result.observed;
  if (observed.runner.id !== runnerName
    || !canonicalEqual(observed.runner.labels, expectedRunner.labels)) {
    throw new TypeError("Observed runner identity differs from API-verified runner preflight evidence.");
  }
  if (observed.os.name !== cell.os.name
    || observed.os.architecture !== cell.os.architecture
    || !versionMatches(cell, observed.os.version, observed.os.channel)) {
    throw new TypeError("Observed target OS/build differs from the exact matrix requirement.");
  }
  if (observed.browser.name !== cell.browser.name
    || observed.browser.channel !== cell.browser.channel
    || !/^\d+(?:\.\d+)+/u.test(observed.browser.version)) {
    throw new TypeError("Observed browser name/channel/build differs from the exact matrix route.");
  }
  if (observed.adapter.physical !== (cell.adapter.kind === "physical")
    || observed.adapter.vendor.trim().toLowerCase() !== cell.adapter.vendor
    || observed.adapter.family.trim().toLowerCase() !== cell.adapter.family
    || observed.adapter.backend.trim().toLowerCase() !== cell.adapter.backend) {
    throw new TypeError("Observed adapter physical/vendor/family/backend differs from the exact matrix route.");
  }
  concrete(observed.adapter.architecture, "Adapter architecture");
  concrete(observed.adapter.device, "Adapter device");
  concrete(observed.adapter.description, "Adapter description");
  concrete(observed.adapter.driver, "Adapter driver");
  if (new Set(observed.features).size !== observed.features.length) throw new TypeError("Observed adapter features contain duplicates.");
  const features = new Set(observed.features);
  for (const feature of requirements.features) if (!features.has(feature)) throw new TypeError(`Observed adapter lacks required feature ${feature}.`);
  for (const requirement of requirements.limits) {
    const available = observed.limits[requirement.name];
    if (available === undefined || !Number.isFinite(available)
      || (requirement.comparator === "at-least" ? available < requirement.value : available > requirement.value)) {
      throw new TypeError(`Observed adapter limit ${requirement.name} does not satisfy ${requirement.comparator} ${requirement.value}.`);
    }
  }
  return observed;
}

function fixtureData(
  admitted: AdmittedQualificationBundle,
  fixtureId: string,
): Readonly<Record<string, string>> {
  const fixture = admitted.fixtures.get(fixtureId);
  if (!fixture) throw new TypeError(`Admitted fixture ${fixtureId} is missing.`);
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const resource of fixture.resources) {
    if (resource.kind === "sampler" || resource.initialData === null) continue;
    const path = resource.initialData.path;
    const bytes = admitted.fileBytes.get(path);
    if (!bytes) throw new TypeError(`Admitted fixture bytes ${path} are missing.`);
    result[path] = Buffer.from(bytes).toString("base64");
  }
  return result;
}

function assertRequiredFormatsExercised(admitted: AdmittedQualificationBundle): void {
  const formats = new Set<string>();
  for (const unit of admitted.manifest.inventory.compileUnits) for (const pipeline of unit.pipelines) {
    if (pipeline.kind !== "render") continue;
    pipeline.colorTargets.forEach((target) => formats.add(target.format));
    if (pipeline.depthStencil) formats.add(pipeline.depthStencil.format);
  }
  for (const fixture of admitted.fixtures.values()) for (const resource of fixture.resources) {
    if (resource.kind === "texture") formats.add(resource.format);
  }
  for (const required of admitted.shaderManifestCore.requirements.formats) {
    if (!formats.has(required)) throw new TypeError(`Required format ${required} is not exercised by any exact compile unit.`);
  }
}

function remaining(deadline: number): number {
  const value = deadline - Date.now();
  if (value <= 0) throw new TypeError("Trusted qualification cell exceeded its matrix deadline.");
  return value;
}

async function withinDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const timeoutMs = remaining(deadline);
  let handle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        handle = setTimeout(() => reject(new TypeError("Trusted qualification cell exceeded its matrix deadline.")), timeoutMs);
      }),
    ]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

/** Runs one exact matrix cell and returns evidence only after every unit passes. */
export async function runTrustedQualificationCell(input: {
  readonly admitted: AdmittedQualificationBundle;
  readonly matrix: StableWebGpuMatrixManifest;
  readonly matrixBytes: Uint8Array;
  readonly cell: StableWebGpuMatrixCell;
  readonly preflight: ShaderQualificationPreflightManifest;
  readonly runnerPreflight: ShaderRunnerCellPreflightEvidence;
  readonly adapterFactory?: TrustedQualificationAdapterFactory;
  readonly environment?: TrustedQualificationEnvironment;
  readonly observeHost?: (
    cell: StableWebGpuMatrixCell,
    apiRunner: { readonly name: string; readonly labels: readonly string[] },
  ) => Promise<TrustedRunnerHostObservation>;
}): Promise<ShaderCellEvidence> {
  const producer = await validateTrustedCellIdentity(input);
  const qualificationStarted = Date.now();
  const verifiedAt = Date.parse(input.preflight.provenance.oidcAttestation.verifiedAt);
  if (!Number.isFinite(verifiedAt) || qualificationStarted < verifiedAt) {
    throw new TypeError("Trusted qualification clock precedes immutable preflight verification.");
  }
  const deadline = qualificationStarted + input.cell.timeoutMs;
  const proof = await withinDeadline(createTrustedReflectionProof(input.admitted), deadline);
  assertRequiredFormatsExercised(input.admitted);
  const apiRunner = input.runnerPreflight.matchedRunners.find((runner) => runner.name === producer.runner.name);
  if (!apiRunner) throw new TypeError("Execution runner was not matched by runner preflight evidence.");
  const host = await withinDeadline((input.observeHost ?? observeTrustedRunnerHost)(input.cell, apiRunner), deadline);
  if (host.runner.id !== producer.runner.name || !canonicalEqual(host.runner.labels, apiRunner.labels)) {
    throw new TypeError("Observed controller runner differs from API-verified preflight evidence.");
  }
  const packageMetadata = await withinDeadline(readTrustedHarnessPackageMetadata(), deadline);
  const adapter = await withinDeadline(createProvisionedTrustedAdapter(
    input.adapterFactory ?? defaultTrustedQualificationAdapterFactory,
    input.cell,
  ), deadline);
  if (input.runnerPreflight.adapterHarness !== null
    && !canonicalEqual(
      { id: adapter.automation.driver, version: adapter.automation.version, sha256: adapter.automation.sha256 },
      input.runnerPreflight.adapterHarness,
    )) {
    await adapter.close().catch(() => undefined);
    throw new TypeError("Executable automation adapter differs from immutable runner preflight identity.");
  }
  const results: ShaderQualificationResult[] = [];
  try {
    for (const unit of input.admitted.manifest.inventory.compileUnits) {
      const fixture = input.admitted.fixtures.get(unit.qualificationFixture.fixtureId);
      if (!fixture) throw new TypeError(`Compile unit ${unit.compileUnitId} lacks its admitted qualification fixture.`);
      const prepared = await withinDeadline(prepareReflectedLayoutProbes({ admitted: input.admitted, unit, fixture }), deadline);
      const startedAt = new Date().toISOString();
      const unitTimeout = Math.min(remaining(deadline), fixture.bounds.timeoutMs);
      const browserResult = await withinDeadline(adapter.runUnit({
        cell: input.cell,
        unit,
        modules: unitModuleSources(unit, proof),
        fixture,
        fixtureData: fixtureData(input.admitted, fixture.fixtureId),
        requirements: input.admitted.shaderManifestCore.requirements,
        modelAbiHash: input.admitted.gpuInterface.modelAbiHash,
        layoutProbes: prepared.map((item) => item.browser),
        host,
        timeoutMs: unitTimeout,
      }), deadline);
      const observed = validateObservation({
        result: browserResult,
        cell: input.cell,
        runnerName: producer.runner.name,
        expectedRunner: apiRunner,
        requirements: input.admitted.shaderManifestCore.requirements,
      });
      verifyReflectedLayoutProbeOutputs({ prepared, outputs: browserResult.layoutProbeOutputs });
      const assemblySha256 = proof.assemblySha256ByUnit.get(unit.compileUnitId);
      if (!assemblySha256) throw new TypeError(`Compile unit ${unit.compileUnitId} lacks trusted assembly proof.`);
      const phases: readonly ShaderQualificationPhaseEvidence[] = [
        { name: "assembly", status: "passed", durationMs: 0, evidenceSha256: assemblySha256 },
        { name: "reflection-schema", status: "passed", durationMs: proof.durationMs, evidenceSha256: proof.reflectionSha256 },
        ...browserResult.phases,
      ];
      results.push({
        compileUnitId: unit.compileUnitId,
        cellId: input.cell.cellId,
        status: "passed",
        startedAt,
        completedAt: new Date().toISOString(),
        observed,
        phases,
        diagnostics: browserResult.diagnostics,
      });
    }
  } finally {
    await adapter.close();
  }
  if (results.length !== input.admitted.manifest.inventory.compileUnits.length) {
    throw new TypeError("Trusted qualification cell result set is incomplete.");
  }
  const evidence: ShaderCellEvidence = {
    contractVersion: SHADER_VALIDATION_EVIDENCE_VERSION,
    qualificationId: input.preflight.qualificationId,
    matrixId: input.matrix.matrixId,
    matrixVersion: input.matrix.version,
    matrixSha256: input.preflight.matrixSha256,
    cellId: input.cell.cellId,
    dataBundleSha256: input.preflight.dataBundleSha256,
    compileUnitInventorySha256: input.preflight.compileUnitInventorySha256,
    harness: { id: packageMetadata.name, version: packageMetadata.version, sha256: input.preflight.harnessSha256 },
    automation: { ...adapter.automation, sha256: asSha256Hex(adapter.automation.sha256) },
    subjectBindingSha256: input.preflight.subjectBindingSha256,
    qualificationPreflightProvenance: input.preflight.provenance,
    producer,
    results,
  };
  // Bind the returned value to an exact serialization now; callers may only persist this data object.
  await computeSha256(canonicalizeGpuContract(evidence));
  return evidence;
}
