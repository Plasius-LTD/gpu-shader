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
import { snapshotGpuContract } from "./canonical-json.js";
import {
  parseGpuInterfaceManifest,
  parseModelGpuCompatibilityDescriptor,
  parseShaderStyleProfileManifest,
  parseShaderVersionManifest,
  parseShaderVersionManifestCore,
} from "./manifest-validation.js";
import { validateShaderInterfaceRequirements } from "./requirements-validation.js";

function error(
  code: ShaderDiagnostic["code"],
  message: string,
  path?: string,
): ShaderDiagnostic {
  const bounded = [...message]
    .map((character) => {
      const codePoint = character.codePointAt(0) as number;
      return codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
    })
    .slice(0, 512)
    .join("");
  return { code, severity: "error", message: bounded, ...(path ? { path } : {}) };
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

function hasValidationEvidence(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (Object.hasOwn(value, "validationEvidence") || Object.hasOwn(value, "additionalValidationEvidence"));
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
  let model: ModelGpuCompatibilityDescriptor;
  let shader: ShaderVersionManifestCore;
  let gpuInterface: GpuInterfaceManifest;
  let profile: ShaderStyleProfileManifest | undefined;
  let capabilities: GpuCapabilitySnapshot | undefined;
  try {
    const snapshot = snapshotGpuContract(input);
    if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
      throw new TypeError("GPU compatibility input must be a bounded contract object.");
    }
    const envelope = snapshot as Readonly<Record<string, unknown>>;
    const keys = Object.keys(envelope);
    const allowed = new Set(["model", "shader", "gpuInterface", "profile", "capabilities"]);
    if (keys.some((key) => !allowed.has(key))
      || !["model", "shader", "gpuInterface"].every((key) => Object.hasOwn(envelope, key))) {
      throw new TypeError("GPU compatibility input has unknown or missing fields.");
    }
    const modelSnapshot = envelope.model;
    const shaderSnapshot = envelope.shader;
    const gpuInterfaceSnapshot = envelope.gpuInterface;
    const profileSnapshot = Object.hasOwn(envelope, "profile") ? envelope.profile : undefined;

    model = parseModelGpuCompatibilityDescriptor(modelSnapshot);
    shader = hasValidationEvidence(shaderSnapshot)
      ? parseShaderVersionManifest(shaderSnapshot)
      : parseShaderVersionManifestCore(shaderSnapshot);
    gpuInterface = parseGpuInterfaceManifest(gpuInterfaceSnapshot);
    profile = profileSnapshot === undefined
      ? undefined
      : parseShaderStyleProfileManifest(profileSnapshot);
    capabilities = Object.hasOwn(envelope, "capabilities")
      ? envelope.capabilities as GpuCapabilitySnapshot
      : undefined;
  } catch (cause) {
    return {
      ok: false,
      diagnostics: [error(
        "invalid-contract",
        cause instanceof Error ? cause.message : "GPU compatibility contract snapshot failed.",
      )],
    };
  }
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
  try {
    validateRequirements(shader, gpuInterface, model, capabilities, diagnostics);
  } catch (cause) {
    diagnostics.push(error(
      "invalid-contract",
      cause instanceof Error ? cause.message : "GPU capability snapshot validation failed.",
      "capabilities",
    ));
  }
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
