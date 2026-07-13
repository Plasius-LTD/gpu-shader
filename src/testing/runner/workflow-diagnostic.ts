import { canonicalizeGpuContract } from "../../canonical-json.js";
import {
  SHADER_VALIDATION_EVIDENCE_VERSION,
  type ShaderNonQualifyingWorkflowDiagnostic,
  type ShaderQualificationPreflightManifest,
  type StableWebGpuMatrixCell,
  type StableWebGpuMatrixManifest,
} from "../../contracts.js";
import { computeSha256 } from "../../hash.js";
import { createQualificationExecutionProducer, type TrustedQualificationEnvironment } from "./producer.js";
import { assertTrustedPreflightEnvironment } from "./identity.js";

/** Creates fail-closed watchdog output from fixed workflow facts, never candidate claims. */
export async function createTrustedWorkflowDiagnostic(input: {
  readonly matrix: StableWebGpuMatrixManifest;
  readonly matrixBytes: Uint8Array;
  readonly cell: StableWebGpuMatrixCell;
  readonly preflight: ShaderQualificationPreflightManifest;
  readonly status: "timeout" | "failed";
  readonly message: string;
  readonly environment?: TrustedQualificationEnvironment;
}): Promise<ShaderNonQualifyingWorkflowDiagnostic> {
  const environment = input.environment ?? process.env;
  const matrixSha256 = await computeSha256(input.matrixBytes);
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.matrixBytes)); }
  catch (cause) { throw new TypeError("Stable WebGPU matrix bytes are not UTF-8 JSON.", { cause }); }
  if (canonicalizeGpuContract(parsed) !== canonicalizeGpuContract(input.matrix)
    || matrixSha256 !== input.preflight.matrixSha256) {
    throw new TypeError("Workflow diagnostic matrix differs from immutable qualification preflight evidence.");
  }
  if (!input.matrix.cells.some((cell) => cell.cellId === input.cell.cellId
    && canonicalizeGpuContract(cell) === canonicalizeGpuContract(input.cell))) {
    throw new TypeError("Workflow diagnostic cell is outside the exact matrix artifact.");
  }
  const message = input.message.trim();
  const invalidControl = [...message].some((value) => {
    const code = value.charCodeAt(0);
    return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
  });
  if (!message || message.length > 4096 || invalidControl) {
    throw new TypeError("Workflow diagnostic message must be a bounded printable string.");
  }
  assertTrustedPreflightEnvironment({ preflight: input.preflight, environment });
  return {
    contractVersion: SHADER_VALIDATION_EVIDENCE_VERSION,
    kind: "non-qualifying-workflow-diagnostic",
    qualificationId: input.preflight.qualificationId,
    cellId: input.cell.cellId,
    status: input.status,
    matrixSha256,
    message,
    qualificationPreflightProvenance: input.preflight.provenance,
    producer: createQualificationExecutionProducer({
      preflight: input.preflight,
      job: input.cell.adapter.kind === "software" ? "swiftshader" : "physical",
      environment,
    }),
  };
}
