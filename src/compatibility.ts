import type {
  GpuCapabilitySnapshot,
  GpuInterfaceManifest,
  ModelGpuCompatibilityDescriptor,
  ModelShaderCompatibility,
  ShaderDiagnostic,
  ShaderResult,
  ShaderStyleProfileManifest,
  ShaderVersionManifestCore,
} from "./contracts.js";
import { validateShaderInterfaceRequirements } from "./requirements-validation.js";

function error(
  code: ShaderDiagnostic["code"],
  message: string,
  path?: string,
): ShaderDiagnostic {
  return { code, severity: "error", message, ...(path ? { path } : {}) };
}

function interfaceMatches(
  item: { readonly interfaceId: string; readonly interfaceVersion: string; readonly manifestSha256: string; readonly interfaceAbiHash: string; readonly modelAbiHash: string },
  model: ModelGpuCompatibilityDescriptor,
): boolean {
  return item.interfaceId === model.gpuInterface.interfaceId
    && item.interfaceVersion === model.gpuInterface.interfaceVersion
    && item.manifestSha256 === model.gpuInterface.manifestSha256
    && item.interfaceAbiHash === model.gpuInterface.interfaceAbiHash
    && item.modelAbiHash === model.modelAbiHash;
}

function validateRequirements(
  shader: ShaderVersionManifestCore,
  gpuInterface: GpuInterfaceManifest,
  model: ModelGpuCompatibilityDescriptor,
  capabilities: GpuCapabilitySnapshot | undefined,
  diagnostics: ShaderDiagnostic[],
): void {
  const semantics = new Set(model.providedSemantics);
  const requiredSemantics = new Set([
    ...shader.requirements.semantics,
    ...gpuInterface.modelAbi.semantics.map((projection) => projection.semantic),
  ]);
  for (const semantic of requiredSemantics) {
    if (!semantics.has(semantic)) {
      diagnostics.push(error("missing-semantic", `Model does not provide required semantic ${semantic}.`, "requirements.semantics"));
    }
  }
  if (!capabilities) return;
  const features = new Set(capabilities.features);
  for (const feature of shader.requirements.features) {
    if (!features.has(feature)) {
      diagnostics.push(error("missing-feature", `GPU does not provide required feature ${feature}.`, "requirements.features"));
    }
  }
  const formats = new Set(capabilities.formats);
  for (const format of shader.requirements.formats) {
    if (!formats.has(format)) {
      diagnostics.push(error("unsupported-format", `GPU runtime does not expose required format ${format}.`, "requirements.formats"));
    }
  }
  for (const requirement of shader.requirements.limits) {
    const available = capabilities.limits[requirement.name];
    const satisfied = available !== undefined && (
      requirement.comparator === "at-least"
        ? available >= requirement.value
        : available <= requirement.value
    );
    if (!satisfied) {
      diagnostics.push(error(
        "limit-not-met",
        `GPU limit ${requirement.name} does not meet the ${requirement.comparator} requirement.`,
        "requirements.limits",
      ));
    }
  }
}

/** Performs pure manifest/model/device compatibility checks without creating GPU resources. */
export function validateModelShaderCompatibility(input: {
  readonly model: ModelGpuCompatibilityDescriptor;
  readonly shader: ShaderVersionManifestCore;
  /** Exact reflected interface referenced by `shader`; required to prevent sidecar understatement. */
  readonly gpuInterface: GpuInterfaceManifest;
  readonly profile?: ShaderStyleProfileManifest;
  readonly capabilities?: GpuCapabilitySnapshot;
}): ShaderResult<ModelShaderCompatibility> {
  const diagnostics: ShaderDiagnostic[] = [];
  const { model, shader, gpuInterface, profile, capabilities } = input;
  try {
    validateShaderInterfaceRequirements({ manifest: shader, gpuInterface });
  } catch (cause) {
    diagnostics.push(error(
      "invalid-contract",
      cause instanceof Error ? cause.message : "Shader requirements differ from the reflected GPU interface.",
      "requirements",
    ));
  }
  if (model.gpuInterface.modelAbiHash !== model.modelAbiHash) {
    diagnostics.push(error("model-abi-mismatch", "Model manifest and GPU interface reference disagree on modelAbiHash.", "modelAbiHash"));
  }
  if (shader.gpuInterface.modelAbiHash !== model.modelAbiHash) {
    diagnostics.push(error("model-abi-mismatch", "Shader GPU interface does not match the model ABI.", "gpuInterface.modelAbiHash"));
  }
  if (!shader.compatibleModelInterfaces.some((item) => interfaceMatches(item, model))) {
    diagnostics.push(error("incompatible-model-interface", "Shader does not declare this exact model interface as compatible."));
  }
  if (profile) {
    if (!profile.compatibleModelInterfaces.some((item) => interfaceMatches(item, model))) {
      diagnostics.push(error("incompatible-model-interface", "Style profile does not declare this exact model interface as compatible."));
    }
    const provided = new Set(model.providedSemantics);
    for (const semantic of profile.requiredSemantics) {
      if (!provided.has(semantic)) {
        diagnostics.push(error("missing-semantic", `Model does not provide profile semantic ${semantic}.`, "requiredSemantics"));
      }
    }
  }
  validateRequirements(shader, gpuInterface, model, capabilities, diagnostics);
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return {
    ok: true,
    value: {
      modelAbiHash: model.modelAbiHash,
      shaderAbiHash: shader.shaderAbiHash,
      matchedInterfaceId: model.gpuInterface.interfaceId,
    },
  };
}
