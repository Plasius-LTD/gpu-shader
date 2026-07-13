export { defineShaderCompileUnit, validateCompileUnitInventory } from "./testing/inventory.js";
export { validateStableWebGpuMatrix } from "./testing/matrix.js";
export { validateQualificationBundleManifest, validateQualificationFixture } from "./testing/qualification-bundle.js";
export {
  aggregateShaderValidationEvidence,
  computeQualificationInventorySha256,
  computeQualificationSubjectBinding,
  createQualificationPreflight,
  parseShaderValidationEvidenceAttestationRef,
  parseTrustedWorkflowProvenance,
  validateShaderValidationEvidence,
  verifyShaderValidationEvidenceAttestation,
} from "./testing/evidence.js";
export type { AggregateShaderValidationEvidenceInput, EvidenceArtifact } from "./testing/evidence.js";
