import { canonicalizeGpuContract } from "./canonical-json.js";
import type {
  GpuInterfaceManifest,
  SerializableGpuPipelineDescriptor,
  Sha256Hex,
  ShaderRequirements,
  ShaderVersionManifest,
} from "./contracts.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function asSha256Hex(value: string): Sha256Hex {
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError("SHA-256 values must be lowercase 64-character hexadecimal strings.");
  }
  return value as Sha256Hex;
}

/** Computes a SHA-256 digest using the browser-safe Web Crypto API. */
export async function computeSha256(value: Uint8Array | string): Promise<Sha256Hex> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto SHA-256 support is required.");
  }
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await subtle.digest("SHA-256", bytes as BufferSource);
  return asSha256Hex(
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}

function sorted<T>(items: readonly T[], compare: (left: T, right: T) => number): T[] {
  return [...items].sort(compare);
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function interfaceProjection(manifest: GpuInterfaceManifest): unknown {
  return {
    contractVersion: manifest.contractVersion,
    records: sorted(manifest.records, (left, right) => compareString(left.name, right.name)),
    bindings: sorted(manifest.bindings, (left, right) =>
      compareString(left.moduleId, right.moduleId) || left.group - right.group || left.binding - right.binding),
    entryPoints: sorted(manifest.entryPoints, (left, right) =>
      compareString(left.moduleId, right.moduleId)
      || compareString(left.stage, right.stage)
      || compareString(left.name, right.name)),
    vertexInputs: sorted(manifest.vertexInputs, (left, right) =>
      compareString(left.pipelineId, right.pipelineId) || left.shaderLocation - right.shaderLocation),
    overrides: sorted(manifest.overrides, (left, right) =>
      compareString(left.moduleId, right.moduleId) || compareString(left.name, right.name)),
  };
}

function modelProjection(manifest: GpuInterfaceManifest): unknown {
  const recordsByName = new Map(manifest.records.map((record) => [record.name, record]));
  const names = new Set<string>();
  const includeRecord = (name: string): void => {
    if (names.has(name)) return;
    const record = recordsByName.get(name);
    if (!record) throw new TypeError(`Model ABI references missing record ${name}.`);
    names.add(name);
    const visitType = (type: typeof record.members[number]["type"]): void => {
      if (type.kind === "record") includeRecord(type.recordName);
      if (type.kind === "array") visitType(type.element);
    };
    for (const member of record.members) visitType(member.type);
  };
  for (const name of manifest.modelAbi.recordNames) includeRecord(name);
  for (const binding of manifest.modelAbi.bindings) {
    if (binding.resource.kind === "buffer" && binding.resource.recordName) includeRecord(binding.resource.recordName);
  }
  for (const semantic of manifest.modelAbi.semantics) {
    if (semantic.source.kind === "record-member") includeRecord(semantic.source.recordName);
  }
  const semanticProjection = manifest.modelAbi.semantics.map((projection) => ({
    semantic: projection.semantic,
    source: projection.source.kind === "record-member"
      ? {
          kind: projection.source.kind,
          recordName: projection.source.recordName,
          memberPath: projection.source.memberPath,
        }
      : { kind: projection.source.kind },
  }));
  return {
    contractVersion: manifest.contractVersion,
    records: sorted(
      manifest.records.filter((record) => names.has(record.name)),
      (left, right) => compareString(left.name, right.name),
    ).map(({ addressSpaces: _shaderUsage, ...record }) => record),
    bindings: sorted(manifest.modelAbi.bindings, (left, right) =>
      compareString(left.semantic ?? "", right.semantic ?? "")
      || compareString(canonicalizeGpuContract(left.resource), canonicalizeGpuContract(right.resource)))
      .map(({ source: _selector, ...binding }) => binding),
    vertexInputs: sorted(manifest.modelAbi.vertexInputs, (left, right) =>
      compareString(left.semantic ?? "", right.semantic ?? "")
      || left.offset - right.offset)
      .map(({ source: _selector, ...vertex }) => vertex),
    semantics: sorted(semanticProjection, (left, right) =>
      compareString(left.semantic, right.semantic),
    ),
  };
}

export type ComputeGpuAbiHashInput =
  | { readonly kind: "model"; readonly interface: GpuInterfaceManifest }
  | { readonly kind: "interface"; readonly interface: GpuInterfaceManifest }
  | {
      readonly kind: "shader";
      readonly interface: GpuInterfaceManifest;
      readonly pipelines: readonly SerializableGpuPipelineDescriptor[];
      readonly requirements: ShaderRequirements;
    };

/** Computes a domain-separated ABI digest over normalized structural data. */
export async function computeGpuAbiHash(input: ComputeGpuAbiHashInput): Promise<Sha256Hex> {
  if (input.kind === "model") {
    return computeSha256(
      `plasius.gpu.model-abi/v1\n${canonicalizeGpuContract(modelProjection(input.interface))}`,
    );
  }
  if (input.kind === "interface") {
    return computeSha256(
      `plasius.gpu.interface-abi/v1\n${canonicalizeGpuContract(interfaceProjection(input.interface))}`,
    );
  }
  const pipelines = sorted(input.pipelines, (left, right) =>
    compareString(left.pipelineId, right.pipelineId),
  );
  const requirements = {
    semantics: [...input.requirements.semantics].sort(),
    features: [...input.requirements.features].sort(),
    limits: sorted(input.requirements.limits, (left, right) => compareString(left.name, right.name)),
    formats: [...input.requirements.formats].sort(),
  };
  return computeSha256(
    `plasius.gpu.shader-abi/v1\n${canonicalizeGpuContract({
      interface: interfaceProjection(input.interface),
      pipelines,
      requirements,
    })}`,
  );
}

/** Breaks the manifest/evidence digest cycle by omitting only the evidence reference. */
export async function computeShaderManifestCoreSha256(
  manifest: Omit<ShaderVersionManifest, "validationEvidence" | "additionalValidationEvidence"> | ShaderVersionManifest,
): Promise<Sha256Hex> {
  const core = Object.fromEntries(Object.entries(manifest).filter(
    ([key]) => key !== "validationEvidence" && key !== "additionalValidationEvidence",
  ));
  return computeSha256(
    `plasius.gpu.shader-manifest-core/v1\n${canonicalizeGpuContract(core)}`,
  );
}
