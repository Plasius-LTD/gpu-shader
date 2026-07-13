#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { link, open, readdir, readFile, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { admitQualificationBundle } from "./node/bundle-admission.js";
import type {
  ShaderCellEvidence,
  ShaderNonQualifyingWorkflowDiagnostic,
  ShaderQualificationPreflightManifest,
  ShaderRunnerCellPreflightEvidence,
  ShaderValidationEvidence,
  StableWebGpuMatrixManifest,
} from "./contracts.js";
import { SUPPORTED_STABLE_WEBGPU_MATRIX_POLICIES } from "./contracts.js";
import { asSha256Hex, computeSha256 } from "./hash.js";
import {
  aggregateShaderValidationEvidence,
  createQualificationPreflight,
  parseTrustedWorkflowProvenance,
  validateShaderValidationEvidence,
  type EvidenceArtifact,
} from "./testing/evidence.js";
import { validateCompileUnitInventory } from "./testing/inventory.js";
import { validateStableWebGpuMatrix } from "./testing/matrix.js";
import { defaultTrustedQualificationAdapterFactory } from "./testing/runner/adapter-factory.js";
import { runTrustedQualificationCell } from "./testing/runner/cell-runner.js";
import { resolveTrustedFleetAdapterFactory } from "./testing/runner/fleet-registration.js";
import { createHostedSwiftShaderRunnerPreflight } from "./testing/runner/identity.js";
import { readTrustedHarnessPackageMetadata } from "./testing/runner/package-metadata.js";
import { createTrustedWorkflowDiagnostic } from "./testing/runner/workflow-diagnostic.js";

function argumentsMap(values: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index]; const value = values[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--") || result.has(name)) throw new TypeError(`Invalid or duplicate CLI argument ${name ?? "<missing>"}.`);
    result.set(name, value);
  }
  return result;
}

function required(args: ReadonlyMap<string, string>, name: string): string {
  const value = args.get(name); if (!value) throw new TypeError(`${name} is required.`); return value;
}

function exactArgs(args: ReadonlyMap<string, string>, names: readonly string[]): void {
  const expected = new Set(names); for (const name of args.keys()) if (!expected.has(name)) throw new TypeError(`Unsupported argument ${name}.`); for (const name of names) required(args, name);
}

async function bytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}

function json<T>(input: Uint8Array, label: string): T {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input)) as T; }
  catch (cause) { throw new TypeError(`${label} is not UTF-8 JSON.`, { cause }); }
}

async function jsonFile<T>(path: string): Promise<{ value: T; bytes: Uint8Array }> {
  const input = await bytes(path); return { value: json<T>(input, path), bytes: input };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const output = resolve(path);
  const temporary = join(dirname(output), `.${basename(output)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // A same-directory hard link publishes only the already-complete bytes and
    // retains exclusive-create semantics if the final path already exists.
    await link(temporary, output);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function matrixFile(path: string): Promise<{ value: StableWebGpuMatrixManifest; bytes: Uint8Array; sha256: ReturnType<typeof asSha256Hex> }> {
  const loaded = await jsonFile<unknown>(path); const validated = validateStableWebGpuMatrix(loaded.value); if (!validated.ok) throw new TypeError(validated.diagnostics.map((item) => item.message).join("; "));
  const sha256 = await computeSha256(loaded.bytes);
  if (!SUPPORTED_STABLE_WEBGPU_MATRIX_POLICIES.some((policy) =>
    validated.value.matrixId === policy.matrixId
    && validated.value.version === policy.matrixVersion
    && sha256 === policy.matrixSha256)) throw new TypeError("Matrix bytes do not match a supported universal WebGPU matrix policy.");
  return { value: validated.value, bytes: loaded.bytes, sha256 };
}

async function artifact<T>(path: string): Promise<EvidenceArtifact<T>> {
  const loaded = await jsonFile<T>(path); return { value: loaded.value, bytes: loaded.bytes, sha256: await computeSha256(loaded.bytes) };
}

async function listJsonFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => join(directory, entry.name)).sort();
}

async function createPreflight(args: ReadonlyMap<string, string>): Promise<void> {
  exactArgs(args, ["--bundle", "--matrix", "--source-uri", "--bundle-sha256", "--harness-sha256", "--verified-claims", "--output"]);
  const bundle = await admitQualificationBundle(required(args, "--bundle")); const matrix = await matrixFile(required(args, "--matrix"));
  const provenanceInput = await jsonFile<unknown>(required(args, "--verified-claims")); const provenance = parseTrustedWorkflowProvenance(provenanceInput.value);
  const qualificationId = process.env.QUALIFICATION_ID ?? process.env.PLASIUS_QUALIFICATION_ID;
  if (!qualificationId) throw new TypeError("Trusted workflow must set QUALIFICATION_ID or PLASIUS_QUALIFICATION_ID.");
  const preflight = await createQualificationPreflight({
    qualificationId,
    bundle: bundle.manifest,
    matrix: matrix.value,
    matrixBytes: matrix.bytes,
    sourceUri: required(args, "--source-uri"),
    dataBundleSha256: asSha256Hex(required(args, "--bundle-sha256")),
    matrixSha256: matrix.sha256,
    harnessSha256: asSha256Hex(required(args, "--harness-sha256")),
    provenance,
  });
  await writeJson(required(args, "--output"), preflight);
}

async function aggregate(args: ReadonlyMap<string, string>): Promise<void> {
  exactArgs(args, ["--bundle", "--matrix", "--evidence-dir", "--preflight-evidence-dir", "--output"]);
  const bundle = await admitQualificationBundle(required(args, "--bundle")); const matrix = await matrixFile(required(args, "--matrix")); const preflightDirectory = required(args, "--preflight-evidence-dir");
  const preflightPath = join(preflightDirectory, "qualification-preflight.json"); const preflight = await artifact<ShaderQualificationPreflightManifest>(preflightPath);
  const cellEvidence: EvidenceArtifact<ShaderCellEvidence>[] = []; const workflowDiagnostics: EvidenceArtifact<ShaderNonQualifyingWorkflowDiagnostic>[] = [];
  for (const path of await listJsonFiles(required(args, "--evidence-dir"))) { const item = await artifact<ShaderCellEvidence | ShaderNonQualifyingWorkflowDiagnostic>(path); if ((item.value as ShaderNonQualifyingWorkflowDiagnostic).kind === "non-qualifying-workflow-diagnostic") workflowDiagnostics.push(item as EvidenceArtifact<ShaderNonQualifyingWorkflowDiagnostic>); else cellEvidence.push(item as EvidenceArtifact<ShaderCellEvidence>); }
  const runnerPreflights: EvidenceArtifact<ShaderRunnerCellPreflightEvidence>[] = [];
  for (const path of await listJsonFiles(preflightDirectory)) { if (basename(path) === "qualification-preflight.json") continue; const item = await artifact<ShaderRunnerCellPreflightEvidence>(path); if (item.value.kind !== "shader-runner-cell-preflight-evidence") throw new TypeError(`Unexpected preflight artifact ${path}.`); runnerPreflights.push(item); }
  const packageMetadata = await readTrustedHarnessPackageMetadata();
  const evidence = await aggregateShaderValidationEvidence({
    bundle: bundle.manifest,
    matrix: matrix.value,
    matrixBytes: matrix.bytes,
    preflight,
    cellEvidence,
    runnerPreflights,
    workflowDiagnostics,
    harness: { id: packageMetadata.name, version: packageMetadata.version, sha256: preflight.value.harnessSha256 },
    packageVersion: packageMetadata.version,
  });
  await writeJson(required(args, "--output"), evidence);
}

export async function runCli(argv: readonly string[] = process.argv): Promise<void> {
  const command = argv[2]; const args = argumentsMap(argv.slice(3));
  if (command === "validate-inventory") {
    exactArgs(args, ["--inventory"]); const loaded = await jsonFile<unknown>(required(args, "--inventory")); const result = validateCompileUnitInventory(loaded.value); if (!result.ok) throw new TypeError(result.diagnostics.map((item) => item.message).join("; ")); return;
  }
  if (command === "validate-matrix") { exactArgs(args, ["--matrix"]); await matrixFile(required(args, "--matrix")); return; }
  if (command === "create-preflight-evidence") { await createPreflight(args); return; }
  if (command === "create-hosted-runner-preflight") {
    exactArgs(args, ["--matrix", "--cell", "--preflight", "--output"]);
    const matrix = await matrixFile(required(args, "--matrix")); const cellId = required(args, "--cell");
    const cell = matrix.value.cells.find((candidate) => candidate.cellId === cellId); if (!cell) throw new TypeError(`Unknown matrix cell ${cellId}.`);
    const preflight = await jsonFile<ShaderQualificationPreflightManifest>(required(args, "--preflight"));
    await writeJson(required(args, "--output"), await createHostedSwiftShaderRunnerPreflight({ matrix: matrix.value, matrixBytes: matrix.bytes, cell, preflight: preflight.value }));
    return;
  }
  if (command === "create-workflow-diagnostic") {
    exactArgs(args, ["--matrix", "--cell", "--preflight", "--status", "--message", "--output"]);
    const matrix = await matrixFile(required(args, "--matrix")); const cellId = required(args, "--cell");
    const cell = matrix.value.cells.find((candidate) => candidate.cellId === cellId); if (!cell) throw new TypeError(`Unknown matrix cell ${cellId}.`);
    const status = required(args, "--status"); if (status !== "timeout" && status !== "failed") throw new TypeError("--status must be timeout or failed.");
    const preflight = await jsonFile<ShaderQualificationPreflightManifest>(required(args, "--preflight"));
    await writeJson(required(args, "--output"), await createTrustedWorkflowDiagnostic({ matrix: matrix.value, matrixBytes: matrix.bytes, cell, preflight: preflight.value, status, message: required(args, "--message") }));
    return;
  }
  if (command === "aggregate-evidence") { await aggregate(args); return; }
  if (command === "validate-evidence") {
    exactArgs(args, ["--bundle", "--matrix", "--evidence"]); const bundle = await admitQualificationBundle(required(args, "--bundle")); const matrix = await matrixFile(required(args, "--matrix")); const loaded = await jsonFile<ShaderValidationEvidence>(required(args, "--evidence")); const result = await validateShaderValidationEvidence({ evidence: loaded.value, bundle: bundle.manifest, matrix: matrix.value, matrixBytes: matrix.bytes }); if (!result.ok) throw new TypeError(result.diagnostics.map((item) => item.message).join("; ")); return;
  }
  if (command === "run-cell") {
    exactArgs(args, ["--bundle", "--matrix", "--cell", "--preflight", "--runner-preflight", "--output"]);
    const admitted = await admitQualificationBundle(required(args, "--bundle")); const matrix = await matrixFile(required(args, "--matrix")); const cellId = required(args, "--cell");
    const cell = matrix.value.cells.find((candidate) => candidate.cellId === cellId); if (!cell) throw new TypeError(`Unknown matrix cell ${cellId}.`);
    const preflight = await jsonFile<ShaderQualificationPreflightManifest>(required(args, "--preflight"));
    const runnerPreflight = await jsonFile<ShaderRunnerCellPreflightEvidence>(required(args, "--runner-preflight"));
    const adapterFactory = cell.adapter.kind === "software" ? defaultTrustedQualificationAdapterFactory : await resolveTrustedFleetAdapterFactory({
      cell,
      preflight: preflight.value,
    });
    const result = await runTrustedQualificationCell({ admitted, matrix: matrix.value, matrixBytes: matrix.bytes, cell, preflight: preflight.value, runnerPreflight: runnerPreflight.value, adapterFactory });
    await writeJson(required(args, "--output"), result);
    return;
  }
  throw new TypeError("Usage: plasius-gpu-shader <validate-inventory|validate-matrix|create-preflight-evidence|create-hosted-runner-preflight|create-workflow-diagnostic|run-cell|aggregate-evidence|validate-evidence> ...");
}

const modulePath = __PLASIUS_MODULE_URL__.startsWith("file:")
  ? fileURLToPath(__PLASIUS_MODULE_URL__)
  : __PLASIUS_MODULE_URL__;
if (process.argv[1] && resolve(process.argv[1]) === resolve(modulePath)) {
  runCli().catch((cause) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
