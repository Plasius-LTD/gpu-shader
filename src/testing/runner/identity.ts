import { canonicalizeGpuContract } from "../../canonical-json.js";
import {
  SHADER_VALIDATION_EVIDENCE_VERSION,
  type ShaderQualificationExecutionProducer,
  type ShaderQualificationPreflightManifest,
  type ShaderRunnerCellPreflightEvidence,
  type StableWebGpuMatrixCell,
  type StableWebGpuMatrixManifest,
} from "../../contracts.js";
import { asSha256Hex, computeSha256 } from "../../hash.js";
import type { AdmittedQualificationBundle } from "../../node/bundle-admission.js";
import {
  computeQualificationInventorySha256,
  computeQualificationSubjectBinding,
  parseQualificationExecutionProducer,
  parseTrustedWorkflowProvenance,
} from "../evidence.js";
import {
  createQualificationExecutionProducer,
  type TrustedQualificationEnvironment,
} from "./producer.js";
import { observePlaywrightAdapterHarness } from "./playwright-integrity.js";
import { observeTrustedRunnerHost } from "./host.js";

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalizeGpuContract(left) === canonicalizeGpuContract(right);
}

function required(environment: TrustedQualificationEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new TypeError(`Trusted runner environment ${name} is required.`);
  return value;
}

export function assertTrustedPreflightEnvironment(input: {
  readonly preflight: ShaderQualificationPreflightManifest;
  readonly environment: TrustedQualificationEnvironment;
}): void {
  const { preflight, environment } = input;
  const expected: Readonly<Record<string, string>> = {
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
  for (const [name, value] of Object.entries(expected)) {
    if (required(environment, name) !== value) throw new TypeError(`${name} differs from immutable qualification preflight evidence.`);
  }
}

/** Validates exact raw matrix, candidate, preflight, runner, and execution identities. */
export async function validateTrustedCellIdentity(input: {
  readonly admitted: AdmittedQualificationBundle;
  readonly matrix: StableWebGpuMatrixManifest;
  readonly matrixBytes: Uint8Array;
  readonly cell: StableWebGpuMatrixCell;
  readonly preflight: ShaderQualificationPreflightManifest;
  readonly runnerPreflight: ShaderRunnerCellPreflightEvidence;
  readonly environment?: TrustedQualificationEnvironment;
}): Promise<ShaderQualificationExecutionProducer> {
  const environment = input.environment ?? process.env;
  const matrixSha256 = await computeSha256(input.matrixBytes);
  let parsedMatrix: unknown;
  try { parsedMatrix = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.matrixBytes)); }
  catch (cause) { throw new TypeError("Stable WebGPU matrix bytes are not UTF-8 JSON.", { cause }); }
  if (!canonicalEqual(parsedMatrix, input.matrix) || matrixSha256 !== input.preflight.matrixSha256) {
    throw new TypeError("Exact stable WebGPU matrix artifact differs from qualification preflight evidence.");
  }
  if (input.preflight.contractVersion !== SHADER_VALIDATION_EVIDENCE_VERSION
    || input.preflight.kind !== "shader-qualification-preflight") throw new TypeError("Qualification preflight contract is unsupported.");
  parseTrustedWorkflowProvenance(input.preflight.provenance, "preflight.provenance");
  const inventorySha256 = await computeQualificationInventorySha256(input.admitted.manifest);
  if (inventorySha256 !== input.preflight.compileUnitInventorySha256
    || inventorySha256 !== input.admitted.manifest.subject.compileUnitInventorySha256) {
    throw new TypeError("Compile-unit inventory differs from qualification preflight evidence.");
  }
  const subjectBindingSha256 = await computeQualificationSubjectBinding({
    subject: input.admitted.manifest.subject,
    dataBundleSha256: input.preflight.dataBundleSha256,
    compileUnitInventorySha256: inventorySha256,
    matrixSha256,
    harnessSha256: input.preflight.harnessSha256,
  });
  if (subjectBindingSha256 !== input.preflight.subjectBindingSha256) throw new TypeError("Qualification subject binding is stale.");
  assertTrustedPreflightEnvironment({ preflight: input.preflight, environment });
  const source = new URL(input.preflight.sourceBlob.uri);
  const versions = source.searchParams.getAll("versionid");
  if (source.protocol !== "https:" || source.host.toLowerCase() !== input.preflight.sourceBlob.host
    || versions.length !== 1 || versions[0] !== input.preflight.sourceBlob.versionId) {
    throw new TypeError("Immutable source Blob identity differs from qualification preflight evidence.");
  }
  const executionProducer = createQualificationExecutionProducer({
    preflight: input.preflight,
    job: input.cell.adapter.kind === "software" ? "swiftshader" : "physical",
    environment,
  });
  const runner = input.runnerPreflight;
  if (runner.contractVersion !== SHADER_VALIDATION_EVIDENCE_VERSION
    || runner.kind !== "shader-runner-cell-preflight-evidence"
    || runner.qualificationId !== input.preflight.qualificationId
    || runner.cellId !== input.cell.cellId
    || runner.status !== "available"
    || runner.matrixSha256 !== matrixSha256
    || !canonicalEqual(runner.runnerLabels, input.cell.runnerLabels)
    || !canonicalEqual(runner.qualificationPreflightProvenance, input.preflight.provenance)
    || !runner.matchedRunners.some((candidate) => {
      const labels = new Set(candidate.labels.map((label) => label.toLocaleLowerCase("en-US")));
      return candidate.name === executionProducer.runner.name
        && runner.runnerLabels.every((label) => labels.has(label.toLocaleLowerCase("en-US")));
    })) {
    throw new TypeError("Runner preflight does not authorize this exact execution runner and matrix cell.");
  }
  const selectorProducer = parseQualificationExecutionProducer(runner.producer, "runnerPreflight.producer");
  const expectedSelectorJob = input.cell.adapter.kind === "software" ? "swiftshader" : "physical-runner-preflight";
  if (selectorProducer.job !== expectedSelectorJob
    || selectorProducer.repository !== input.preflight.provenance.repository
    || !canonicalEqual(selectorProducer.commit, input.preflight.provenance.commit)
    || selectorProducer.ref !== input.preflight.provenance.ref
    || selectorProducer.runId !== input.preflight.provenance.runId
    || selectorProducer.runAttempt !== input.preflight.provenance.runAttempt
    || selectorProducer.trustedWorkflowRef !== input.preflight.provenance.workflowRef
    || !canonicalEqual(selectorProducer.trustedWorkflowSha, input.preflight.provenance.workflowSha)) {
    throw new TypeError("Runner-preflight producer differs from the immutable qualification route.");
  }
  return executionProducer;
}

/** Creates hosted SwiftShader route evidence from actual fixed-runner environment values. */
export async function createHostedSwiftShaderRunnerPreflight(input: {
  readonly matrix: StableWebGpuMatrixManifest;
  readonly matrixBytes: Uint8Array;
  readonly cell: StableWebGpuMatrixCell;
  readonly preflight: ShaderQualificationPreflightManifest;
  readonly environment?: TrustedQualificationEnvironment;
}): Promise<ShaderRunnerCellPreflightEvidence> {
  const environment = input.environment ?? process.env;
  if (input.cell.cellId !== "swiftshader.chromium.ubuntu-x64" || input.cell.adapter.kind !== "software") {
    throw new TypeError("Hosted runner-preflight creation is restricted to the exact SwiftShader smoke cell.");
  }
  const matrixSha256 = await computeSha256(input.matrixBytes);
  let parsedMatrix: unknown;
  try { parsedMatrix = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.matrixBytes)); }
  catch (cause) { throw new TypeError("Stable WebGPU matrix bytes are not UTF-8 JSON.", { cause }); }
  if (!canonicalEqual(parsedMatrix, input.matrix) || matrixSha256 !== input.preflight.matrixSha256) {
    throw new TypeError("Hosted runner preflight matrix artifact differs from qualification preflight.");
  }
  assertTrustedPreflightEnvironment({ preflight: input.preflight, environment });
  const producer = createQualificationExecutionProducer({ preflight: input.preflight, job: "swiftshader", environment });
  if (producer.runner.environment !== "github-hosted" || producer.runner.os !== "Linux" || producer.runner.architecture !== "X64") {
    throw new TypeError("SwiftShader smoke must execute on the fixed GitHub-hosted Linux/X64 route.");
  }
  const observedHost = await observeTrustedRunnerHost(input.cell, { name: producer.runner.name, labels: [] });
  const hostedLabels = [`${observedHost.os.name}-${observedHost.os.version}`];
  if (!canonicalEqual(hostedLabels, input.cell.runnerLabels)) {
    throw new TypeError("Actual hosted runner image does not derive the fixed matrix scheduler label.");
  }
  let playwright: typeof import("playwright-core");
  try {
    const specifier: string = "playwright-core";
    playwright = await import(specifier) as typeof import("playwright-core");
  }
  catch (cause) { throw new TypeError("Pinned playwright-core is unavailable for runner preflight.", { cause }); }
  const adapterHarness = await observePlaywrightAdapterHarness(playwright.chromium.executablePath());
  return {
    contractVersion: SHADER_VALIDATION_EVIDENCE_VERSION,
    kind: "shader-runner-cell-preflight-evidence",
    qualificationId: input.preflight.qualificationId,
    cellId: input.cell.cellId,
    status: "available",
    matrixSha256: asSha256Hex(matrixSha256),
    runnerLabels: input.cell.runnerLabels,
    matchedRunners: [{ name: producer.runner.name, labels: hostedLabels }],
    adapterHarness,
    qualificationPreflightProvenance: input.preflight.provenance,
    producer,
  };
}
