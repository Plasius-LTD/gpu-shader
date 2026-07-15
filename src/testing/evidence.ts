import {
  canonicalizeQualificationGpuContract,
  QUALIFICATION_GPU_CONTRACT_SNAPSHOT_LIMITS,
  snapshotGpuContract,
  snapshotUint8Array,
} from "../canonical-json.js";
import {
  SHADER_VALIDATION_EVIDENCE_VERSION,
  type GitObjectId,
  type ShaderCellEvidence,
  type ShaderDiagnostic,
  type ShaderNonQualifyingWorkflowDiagnostic,
  type ShaderQualificationBundleManifest,
  type ShaderQualificationCandidateSubject,
  type ShaderQualificationPreflightManifest,
  type ShaderQualificationExecutionProducer,
  type ShaderQualificationResult,
  type ShaderQualificationStatus,
  type ShaderResult,
  type ShaderRunnerCellPreflightEvidence,
  type ShaderTrustedWorkflowProvenance,
  type ShaderValidationCellRun,
  type ShaderValidationEvidence,
  type ShaderValidationEvidenceAttestationRef,
  type Sha256Hex,
  type StableWebGpuMatrixCell,
  type StableWebGpuMatrixManifest,
} from "../contracts.js";
import { asSha256Hex, computeSha256 } from "../hash.js";

type UnknownRecord = Record<string, unknown>;

export interface EvidenceArtifact<T> {
  readonly value: T;
  readonly bytes: Uint8Array;
  readonly sha256: Sha256Hex;
}

function object(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${path} must be an object.`);
  return value as UnknownRecord;
}

function exact(value: UnknownRecord, keys: readonly string[], path: string): void {
  const expected = new Set(keys);
  if (!Object.keys(value).every((key) => expected.has(key)) || !keys.every((key) => Object.hasOwn(value, key))) throw new TypeError(`${path} has unknown or missing fields.`);
}

function detachedQualificationContract(value: unknown): unknown {
  try {
    return snapshotGpuContract(value, QUALIFICATION_GPU_CONTRACT_SNAPSHOT_LIMITS);
  } catch {
    throw new TypeError("Qualification data must contain bounded detached JSON contract data.");
  }
}

function parseQualificationJsonBytes(bytes: Uint8Array, label: string): unknown {
  let snapshot: Uint8Array;
  try {
    snapshot = snapshotUint8Array(
      bytes,
      QUALIFICATION_GPU_CONTRACT_SNAPSHOT_LIMITS.maximumInputBytes,
    );
  } catch {
    throw new TypeError(`${label} is not bounded UTF-8 JSON.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(snapshot)) as unknown;
  } catch {
    throw new TypeError(`${label} is not valid UTF-8 JSON.`);
  }
  return detachedQualificationContract(parsed);
}

function freezeJson<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeJson(child);
  return Object.freeze(value);
}

function token(value: unknown, path: string, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || [...value].some((character) => character.charCodeAt(0) <= 0x1f)) throw new TypeError(`${path} is not a bounded string.`);
  return value;
}

function sha(value: unknown, path: string): Sha256Hex {
  try { return asSha256Hex(token(value, path, 64)); }
  catch { throw new TypeError(`${path} is not a SHA-256 digest.`); }
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new TypeError(`${path} is not a safe integer.`);
  return Number(value);
}

function timestamp(value: unknown, path: string): string {
  const parsed = token(value, path, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(parsed) || !Number.isFinite(Date.parse(parsed))) throw new TypeError(`${path} must be an ISO UTC timestamp.`);
  return parsed;
}

function array(value: unknown, path: string, maximum = 100_000): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${path} must be a bounded array.`);
  return value;
}

function gitObject(value: unknown, path: string): GitObjectId {
  const input = object(value, path); exact(input, ["algorithm", "hex"], path);
  const algorithm = input.algorithm; if (algorithm !== "sha1" && algorithm !== "sha256") throw new TypeError(`${path}.algorithm is invalid.`);
  const hex = token(input.hex, `${path}.hex`, 64); const length = algorithm === "sha1" ? 40 : 64;
  if (!new RegExp(`^[a-f0-9]{${length}}$`, "u").test(hex)) throw new TypeError(`${path}.hex does not match its algorithm.`);
  return input as unknown as GitObjectId;
}

const TRUSTED_WORKFLOW_PREFIX = "Plasius-LTD/gpu-shader/.github/workflows/shader-qualification.yml@";

function trustedWorkflowRef(value: unknown, path: string): string {
  const result = token(value, path, 1024);
  if (result !== `${TRUSTED_WORKFLOW_PREFIX}refs/heads/main`) throw new TypeError(`${path} must bind the trusted shader-qualification workflow on protected main.`);
  return result;
}

export function parseTrustedWorkflowProvenance(value: unknown, path = "provenance"): ShaderTrustedWorkflowProvenance {
  const input = object(detachedQualificationContract(value), path); exact(input, ["repository", "commit", "ref", "workflowRef", "workflowSha", "runId", "runAttempt", "job", "eventName", "oidcAttestation"], path);
  const repository = token(input.repository, `${path}.repository`); if (!repository.startsWith("Plasius-LTD/")) throw new TypeError(`${path}.repository is outside Plasius-LTD.`); gitObject(input.commit, `${path}.commit`); token(input.ref, `${path}.ref`); gitObject(input.workflowSha, `${path}.workflowSha`); trustedWorkflowRef(input.workflowRef, `${path}.workflowRef`); token(input.runId, `${path}.runId`); integer(input.runAttempt, `${path}.runAttempt`, 1); token(input.job, `${path}.job`); token(input.eventName, `${path}.eventName`);
  const oidc = object(input.oidcAttestation, `${path}.oidcAttestation`); exact(oidc, ["issuer", "subject", "audience", "verifiedClaimsSha256", "verifiedAt", "source"], `${path}.oidcAttestation`);
  if (oidc.issuer !== "https://token.actions.githubusercontent.com" || oidc.source !== "trusted-runner-preflight") throw new TypeError(`${path}.oidcAttestation is not GitHub trusted-preflight provenance.`);
  token(oidc.subject, `${path}.oidcAttestation.subject`, 2048); token(oidc.audience, `${path}.oidcAttestation.audience`, 2048); sha(oidc.verifiedClaimsSha256, `${path}.oidcAttestation.verifiedClaimsSha256`); timestamp(oidc.verifiedAt, `${path}.oidcAttestation.verifiedAt`);
  return freezeJson(input as unknown as ShaderTrustedWorkflowProvenance);
}

/** Strictly parses the actual job/runner identity that produced a cell artifact. */
export function parseQualificationExecutionProducer(value: unknown, path = "producer"): ShaderQualificationExecutionProducer {
  const input = object(detachedQualificationContract(value), path); exact(input, ["repository", "commit", "ref", "runId", "runAttempt", "job", "trustedWorkflowRepository", "trustedWorkflowRef", "trustedWorkflowSha", "runner"], path);
  const repository = token(input.repository, `${path}.repository`); if (!repository.startsWith("Plasius-LTD/")) throw new TypeError(`${path}.repository is outside Plasius-LTD.`);
  gitObject(input.commit, `${path}.commit`); token(input.ref, `${path}.ref`); token(input.runId, `${path}.runId`); integer(input.runAttempt, `${path}.runAttempt`, 1);
  if (!["swiftshader", "physical", "physical-runner-preflight"].includes(String(input.job))) throw new TypeError(`${path}.job is not a qualification workflow job.`);
  if (input.trustedWorkflowRepository !== "Plasius-LTD/gpu-shader") throw new TypeError(`${path}.trustedWorkflowRepository differs.`);
  gitObject(input.trustedWorkflowSha, `${path}.trustedWorkflowSha`); trustedWorkflowRef(input.trustedWorkflowRef, `${path}.trustedWorkflowRef`);
  const runner = object(input.runner, `${path}.runner`); exact(runner, ["name", "environment", "os", "architecture"], `${path}.runner`); token(runner.name, `${path}.runner.name`); if (!["github-hosted", "self-hosted", "device-farm"].includes(String(runner.environment))) throw new TypeError(`${path}.runner.environment is invalid.`); token(runner.os, `${path}.runner.os`); token(runner.architecture, `${path}.runner.architecture`);
  return freezeJson(input as unknown as ShaderQualificationExecutionProducer);
}

function assertProducerMatchesPreflight(producer: ShaderQualificationExecutionProducer, provenance: ShaderTrustedWorkflowProvenance, cell: StableWebGpuMatrixCell, path: string, expectedJob: ShaderQualificationExecutionProducer["job"]): void {
  if (producer.repository !== provenance.repository || !canonicalEqual(producer.commit, provenance.commit)
    || producer.ref !== provenance.ref || producer.runId !== provenance.runId || producer.runAttempt !== provenance.runAttempt
    || producer.trustedWorkflowRepository !== "Plasius-LTD/gpu-shader" || producer.trustedWorkflowRef !== provenance.workflowRef
    || !canonicalEqual(producer.trustedWorkflowSha, provenance.workflowSha) || producer.job !== expectedJob) throw new TypeError(`${path} does not match the exact qualification workflow run or subject.`);
  if (expectedJob === "swiftshader" && producer.runner.environment !== "github-hosted") throw new TypeError(`${path} must identify the hosted SwiftShader job.`);
  if (expectedJob === "physical" && producer.runner.environment === "github-hosted") throw new TypeError(`${path} cannot use a hosted runner for a physical execution cell.`);
  if (expectedJob === "physical-runner-preflight" && producer.runner.environment !== "github-hosted") throw new TypeError(`${path} must identify its hosted orchestration job truthfully.`);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalizeQualificationGpuContract(left) === canonicalizeQualificationGpuContract(right);
}

function foldRunnerLabel(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}

export async function computeQualificationInventorySha256(bundle: ShaderQualificationBundleManifest): Promise<Sha256Hex> {
  const snapshot = detachedQualificationContract(bundle) as ShaderQualificationBundleManifest;
  return computeSha256(canonicalizeQualificationGpuContract(snapshot.inventory));
}

export async function computeQualificationSubjectBinding(input: {
  readonly subject: ShaderQualificationCandidateSubject;
  readonly dataBundleSha256: Sha256Hex;
  readonly compileUnitInventorySha256: Sha256Hex;
  readonly matrixSha256: Sha256Hex;
  readonly harnessSha256: Sha256Hex;
}): Promise<Sha256Hex> {
  return computeSha256(`plasius.gpu.qualification-subject/v1\n${canonicalizeQualificationGpuContract(input)}`);
}

async function computeValidationEvidenceId(value: unknown): Promise<string> {
  const input = object(value, "evidence identity input");
  const projection = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "evidenceId"));
  return `qualification-${(await computeSha256(`plasius.gpu.validation-evidence/v1\n${canonicalizeQualificationGpuContract(projection)}`)).slice(0, 24)}`;
}

function immutableBlobUri(value: string): { host: string; versionId: string; uri: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Source URI must be a normalized immutable Azure Blob .tar URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port
    || !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/u.test(url.hostname)
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*\.tar$/u.test(url.pathname.slice(1))
    || url.pathname.split("/").some((segment, index) => index > 0 && (!segment || segment === "." || segment === ".."))) {
    throw new TypeError("Source URI must be a normalized immutable Azure Blob .tar URL.");
  }
  const versionIds = [...url.searchParams.entries()].filter(([key]) => key.toLowerCase() === "versionid");
  if ([...url.searchParams.keys()].length !== 1 || versionIds.length !== 1 || !/^[A-Za-z0-9._:-]{1,128}$/u.test(versionIds[0]![1])) throw new TypeError("Source URI must use exactly one versionId and no other query parameters.");
  return { host: url.host.toLowerCase(), versionId: versionIds[0]![1], uri: value };
}

/** Creates the trusted prepare artifact without persisting an OIDC token. */
export async function createQualificationPreflight(input: {
  readonly qualificationId: string;
  readonly bundle: ShaderQualificationBundleManifest;
  readonly matrix: StableWebGpuMatrixManifest;
  readonly matrixBytes: Uint8Array;
  readonly sourceUri: string;
  readonly dataBundleSha256: Sha256Hex;
  readonly matrixSha256: Sha256Hex;
  readonly harnessSha256: Sha256Hex;
  readonly provenance: ShaderTrustedWorkflowProvenance;
}): Promise<ShaderQualificationPreflightManifest> {
  token(input.qualificationId, "qualificationId");
  const parsedMatrix = parseQualificationJsonBytes(input.matrixBytes, "Selected matrix artifact");
  if (!canonicalEqual(parsedMatrix, input.matrix)) throw new TypeError("Selected matrix artifact bytes differ from the supplied matrix value.");
  const actualMatrixSha256 = await computeSha256(input.matrixBytes);
  if (actualMatrixSha256 !== input.matrixSha256) throw new TypeError("Selected matrix digest is not derived from the exact matrix manifest.");
  const inventorySha256 = await computeQualificationInventorySha256(input.bundle);
  if (inventorySha256 !== input.bundle.subject.compileUnitInventorySha256) throw new TypeError("Bundle subject contains a stale compile-unit inventory digest.");
  const requiredCells = input.matrix.cells.map((cell) => cell.cellId);
  if (!canonicalEqual(input.bundle.subject.requiredCellIds, requiredCells)) throw new TypeError("Bundle subject cell set differs from the selected matrix.");
  const subjectBindingSha256 = await computeQualificationSubjectBinding({
    subject: input.bundle.subject,
    dataBundleSha256: input.dataBundleSha256,
    compileUnitInventorySha256: inventorySha256,
    matrixSha256: input.matrixSha256,
    harnessSha256: input.harnessSha256,
  });
  return {
    contractVersion: SHADER_VALIDATION_EVIDENCE_VERSION,
    kind: "shader-qualification-preflight",
    qualificationId: input.qualificationId,
    sourceBlob: immutableBlobUri(input.sourceUri),
    dataBundleSha256: input.dataBundleSha256,
    compileUnitInventorySha256: inventorySha256,
    matrixSha256: input.matrixSha256,
    harnessSha256: input.harnessSha256,
    subjectBindingSha256,
    provenance: parseTrustedWorkflowProvenance(input.provenance, "preflight.provenance"),
  };
}

function assertDiagnostic(value: unknown, path: string): ShaderDiagnostic {
  const input = object(value, path); const allowed = new Set(["code", "severity", "message", "path", "expected", "actual"]);
  if (!Object.keys(input).every((key) => allowed.has(key)) || !["code", "severity", "message"].every((key) => key in input)) throw new TypeError(`${path} has unknown or missing fields.`);
  token(input.code, `${path}.code`); if (!["error", "warning", "info"].includes(String(input.severity))) throw new TypeError(`${path}.severity is invalid.`); token(input.message, `${path}.message`, 4096); if (input.path !== undefined) token(input.path, `${path}.path`, 1024);
  return input as unknown as ShaderDiagnostic;
}

const phaseNames = ["assembly", "reflection-schema", "shader-compilation", "pipeline-layout", "pipeline-creation", "bind-group-creation", "cpu-to-gpu-layout", "gpu-to-cpu-layout", "bounded-execution", "semantic-readback"] as const;

function osVersionMatches(cell: StableWebGpuMatrixCell, version: string, channel: string | null): boolean {
  if (!/^\d+(?:\.\d+)*(?:[-+][A-Za-z0-9.]+)?$/u.test(version)) return false;
  const requirement = cell.os.versionRequirement;
  if (requirement.kind === "exact") return channel === null && version === requirement.value;
  const major = Number.parseInt(version.split(".")[0]!, 10);
  if (requirement.kind === "major") return channel === null && major === requirement.value;
  if (requirement.kind === "minimum-major") return channel === null && major >= requirement.value;
  return channel === requirement.channel;
}

function assertResult(value: unknown, path: string, cell: StableWebGpuMatrixCell, passingRequired: boolean, timeBounds?: { readonly earliest: string; readonly latest: string }, expectedRunner?: { readonly name: string; readonly labels: readonly string[] }): ShaderQualificationResult {
  const input = object(value, path); exact(input, ["compileUnitId", "cellId", "status", "startedAt", "completedAt", "observed", "phases", "diagnostics"], path);
  token(input.compileUnitId, `${path}.compileUnitId`); if (input.cellId !== cell.cellId) throw new TypeError(`${path}.cellId differs from its cell evidence.`);
  const status = String(input.status) as ShaderQualificationStatus; if (!["passed", "failed", "skipped", "timeout", "device-lost", "runner-unavailable", "adapter-unavailable"].includes(status)) throw new TypeError(`${path}.status is invalid.`);
  const started = timestamp(input.startedAt, `${path}.startedAt`); const completed = timestamp(input.completedAt, `${path}.completedAt`); if (Date.parse(completed) < Date.parse(started)) throw new TypeError(`${path} has reversed timestamps.`); if (timeBounds && (Date.parse(started) < Date.parse(timeBounds.earliest) || Date.parse(completed) > Date.parse(timeBounds.latest))) throw new TypeError(`${path} timestamps fall outside trusted preflight and aggregation bounds.`);
  const observed = object(input.observed, `${path}.observed`); exact(observed, ["runner", "os", "browser", "adapter", "features", "limits"], `${path}.observed`);
  const runner = object(observed.runner, `${path}.observed.runner`); exact(runner, ["id", "labels"], `${path}.observed.runner`); const runnerId = token(runner.id, `${path}.observed.runner.id`); const labels = array(runner.labels, `${path}.observed.runner.labels`).map((item, index) => token(item, `${path}.observed.runner.labels[${index}]`)); const normalizedLabels = labels.map(foldRunnerLabel); if (new Set(normalizedLabels).size !== normalizedLabels.length || cell.runnerLabels.some((label) => !normalizedLabels.includes(foldRunnerLabel(label)))) throw new TypeError(`${path} actual runner labels do not contain the matrix route (ASCII case-insensitive).`); if (expectedRunner && (runnerId !== expectedRunner.name || !canonicalEqual(labels, expectedRunner.labels))) throw new TypeError(`${path} runner identity/labels differ from the exact runner API preflight observation.`);
  const os = object(observed.os, `${path}.observed.os`); exact(os, ["name", "version", "channel", "architecture"], `${path}.observed.os`); const osVersion = token(os.version, `${path}.observed.os.version`); const osChannel = os.channel === null ? null : token(os.channel, `${path}.observed.os.channel`); if (os.name !== cell.os.name || os.architecture !== cell.os.architecture || (status === "passed" && !osVersionMatches(cell, osVersion, osChannel)) || (status !== "passed" && osVersion !== "unavailable" && !osVersionMatches(cell, osVersion, osChannel))) throw new TypeError(`${path} observed the wrong OS target or failed its version requirement.`);
  const browser = object(observed.browser, `${path}.observed.browser`); exact(browser, ["name", "version", "channel"], `${path}.observed.browser`); if (browser.name !== cell.browser.name || browser.channel !== cell.browser.channel) throw new TypeError(`${path} observed the wrong browser target.`); const browserVersion = token(browser.version, `${path}.observed.browser.version`);
  const adapter = object(observed.adapter, `${path}.observed.adapter`); exact(adapter, ["physical", "vendor", "family", "architecture", "device", "description", "backend", "driver"], `${path}.observed.adapter`); if (adapter.physical !== (cell.adapter.kind === "physical") || adapter.backend !== cell.adapter.backend || String(adapter.vendor).trim().toLowerCase() !== cell.adapter.vendor || String(adapter.family).trim().toLowerCase() !== cell.adapter.family) throw new TypeError(`${path} observed the wrong adapter vendor/family/backend.`); for (const key of ["vendor", "family", "architecture", "device", "description", "driver"]) token(adapter[key], `${path}.observed.adapter.${key}`, 1024);
  const features = array(observed.features, `${path}.observed.features`).map((item, index) => token(item, `${path}.observed.features[${index}]`)); if (new Set(features).size !== features.length) throw new TypeError(`${path}.observed.features contains duplicates.`); const limits = object(observed.limits, `${path}.observed.limits`); for (const [name, limit] of Object.entries(limits)) { token(name, `${path}.observed.limits key`); if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) throw new TypeError(`${path}.observed.limits.${name} is invalid.`); }
  const phases = array(input.phases, `${path}.phases`, phaseNames.length).map((phaseValue, index) => { const phasePath = `${path}.phases[${index}]`; const phase = object(phaseValue, phasePath); const name = String(phase.name); if (name === "shader-compilation") { exact(phase, ["name", "status", "durationMs", "compilationMessagesSha256", "errorCount"], phasePath); sha(phase.compilationMessagesSha256, `${phasePath}.compilationMessagesSha256`); integer(phase.errorCount, `${phasePath}.errorCount`); } else if (name === "semantic-readback") { exact(phase, ["name", "status", "durationMs", "expectedSha256", "actualSha256"], phasePath); sha(phase.expectedSha256, `${phasePath}.expectedSha256`); sha(phase.actualSha256, `${phasePath}.actualSha256`); } else { exact(phase, ["name", "status", "durationMs", "evidenceSha256"], phasePath); sha(phase.evidenceSha256, `${phasePath}.evidenceSha256`); } if (!phaseNames.includes(name as typeof phaseNames[number]) || !["passed", "failed"].includes(String(phase.status))) throw new TypeError(`${phasePath} is invalid.`); integer(phase.durationMs, `${phasePath}.durationMs`); return phase; });
  const diagnostics = array(input.diagnostics, `${path}.diagnostics`, 256).map((item, index) => assertDiagnostic(item, `${path}.diagnostics[${index}]`));
  if (passingRequired || status === "passed") {
    if (status !== "passed" || phases.length !== phaseNames.length || !phaseNames.every((name, index) => phases[index]?.name === name && phases[index]?.status === "passed")) throw new TypeError(`${path} lacks all ten passed qualification phases in fixed order.`);
    if (runnerId === "unavailable" || browserVersion === "unavailable" || adapter.device === "unavailable" || adapter.driver === "unavailable") throw new TypeError(`${path} passed without concrete runner/browser/adapter/driver observations.`);
    const compilation = phases.find((phase) => phase.name === "shader-compilation")!; if (compilation.errorCount !== 0) throw new TypeError(`${path} contains compilation errors.`);
    const readback = phases.find((phase) => phase.name === "semantic-readback")!; if (readback.expectedSha256 !== readback.actualSha256) throw new TypeError(`${path} semantic readback differs.`);
    if (diagnostics.some((item) => item.severity === "error")) throw new TypeError(`${path} passed with an error diagnostic.`);
  }
  return input as unknown as ShaderQualificationResult;
}

function assertCellEvidence(value: unknown, cell: StableWebGpuMatrixCell, matrix: StableWebGpuMatrixManifest, preflight: ShaderQualificationPreflightManifest, harness: { id: string; version: string; sha256: Sha256Hex }, adapterHarness: { readonly id: string; readonly version: string; readonly sha256: Sha256Hex } | null, expectedRunner: { readonly name: string; readonly labels: readonly string[] }, expectedUnits: ReadonlySet<string>, latest: string): ShaderCellEvidence {
  const input = object(value, `cellEvidence.${cell.cellId}`); exact(input, ["contractVersion", "qualificationId", "matrixId", "matrixVersion", "matrixSha256", "cellId", "dataBundleSha256", "compileUnitInventorySha256", "harness", "automation", "subjectBindingSha256", "qualificationPreflightProvenance", "producer", "results"], `cellEvidence.${cell.cellId}`);
  if (input.contractVersion !== SHADER_VALIDATION_EVIDENCE_VERSION || input.qualificationId !== preflight.qualificationId || input.matrixId !== matrix.matrixId || input.matrixVersion !== matrix.version || input.cellId !== cell.cellId || input.matrixSha256 !== preflight.matrixSha256 || input.dataBundleSha256 !== preflight.dataBundleSha256 || input.compileUnitInventorySha256 !== preflight.compileUnitInventorySha256 || input.subjectBindingSha256 !== preflight.subjectBindingSha256) throw new TypeError(`Cell evidence ${cell.cellId} has stale subject/matrix identities.`);
  const actualHarness = object(input.harness, `cellEvidence.${cell.cellId}.harness`); exact(actualHarness, ["id", "version", "sha256"], `cellEvidence.${cell.cellId}.harness`); if (!canonicalEqual(actualHarness, harness)) throw new TypeError(`Cell evidence ${cell.cellId} used a different harness.`);
  const automation = object(input.automation, `cellEvidence.${cell.cellId}.automation`); exact(automation, ["kind", "driver", "version", "sha256"], `cellEvidence.${cell.cellId}.automation`); if (automation.kind !== cell.automation.kind) throw new TypeError(`Cell evidence ${cell.cellId} used the wrong automation route.`); token(automation.driver, `cellEvidence.${cell.cellId}.automation.driver`); token(automation.version, `cellEvidence.${cell.cellId}.automation.version`); sha(automation.sha256, `cellEvidence.${cell.cellId}.automation.sha256`); if (adapterHarness !== null && !canonicalEqual({ id: automation.driver, version: automation.version, sha256: automation.sha256 }, adapterHarness)) throw new TypeError(`Cell evidence ${cell.cellId} automation differs from its independently verified preflight adapter harness.`);
  if (!canonicalEqual(parseTrustedWorkflowProvenance(input.qualificationPreflightProvenance), preflight.provenance)) throw new TypeError(`Cell evidence ${cell.cellId} changed trusted prepare provenance.`);
  const producer = parseQualificationExecutionProducer(input.producer, `cellEvidence.${cell.cellId}.producer`); assertProducerMatchesPreflight(producer, preflight.provenance, cell, `cellEvidence.${cell.cellId}.producer`, cell.adapter.kind === "software" ? "swiftshader" : "physical");
  const results = array(input.results, `cellEvidence.${cell.cellId}.results`); if (results.length !== expectedUnits.size) throw new TypeError(`Cell evidence ${cell.cellId} result count is incomplete.`); const ids = new Set<string>(); results.forEach((result, index) => { const parsed = assertResult(result, `cellEvidence.${cell.cellId}.results[${index}]`, cell, true, { earliest: preflight.provenance.oidcAttestation.verifiedAt, latest }, expectedRunner); if (parsed.observed.runner.id !== producer.runner.name) throw new TypeError(`Cell evidence ${cell.cellId} result runner differs from its producer.`); if (!expectedUnits.has(parsed.compileUnitId) || ids.has(parsed.compileUnitId)) throw new TypeError(`Cell evidence ${cell.cellId} has duplicate/unexpected compile unit ${parsed.compileUnitId}.`); ids.add(parsed.compileUnitId); });
  return input as unknown as ShaderCellEvidence;
}

function syntheticResult(unitId: string, cell: StableWebGpuMatrixCell, status: ShaderQualificationStatus, message: string, now: string): ShaderQualificationResult {
  return {
    compileUnitId: unitId, cellId: cell.cellId, status, startedAt: now, completedAt: now,
    observed: {
      runner: { id: "unavailable", labels: cell.runnerLabels },
      os: { name: cell.os.name, version: "unavailable", channel: null, architecture: cell.os.architecture },
      browser: { name: cell.browser.name, version: "unavailable", channel: cell.browser.channel },
      adapter: { physical: cell.adapter.kind === "physical", vendor: cell.adapter.vendor, family: cell.adapter.family, architecture: cell.os.architecture, device: "unavailable", description: "unavailable", backend: cell.adapter.backend, driver: "unavailable" },
      features: [], limits: {},
    }, phases: [], diagnostics: [{ code: status === "timeout" ? "timeout" : "runner-unavailable", severity: "error", message }],
  };
}

export interface AggregateShaderValidationEvidenceInput {
  readonly bundle: ShaderQualificationBundleManifest;
  readonly matrix: StableWebGpuMatrixManifest;
  readonly matrixBytes: Uint8Array;
  readonly preflight: EvidenceArtifact<ShaderQualificationPreflightManifest>;
  readonly cellEvidence: readonly EvidenceArtifact<ShaderCellEvidence>[];
  readonly runnerPreflights: readonly EvidenceArtifact<ShaderRunnerCellPreflightEvidence>[];
  readonly workflowDiagnostics: readonly EvidenceArtifact<ShaderNonQualifyingWorkflowDiagnostic>[];
  readonly harness: { readonly id: string; readonly version: string; readonly sha256: Sha256Hex };
  readonly packageVersion: string;
  readonly generatedAt?: string;
}

/** Aggregates exactly one immutable result for every compile-unit × matrix-cell pair. */
export async function aggregateShaderValidationEvidence(input: AggregateShaderValidationEvidenceInput): Promise<ShaderValidationEvidence> {
  const verifyArtifact = async <T>(artifact: EvidenceArtifact<T>, label: string): Promise<void> => {
    if (await computeSha256(artifact.bytes) !== artifact.sha256) throw new TypeError(`${label} artifact digest is not derived from its exact bytes.`);
    const parsed = parseQualificationJsonBytes(artifact.bytes, `${label} bytes`);
    if (!canonicalEqual(parsed, artifact.value)) throw new TypeError(`${label} parsed value differs from its exact bytes.`);
  };
  await verifyArtifact(input.preflight, "Qualification preflight");
  for (const artifact of input.cellEvidence) await verifyArtifact(artifact, "Cell evidence");
  for (const artifact of input.runnerPreflights) await verifyArtifact(artifact, "Runner preflight");
  for (const artifact of input.workflowDiagnostics) await verifyArtifact(artifact, "Workflow diagnostic");
  const preflight = input.preflight.value; const preflightInput = object(preflight, "Qualification preflight"); exact(preflightInput, ["contractVersion", "kind", "qualificationId", "sourceBlob", "dataBundleSha256", "compileUnitInventorySha256", "matrixSha256", "harnessSha256", "subjectBindingSha256", "provenance"], "Qualification preflight"); if (preflight.contractVersion !== SHADER_VALIDATION_EVIDENCE_VERSION || preflight.kind !== "shader-qualification-preflight") throw new TypeError("Missing trusted qualification preflight.");
  token(preflight.qualificationId, "Qualification preflight.qualificationId"); sha(preflight.dataBundleSha256, "Qualification preflight.dataBundleSha256"); sha(preflight.compileUnitInventorySha256, "Qualification preflight.compileUnitInventorySha256"); sha(preflight.matrixSha256, "Qualification preflight.matrixSha256"); sha(preflight.harnessSha256, "Qualification preflight.harnessSha256"); sha(preflight.subjectBindingSha256, "Qualification preflight.subjectBindingSha256"); const preflightProvenance = parseTrustedWorkflowProvenance(preflight.provenance, "Qualification preflight.provenance");
  const sourceBlob = object(preflight.sourceBlob, "Qualification preflight.sourceBlob"); exact(sourceBlob, ["host", "versionId", "uri"], "Qualification preflight.sourceBlob"); const normalizedSource = immutableBlobUri(token(sourceBlob.uri, "Qualification preflight.sourceBlob.uri", 2048)); if (!canonicalEqual(sourceBlob, normalizedSource)) throw new TypeError("Qualification preflight source Blob claims are stale.");
  const parsedMatrix = parseQualificationJsonBytes(input.matrixBytes, "Matrix artifact"); if (!canonicalEqual(parsedMatrix, input.matrix)) throw new TypeError("Matrix artifact bytes differ from the supplied matrix value."); const actualMatrixSha256 = await computeSha256(input.matrixBytes); if (preflight.matrixSha256 !== actualMatrixSha256) throw new TypeError("Qualification preflight matrix artifact digest is stale.");
  const actualInventorySha256 = await computeQualificationInventorySha256(input.bundle); if (preflight.compileUnitInventorySha256 !== actualInventorySha256 || input.bundle.subject.compileUnitInventorySha256 !== actualInventorySha256) throw new TypeError("Qualification preflight inventory digest is stale.");
  const actualSubjectBinding = await computeQualificationSubjectBinding({ subject: input.bundle.subject, dataBundleSha256: preflight.dataBundleSha256, compileUnitInventorySha256: actualInventorySha256, matrixSha256: actualMatrixSha256, harnessSha256: input.harness.sha256 }); if (preflight.subjectBindingSha256 !== actualSubjectBinding) throw new TypeError("Qualification preflight subject binding is stale.");
  const units = new Set(input.bundle.inventory.compileUnits.map((unit) => unit.compileUnitId)); const now = input.generatedAt ?? new Date().toISOString(); timestamp(now, "generatedAt"); if (Date.parse(now) < Date.parse(preflightProvenance.oidcAttestation.verifiedAt)) throw new TypeError("Aggregate timestamp predates trusted preflight verification.");
  if (input.harness.sha256 !== preflight.harnessSha256) throw new TypeError("Harness digest differs from trusted preflight.");
  const cells = new Map(input.matrix.cells.map((cell) => [cell.cellId, cell]));
  const cellArtifacts = new Map<string, EvidenceArtifact<ShaderCellEvidence>>(); for (const artifact of input.cellEvidence) { const id = artifact.value.cellId; if (!cells.has(id) || cellArtifacts.has(id)) throw new TypeError(`Duplicate or unexpected cell evidence ${id}.`); cellArtifacts.set(id, artifact); }
  const runnerArtifacts = new Map<string, EvidenceArtifact<ShaderRunnerCellPreflightEvidence>>(); for (const artifact of input.runnerPreflights) { const id = artifact.value.cellId; if (!cells.has(id) || runnerArtifacts.has(id)) throw new TypeError(`Duplicate or unexpected runner preflight ${id}.`); runnerArtifacts.set(id, artifact); }
  const diagnosticArtifacts = new Map<string, EvidenceArtifact<ShaderNonQualifyingWorkflowDiagnostic>>(); for (const artifact of input.workflowDiagnostics) { const id = artifact.value.cellId; if (!cells.has(id) || diagnosticArtifacts.has(id)) throw new TypeError(`Duplicate or unexpected workflow diagnostic ${id}.`); diagnosticArtifacts.set(id, artifact); }
  const results: ShaderQualificationResult[] = []; const cellRuns: ShaderValidationCellRun[] = [];
  for (const cell of input.matrix.cells) {
    const runner = runnerArtifacts.get(cell.cellId); const diagnostic = diagnosticArtifacts.get(cell.cellId); const cellArtifact = cellArtifacts.get(cell.cellId);
    if (!runner) throw new TypeError(`Cell ${cell.cellId} lacks runner preflight evidence.`);
    if (runner) {
      const value = runner.value; const raw = object(value, `runnerPreflight.${cell.cellId}`); exact(raw, ["contractVersion", "kind", "qualificationId", "cellId", "status", "matrixSha256", "runnerLabels", "matchedRunners", "adapterHarness", "qualificationPreflightProvenance", "producer"], `runnerPreflight.${cell.cellId}`); const producer = parseQualificationExecutionProducer(value.producer, `runnerPreflight.${cell.cellId}.producer`); assertProducerMatchesPreflight(producer, preflight.provenance, cell, `runnerPreflight.${cell.cellId}.producer`, cell.adapter.kind === "software" ? "swiftshader" : "physical-runner-preflight"); if (value.contractVersion !== SHADER_VALIDATION_EVIDENCE_VERSION || value.kind !== "shader-runner-cell-preflight-evidence" || value.qualificationId !== preflight.qualificationId || value.cellId !== cell.cellId || value.matrixSha256 !== preflight.matrixSha256 || !canonicalEqual(value.runnerLabels, cell.runnerLabels) || !canonicalEqual(value.qualificationPreflightProvenance, preflight.provenance)) throw new TypeError(`Runner preflight ${cell.cellId} is stale or inconsistent.`);
      const requestedLabels = cell.runnerLabels.map(foldRunnerLabel); const matched = array(value.matchedRunners, `runnerPreflight.${cell.cellId}.matchedRunners`).map((item, index) => { const label = `runnerPreflight.${cell.cellId}.matchedRunners[${index}]`; const match = object(item, label); exact(match, ["name", "labels"], label); const labels = array(match.labels, `${label}.labels`).map((entry, labelIndex) => token(entry, `${label}.labels[${labelIndex}]`)); const normalized = labels.map(foldRunnerLabel); if (labels.length === 0 || new Set(normalized).size !== normalized.length || requestedLabels.some((required) => !normalized.includes(required))) throw new TypeError(`${label} does not preserve the actual runner API labels containing the requested matrix route.`); return { name: token(match.name, `${label}.name`), labels }; }); if (new Set(matched.map((item) => item.name)).size !== matched.length) throw new TypeError(`Runner preflight ${cell.cellId} repeats matched runners.`);
      if (value.adapterHarness !== null) { const adapterHarness = object(value.adapterHarness, `runnerPreflight.${cell.cellId}.adapterHarness`); exact(adapterHarness, ["id", "version", "sha256"], `runnerPreflight.${cell.cellId}.adapterHarness`); token(adapterHarness.id, `runnerPreflight.${cell.cellId}.adapterHarness.id`); token(adapterHarness.version, `runnerPreflight.${cell.cellId}.adapterHarness.version`); sha(adapterHarness.sha256, `runnerPreflight.${cell.cellId}.adapterHarness.sha256`); }
      if (value.status === "available" && matched.length === 0) throw new TypeError(`Available cell ${cell.cellId} has no matched runner.`);
      if (value.status === "runner-unavailable" && matched.length !== 0) throw new TypeError(`Unavailable cell ${cell.cellId} claims matched runners.`);
      if (value.status === "runner-unavailable" && value.adapterHarness !== null) throw new TypeError(`Unavailable cell ${cell.cellId} claims an executed adapter harness.`);
      if (value.status === "available" && cell.adapter.kind === "software" && value.adapterHarness === null) throw new TypeError(`Hosted SwiftShader cell ${cell.cellId} lacks its independently observable adapter harness.`);
    }
    if (diagnostic && cellArtifact) throw new TypeError(`Cell ${cell.cellId} has conflicting diagnostic and qualification evidence.`);
    if (runner?.value.status === "runner-unavailable") {
      if (cellArtifact || diagnostic) throw new TypeError(`Unavailable cell ${cell.cellId} has conflicting evidence.`);
      for (const unit of units) results.push(syntheticResult(unit, cell, "runner-unavailable", "Required physical runner was unavailable.", now));
      const cellResults = results.slice(-units.size); cellRuns.push({ cellId: cell.cellId, source: "runner-preflight", sourceArtifactSha256: runner.sha256, resultsSha256: await computeSha256(canonicalizeQualificationGpuContract(cellResults)), qualificationPreflightProvenance: preflight.provenance, producer: runner.value.producer, harness: input.harness, automation: null, resultCount: units.size, status: "runner-unavailable" });
      continue;
    }
    if (diagnostic) {
      const value = diagnostic.value; const raw = object(value, `workflowDiagnostic.${cell.cellId}`); exact(raw, ["contractVersion", "kind", "qualificationId", "cellId", "status", "matrixSha256", "message", "qualificationPreflightProvenance", "producer"], `workflowDiagnostic.${cell.cellId}`); const producer = parseQualificationExecutionProducer(value.producer, `workflowDiagnostic.${cell.cellId}.producer`); assertProducerMatchesPreflight(producer, preflight.provenance, cell, `workflowDiagnostic.${cell.cellId}.producer`, cell.adapter.kind === "software" ? "swiftshader" : "physical"); if (!runner.value.matchedRunners.some((item) => item.name === producer.runner.name)) throw new TypeError(`Workflow diagnostic ${cell.cellId} was not produced by a runner matched in preflight.`); if (value.contractVersion !== SHADER_VALIDATION_EVIDENCE_VERSION || value.kind !== "non-qualifying-workflow-diagnostic" || value.qualificationId !== preflight.qualificationId || value.cellId !== cell.cellId || value.matrixSha256 !== preflight.matrixSha256 || !canonicalEqual(value.qualificationPreflightProvenance, preflight.provenance)) throw new TypeError(`Workflow diagnostic ${cell.cellId} is stale or inconsistent.`); token(value.message, `workflowDiagnostic.${cell.cellId}.message`, 4096);
      const status = value.status === "timeout" ? "timeout" : "failed"; for (const unit of units) results.push(syntheticResult(unit, cell, status, value.message, now));
      const cellResults = results.slice(-units.size); cellRuns.push({ cellId: cell.cellId, source: "workflow-diagnostic", sourceArtifactSha256: diagnostic.sha256, resultsSha256: await computeSha256(canonicalizeQualificationGpuContract(cellResults)), qualificationPreflightProvenance: preflight.provenance, producer: value.producer, harness: input.harness, automation: null, resultCount: units.size, status });
      continue;
    }
    if (!cellArtifact) throw new TypeError(`Cell ${cell.cellId} has no qualification evidence.`);
    const matchedRunner = runner.value.matchedRunners.find((item) => item.name === cellArtifact.value.producer.runner.name); if (!matchedRunner) throw new TypeError(`Cell evidence ${cell.cellId} producer was not matched by runner preflight.`); const value = assertCellEvidence(cellArtifact.value, cell, input.matrix, preflight, input.harness, runner.value.adapterHarness, matchedRunner, units, now); results.push(...value.results);
    cellRuns.push({ cellId: cell.cellId, source: "cell-evidence", sourceArtifactSha256: cellArtifact.sha256, resultsSha256: await computeSha256(canonicalizeQualificationGpuContract(value.results)), qualificationPreflightProvenance: value.qualificationPreflightProvenance, producer: value.producer, harness: value.harness, automation: value.automation, resultCount: value.results.length, status: "passed" });
  }
  const expectedResults = units.size * cells.size; if (results.length !== expectedResults) throw new TypeError("Aggregate result product is incomplete.");
  const status: ShaderValidationEvidence["status"] = results.every((result) => result.status === "passed") ? "passed" : "failed";
  const subject = { ...input.bundle.subject, dataBundleSha256: preflight.dataBundleSha256 };
  const draft = {
    contractVersion: SHADER_VALIDATION_EVIDENCE_VERSION,
    status, generatedAt: now, subjectBindingSha256: preflight.subjectBindingSha256, subject,
    matrixRef: { matrixId: input.matrix.matrixId, version: input.matrix.version, sha256: preflight.matrixSha256 },
    toolchain: { packageVersion: input.packageVersion, reflectorVersion: "1.5.0" as const, harness: input.harness },
    qualificationPreflightProvenance: preflight.provenance,
    counts: { compileUnits: units.size, cells: cells.size, expectedResults, passedResults: results.filter((result) => result.status === "passed").length },
    cellRuns,
    results,
  };
  return { ...draft, evidenceId: await computeValidationEvidenceId(draft) };
}

/** Validates final aggregate identities and exact Cartesian coverage. */
export async function validateShaderValidationEvidence(input: {
  readonly evidence: unknown;
  readonly bundle: ShaderQualificationBundleManifest;
  readonly matrix: StableWebGpuMatrixManifest;
  readonly matrixBytes: Uint8Array;
  readonly dataBundleSha256?: Sha256Hex;
  readonly requirePassed?: boolean;
}): Promise<ShaderResult<ShaderValidationEvidence>> {
  try {
    const evidence = object(detachedQualificationContract(input.evidence), "evidence");
    const bundle = detachedQualificationContract(input.bundle) as unknown as ShaderQualificationBundleManifest;
    const matrix = detachedQualificationContract(input.matrix) as unknown as StableWebGpuMatrixManifest;
    exact(evidence, ["contractVersion", "evidenceId", "status", "generatedAt", "subjectBindingSha256", "subject", "matrixRef", "toolchain", "qualificationPreflightProvenance", "counts", "cellRuns", "results"], "evidence");
    if (evidence.contractVersion !== SHADER_VALIDATION_EVIDENCE_VERSION) throw new TypeError("Unsupported evidence contract version.");
    const evidenceId = token(evidence.evidenceId, "evidence.evidenceId"); const generatedAt = timestamp(evidence.generatedAt, "evidence.generatedAt"); const subjectBindingSha256 = sha(evidence.subjectBindingSha256, "evidence.subjectBindingSha256");
    if (evidence.status !== "passed" && evidence.status !== "failed") throw new TypeError("Evidence status is invalid.");

    const parsedMatrix = parseQualificationJsonBytes(input.matrixBytes, "Matrix artifact");
    if (!canonicalEqual(parsedMatrix, matrix)) throw new TypeError("Matrix artifact bytes differ from the supplied matrix value.");
    const matrixSha256 = await computeSha256(input.matrixBytes);
    const inventorySha256 = await computeQualificationInventorySha256(bundle);
    if (inventorySha256 !== bundle.subject.compileUnitInventorySha256) throw new TypeError("Bundle subject inventory digest is stale.");

    const subject = object(evidence.subject, "evidence.subject"); const expectedSubjectKeys = [...Object.keys(bundle.subject), "dataBundleSha256"]; exact(subject, expectedSubjectKeys, "evidence.subject");
    const candidateSubject = Object.fromEntries(Object.entries(subject).filter(([key]) => key !== "dataBundleSha256")); if (!canonicalEqual(candidateSubject, bundle.subject)) throw new TypeError("Evidence candidate subject differs from bundle.");
    const dataBundleSha256 = sha(subject.dataBundleSha256, "evidence.subject.dataBundleSha256"); if (input.dataBundleSha256 && input.dataBundleSha256 !== dataBundleSha256) throw new TypeError("Evidence data bundle digest differs from the exact archive.");
    if (subject.compileUnitInventorySha256 !== inventorySha256) throw new TypeError("Evidence compile-unit inventory digest is stale.");

    const matrixRef = object(evidence.matrixRef, "evidence.matrixRef"); exact(matrixRef, ["matrixId", "version", "sha256"], "evidence.matrixRef"); if (matrixRef.matrixId !== matrix.matrixId || matrixRef.version !== matrix.version || matrixRef.sha256 !== matrixSha256) throw new TypeError("Evidence matrix artifact identity differs.");
    const toolchain = object(evidence.toolchain, "evidence.toolchain"); exact(toolchain, ["packageVersion", "reflectorVersion", "harness"], "evidence.toolchain"); token(toolchain.packageVersion, "evidence.toolchain.packageVersion"); if (toolchain.reflectorVersion !== "1.5.0") throw new TypeError("Evidence reflector version differs."); const harness = object(toolchain.harness, "evidence.toolchain.harness"); exact(harness, ["id", "version", "sha256"], "evidence.toolchain.harness"); token(harness.id, "evidence.toolchain.harness.id"); token(harness.version, "evidence.toolchain.harness.version"); const harnessSha256 = sha(harness.sha256, "evidence.toolchain.harness.sha256");
    const preflightProvenance = parseTrustedWorkflowProvenance(evidence.qualificationPreflightProvenance, "evidence.qualificationPreflightProvenance"); if (Date.parse(generatedAt) < Date.parse(preflightProvenance.oidcAttestation.verifiedAt)) throw new TypeError("Evidence predates trusted preflight verification.");
    const expectedBinding = await computeQualificationSubjectBinding({ subject: bundle.subject, dataBundleSha256, compileUnitInventorySha256: inventorySha256, matrixSha256, harnessSha256 }); if (subjectBindingSha256 !== expectedBinding) throw new TypeError("Evidence subject binding is stale.");
    if (evidenceId !== await computeValidationEvidenceId(evidence)) throw new TypeError("Evidence identity is stale.");

    const units = new Set(bundle.inventory.compileUnits.map((unit) => unit.compileUnitId)); const cells = new Map(matrix.cells.map((cell) => [cell.cellId, cell])); const expected = units.size * cells.size;
    const results = array(evidence.results, "evidence.results"); if (results.length !== expected) throw new TypeError("Evidence result product is incomplete."); const identities = new Set<string>(); const parsedResults: ShaderQualificationResult[] = []; let passed = 0;
    for (const [index, value] of results.entries()) { const raw = object(value, `evidence.results[${index}]`); const cell = cells.get(String(raw.cellId)); if (!cell || !units.has(String(raw.compileUnitId))) throw new TypeError(`Evidence result ${index} is unexpected.`); const result = assertResult(value, `evidence.results[${index}]`, cell, evidence.status === "passed", { earliest: preflightProvenance.oidcAttestation.verifiedAt, latest: generatedAt }); const key = `${result.cellId}:${result.compileUnitId}`; if (identities.has(key)) throw new TypeError(`Evidence repeats ${key}.`); identities.add(key); parsedResults.push(result); if (result.status === "passed") passed += 1; }
    const counts = object(evidence.counts, "evidence.counts"); exact(counts, ["compileUnits", "cells", "expectedResults", "passedResults"], "evidence.counts"); if (counts.compileUnits !== units.size || counts.cells !== cells.size || counts.expectedResults !== expected || counts.passedResults !== passed) throw new TypeError("Evidence counts are stale.");

    const runs = array(evidence.cellRuns, "evidence.cellRuns"); if (runs.length !== cells.size) throw new TypeError("Evidence cell-run provenance is incomplete."); const runIds = new Set<string>();
    for (const [index, value] of runs.entries()) {
      const path = `evidence.cellRuns[${index}]`; const run = object(value, path); exact(run, ["cellId", "source", "sourceArtifactSha256", "resultsSha256", "qualificationPreflightProvenance", "producer", "harness", "automation", "resultCount", "status"], path);
      const cellId = token(run.cellId, `${path}.cellId`); const cell = cells.get(cellId); if (!cell || runIds.has(cellId)) throw new TypeError(`${path}.cellId is duplicate/unexpected.`); runIds.add(cellId);
      if (!["cell-evidence", "runner-preflight", "workflow-diagnostic"].includes(String(run.source))) throw new TypeError(`${path}.source is invalid.`); const sourceArtifactSha256 = sha(run.sourceArtifactSha256, `${path}.sourceArtifactSha256`); if (/^0{64}$/u.test(sourceArtifactSha256)) throw new TypeError(`${path}.sourceArtifactSha256 cannot be a placeholder.`); const resultsSha256 = sha(run.resultsSha256, `${path}.resultsSha256`);
      if (!canonicalEqual(parseTrustedWorkflowProvenance(run.qualificationPreflightProvenance, `${path}.qualificationPreflightProvenance`), preflightProvenance)) throw new TypeError(`${path} changed qualification preflight provenance.`);
      const producer = parseQualificationExecutionProducer(run.producer, `${path}.producer`); const expectedJob: ShaderQualificationExecutionProducer["job"] = run.source === "runner-preflight" ? (cell.adapter.kind === "software" ? "swiftshader" : "physical-runner-preflight") : (cell.adapter.kind === "software" ? "swiftshader" : "physical"); assertProducerMatchesPreflight(producer, preflightProvenance, cell, `${path}.producer`, expectedJob);
      if (!canonicalEqual(run.harness, harness)) throw new TypeError(`${path}.harness differs.`); if (run.source === "cell-evidence") { const automation = object(run.automation, `${path}.automation`); exact(automation, ["kind", "driver", "version", "sha256"], `${path}.automation`); if (automation.kind !== cell.automation.kind) throw new TypeError(`${path}.automation route differs.`); token(automation.driver, `${path}.automation.driver`); token(automation.version, `${path}.automation.version`); sha(automation.sha256, `${path}.automation.sha256`); } else if (run.automation !== null) throw new TypeError(`${path}.automation must be null when no adapter completed a cell run.`);
      const cellResults = parsedResults.filter((result) => result.cellId === cellId); if (run.resultCount !== units.size || cellResults.length !== units.size || await computeSha256(canonicalizeQualificationGpuContract(cellResults)) !== resultsSha256) throw new TypeError(`${path} result count/digest is stale.`);
      const resultStatuses = new Set(cellResults.map((result) => result.status)); if (resultStatuses.size !== 1 || !resultStatuses.has(String(run.status) as ShaderQualificationStatus)) throw new TypeError(`${path}.status differs from its results.`);
      if (run.source === "cell-evidence" && run.status !== "passed") throw new TypeError(`${path} cell evidence must contain passing results.`); if (run.source === "runner-preflight" && run.status !== "runner-unavailable") throw new TypeError(`${path} runner-preflight source has the wrong status.`); if (run.source === "workflow-diagnostic" && run.status !== "failed" && run.status !== "timeout") throw new TypeError(`${path} workflow diagnostic has the wrong status.`);
      if (run.source === "cell-evidence" && cellResults.some((result) => result.observed.runner.id !== producer.runner.name)) throw new TypeError(`${path} producer runner differs from its results.`);
    }
    if ((evidence.status === "passed") !== (passed === expected) || (input.requirePassed !== false && evidence.status !== "passed")) throw new TypeError("Evidence does not satisfy the required passed gate.");
    return { ok: true, value: freezeJson(evidence as unknown as ShaderValidationEvidence) };
  } catch (cause) {
    return { ok: false, diagnostics: [{ code: "invalid-contract", severity: "error", message: cause instanceof Error ? cause.message : "Invalid shader validation evidence." }] };
  }
}

/** Strictly parses an external attestation reference; cryptographic verification remains mandatory. */
export function parseShaderValidationEvidenceAttestationRef(value: unknown): ShaderValidationEvidenceAttestationRef {
  const input = object(detachedQualificationContract(value), "attestationRef"); exact(input, ["contractVersion", "kind", "evidence", "attestation", "producer"], "attestationRef"); if (input.contractVersion !== SHADER_VALIDATION_EVIDENCE_VERSION || input.kind !== "shader-validation-evidence-attestation-ref") throw new TypeError("Unsupported evidence attestation ref.");
  const producer = object(input.producer, "attestationRef.producer"); exact(producer, ["repository", "runId", "runAttempt", "trustedWorkflowRepository", "trustedWorkflowRef", "trustedWorkflowSha"], "attestationRef.producer"); const repository = token(producer.repository, "attestationRef.producer.repository"); if (!/^Plasius-LTD\/[A-Za-z0-9._-]+$/u.test(repository)) throw new TypeError("Attestation caller repository is outside Plasius-LTD or malformed."); if (producer.trustedWorkflowRepository !== "Plasius-LTD/gpu-shader") throw new TypeError("Attestation trusted workflow repository differs."); gitObject(producer.trustedWorkflowSha, "attestationRef.producer.trustedWorkflowSha"); trustedWorkflowRef(producer.trustedWorkflowRef, "attestationRef.producer.trustedWorkflowRef"); token(producer.runId, "attestationRef.producer.runId"); integer(producer.runAttempt, "attestationRef.producer.runAttempt", 1);
  const evidence = object(input.evidence, "attestationRef.evidence"); exact(evidence, ["name", "sha256"], "attestationRef.evidence"); const evidenceName = token(evidence.name, "attestationRef.evidence.name"); if (!/^[A-Za-z0-9._-]+\.json$/u.test(evidenceName)) throw new TypeError("Attested evidence name must be a JSON basename."); sha(evidence.sha256, "attestationRef.evidence.sha256");
  const attestation = object(input.attestation, "attestationRef.attestation"); exact(attestation, ["id", "url", "bundle"], "attestationRef.attestation"); token(attestation.id, "attestationRef.attestation.id"); let url: URL; try { url = new URL(token(attestation.url, "attestationRef.attestation.url", 2048)); } catch { throw new TypeError("Attestation URL must be an exact GitHub repository attestation URL."); } const expectedPrefix = `/${repository}/attestations/`; if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(expectedPrefix) || url.pathname.length <= expectedPrefix.length) throw new TypeError("Attestation URL must be an exact GitHub repository attestation URL."); const bundle = object(attestation.bundle, "attestationRef.attestation.bundle"); exact(bundle, ["name", "sha256"], "attestationRef.attestation.bundle"); const bundleName = token(bundle.name, "attestationRef.attestation.bundle.name"); if (!/^[A-Za-z0-9._-]+\.json$/u.test(bundleName)) throw new TypeError("Attestation bundle name must be a JSON basename."); sha(bundle.sha256, "attestationRef.attestation.bundle.sha256");
  return freezeJson(input as unknown as ShaderValidationEvidenceAttestationRef);
}

export async function verifyShaderValidationEvidenceAttestation(input: {
  readonly ref: unknown;
  readonly evidenceBytes: Uint8Array;
  readonly bundleBytes: Uint8Array;
  readonly verifyCryptographicBundle: (context: { readonly ref: ShaderValidationEvidenceAttestationRef; readonly evidenceBytes: Uint8Array; readonly bundleBytes: Uint8Array }) => Promise<boolean>;
}): Promise<ShaderResult<ShaderValidationEvidenceAttestationRef>> {
  try {
    if (typeof input !== "object" || input === null) throw new TypeError("Evidence attestation verification input is invalid.");
    let values: readonly PropertyDescriptor[];
    try {
      const keys = Reflect.ownKeys(input);
      const expected = ["ref", "evidenceBytes", "bundleBytes", "verifyCryptographicBundle"];
      if (keys.length !== expected.length || keys.some((key) => typeof key !== "string" || !expected.includes(key))) throw new TypeError();
      values = expected.map((key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError();
        return descriptor;
      });
    } catch {
      throw new TypeError("Evidence attestation verification input is invalid.");
    }
    const [refValue, evidenceValue, bundleValue, verifierValue] = values;
    if (typeof verifierValue?.value !== "function") throw new TypeError("Evidence attestation verification input is invalid.");
    const evidenceBytes = snapshotUint8Array(
      evidenceValue?.value,
      QUALIFICATION_GPU_CONTRACT_SNAPSHOT_LIMITS.maximumInputBytes,
    );
    const bundleBytes = snapshotUint8Array(
      bundleValue?.value,
      QUALIFICATION_GPU_CONTRACT_SNAPSHOT_LIMITS.maximumInputBytes,
    );
    const ref = parseShaderValidationEvidenceAttestationRef(refValue?.value);
    if (await computeSha256(evidenceBytes) !== ref.evidence.sha256 || await computeSha256(bundleBytes) !== ref.attestation.bundle.sha256) throw new TypeError("Attested evidence or bundle digest differs.");
    let verified: unknown;
    try {
      verified = await Reflect.apply(verifierValue.value as (...args: unknown[]) => unknown, undefined, [{ ref, evidenceBytes, bundleBytes }]);
    } catch {
      throw new TypeError("External build-provenance cryptographic verification failed.");
    }
    if (verified !== true) throw new TypeError("External build-provenance cryptographic verification failed.");
    return { ok: true, value: ref };
  } catch (cause) { return { ok: false, diagnostics: [{ code: "invalid-contract", severity: "error", message: cause instanceof Error ? cause.message : "Evidence attestation verification failed." }] }; }
}
