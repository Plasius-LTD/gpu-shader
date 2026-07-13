import { canonicalizeGpuContract } from "./canonical-json.js";
import type {
  GpuBindingResourceLayout,
  GpuEntryPointInterface,
  GpuInterfaceManifest,
  GpuShaderStage,
  GpuTypeLayout,
  SerializableGpuPipelineDescriptor,
  ShaderRequirements,
  ShaderVersionManifestCore,
} from "./contracts.js";

const ENABLED_FEATURES: Readonly<Record<string, string>> = Object.freeze({
  f16: "shader-f16",
  clip_distances: "clip-distances",
  dual_source_blending: "dual-source-blending",
  subgroups: "subgroups",
  primitive_index: "primitive-index",
  subgroup_size_control: "subgroup-size-control",
});

const STAGES: readonly GpuShaderStage[] = ["vertex", "fragment", "compute"];
const INTER_STAGE_FRAGMENT_BUILTINS = new Set([
  "front_facing",
  "sample_index",
  "sample_mask",
  "primitive_index",
  "subgroup_invocation_id",
  "subgroup_size",
]);

function commentFree(source: string): string {
  let result = ""; let index = 0; let blockDepth = 0; let line = false;
  while (index < source.length) {
    const pair = source.slice(index, index + 2);
    if (line) { if (source[index] === "\n") { line = false; result += "\n"; } else result += " "; index += 1; continue; }
    if (blockDepth > 0) { if (pair === "/*") { blockDepth += 1; result += "  "; index += 2; continue; } if (pair === "*/") { blockDepth -= 1; result += "  "; index += 2; continue; } result += source[index] === "\n" ? "\n" : " "; index += 1; continue; }
    if (pair === "//") { line = true; result += "  "; index += 2; continue; }
    if (pair === "/*") { blockDepth = 1; result += "  "; index += 2; continue; }
    result += source[index]; index += 1;
  }
  if (blockDepth !== 0) throw new TypeError("WGSL contains an unterminated block comment.");
  return result;
}

/** Infers WebGPU device features from exact comment-free WGSL enable directives. */
export function inferWgslRequiredFeatures(sources: readonly string[]): readonly string[] {
  const result = new Set<string>();
  for (const source of sources) {
    const stripped = commentFree(source); const consumed = stripped.replace(/\benable\s+([^;]+);/gu, (_match, list: string) => {
      const names = list.split(",").map((item) => item.trim());
      if (names.length === 0 || names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))) throw new TypeError("WGSL contains a malformed enable directive.");
      for (const name of names) { const feature = ENABLED_FEATURES[name]; if (!feature) throw new TypeError(`WGSL enable ${name} has no stable WebGPU feature mapping.`); result.add(feature); }
      return " ".repeat(_match.length);
    });
    if (/\benable\b/u.test(consumed)) throw new TypeError("WGSL contains an unterminated or malformed enable directive.");
  }
  return [...result].sort();
}

function declaredLimits(requirements: ShaderRequirements): ReadonlyMap<string, { readonly comparator: "at-least" | "at-most"; readonly value: number }> {
  return new Map(requirements.limits.map((limit) => [limit.name, limit]));
}

function requireAtLeast(
  limits: ReadonlyMap<string, { readonly comparator: "at-least" | "at-most"; readonly value: number }>,
  name: string,
  value: number,
): void {
  if (value === 0) return;
  const requirement = limits.get(name);
  if (!requirement || requirement.comparator !== "at-least" || requirement.value < value) {
    throw new TypeError(`Shader requirements must declare ${name} at least ${value}.`);
  }
}

interface StageResourceCounts {
  sampledTextures: number;
  samplers: number;
  storageBuffers: number;
  storageTextures: number;
  uniformBuffers: number;
}

function emptyResourceCounts(): StageResourceCounts {
  return { sampledTextures: 0, samplers: 0, storageBuffers: 0, storageTextures: 0, uniformBuffers: 0 };
}

function countResource(resource: GpuBindingResourceLayout, counts: StageResourceCounts): void {
  switch (resource.kind) {
    case "buffer":
      if (resource.addressSpace === "uniform") counts.uniformBuffers += 1;
      else counts.storageBuffers += 1;
      return;
    case "sampler": counts.samplers += 1; return;
    case "texture": counts.sampledTextures += 1; return;
    case "storage-texture": counts.storageTextures += 1; return;
    case "external-texture":
      // WebGPU expands one external texture into four sampled-texture slots,
      // one sampler slot, and one uniform-buffer slot.
      counts.sampledTextures += 4;
      counts.samplers += 1;
      counts.uniformBuffers += 1;
  }
}

/**
 * Rejects requirements that understate facts encoded directly in serializable
 * WebGPU pipeline descriptors. This is usable before reflected WGSL is loaded.
 */
export function validatePipelineDerivedRequirements(input: {
  readonly requirements: ShaderRequirements;
  readonly pipelines: readonly SerializableGpuPipelineDescriptor[];
}): void {
  const limits = declaredLimits(input.requirements);
  const features = new Set(input.requirements.features);
  const formats = new Set(input.requirements.formats);
  const requiredFormats = new Set<string>();
  const requiredLimits = new Map<string, number>();
  const recordLimit = (name: string, value: number): void => {
    requiredLimits.set(name, Math.max(requiredLimits.get(name) ?? 0, value));
  };

  for (const pipeline of input.pipelines) {
    recordLimit("maxBindGroups", pipeline.layout.bindGroups.length);
    recordLimit("maxBindingsPerBindGroup", Math.max(0, ...pipeline.layout.bindGroups.map((group) => group.entries.length)));

    const counts = new Map<GpuShaderStage, StageResourceCounts>(STAGES.map((stage) => [stage, emptyResourceCounts()]));
    for (const group of pipeline.layout.bindGroups) {
      for (const entry of group.entries) {
        for (const stage of entry.visibility) countResource(entry.resource, counts.get(stage)!);
        if (entry.resource.kind === "storage-texture") requiredFormats.add(entry.resource.format);
        if (entry.resource.kind === "buffer") {
          recordLimit(
            entry.resource.addressSpace === "uniform" ? "maxUniformBufferBindingSize" : "maxStorageBufferBindingSize",
            entry.resource.minimumBindingSize,
          );
        }
      }
    }
    for (const stageCounts of counts.values()) {
      recordLimit("maxSampledTexturesPerShaderStage", stageCounts.sampledTextures);
      recordLimit("maxSamplersPerShaderStage", stageCounts.samplers);
      recordLimit("maxStorageBuffersPerShaderStage", stageCounts.storageBuffers);
      recordLimit("maxStorageTexturesPerShaderStage", stageCounts.storageTextures);
      recordLimit("maxUniformBuffersPerShaderStage", stageCounts.uniformBuffers);
    }

    if (pipeline.kind === "render") {
      if (pipeline.primitive.unclippedDepth && !features.has("depth-clip-control")) {
        throw new TypeError("Shader requirements omit pipeline-derived feature depth-clip-control.");
      }
      recordLimit("maxBindGroupsPlusVertexBuffers", pipeline.layout.bindGroups.length + pipeline.vertexBuffers.length);
      recordLimit("maxVertexBuffers", pipeline.vertexBuffers.length);
      recordLimit("maxVertexAttributes", pipeline.vertexBuffers.reduce((sum, buffer) => sum + buffer.attributes.length, 0));
      recordLimit("maxVertexBufferArrayStride", Math.max(0, ...pipeline.vertexBuffers.map((buffer) => buffer.arrayStride)));
      recordLimit("maxColorAttachments", pipeline.colorTargets.length);
      pipeline.colorTargets.forEach((target) => requiredFormats.add(target.format));
      if (pipeline.depthStencil) requiredFormats.add(pipeline.depthStencil.format);
    }
  }

  for (const format of requiredFormats) {
    if (!formats.has(format)) throw new TypeError(`Shader requirements list omits structurally required format ${format}.`);
  }
  for (const [name, value] of requiredLimits) requireAtLeast(limits, name, value);
}

function constantValue(interfaceManifest: GpuInterfaceManifest, moduleId: string, name: string, constants: Readonly<Record<string, boolean | number>>): number {
  const override = interfaceManifest.overrides.find((candidate) => candidate.moduleId === moduleId && candidate.name === name);
  if (!override) throw new TypeError(`Compute workgroup dimension references missing override ${moduleId}:${name}.`);
  const supplied = constants[name] ?? (override.id === null ? undefined : constants[String(override.id)]);
  const value = supplied ?? override.defaultValue;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new TypeError(`Compute workgroup override ${moduleId}:${name} must resolve to a positive integer.`);
  return value;
}

function pipelineStages(pipeline: SerializableGpuPipelineDescriptor): readonly {
  readonly moduleId: string;
  readonly entryPoint: string;
  readonly stage: GpuShaderStage;
}[] {
  return pipeline.kind === "compute"
    ? [{ moduleId: pipeline.compute.moduleId, entryPoint: pipeline.compute.entryPoint, stage: "compute" }]
    : [
        { moduleId: pipeline.vertex.moduleId, entryPoint: pipeline.vertex.entryPoint, stage: "vertex" },
        ...(pipeline.fragment ? [{ moduleId: pipeline.fragment.moduleId, entryPoint: pipeline.fragment.entryPoint, stage: "fragment" as const }] : []),
      ];
}

function reflectedEntry(
  gpuInterface: GpuInterfaceManifest,
  stage: { readonly moduleId: string; readonly entryPoint: string; readonly stage: GpuShaderStage },
  pipelineId: string,
): GpuEntryPointInterface {
  const entry = gpuInterface.entryPoints.find((candidate) => candidate.moduleId === stage.moduleId
    && candidate.name === stage.entryPoint && candidate.stage === stage.stage);
  if (!entry) throw new TypeError(`Pipeline ${pipelineId} lacks reflected ${stage.stage} entry point ${stage.moduleId}:${stage.entryPoint}.`);
  return entry;
}

function orderedStages(stages: Iterable<GpuShaderStage>): readonly GpuShaderStage[] {
  return [...new Set(stages)].sort((left, right) => STAGES.indexOf(left) - STAGES.indexOf(right));
}

function clipDistanceSlots(entry: GpuEntryPointInterface): number {
  const clipDistances = entry.outputs.find((output) => output.locationKind === "builtin" && output.location === "clip_distances");
  if (!clipDistances) return 0;
  if (clipDistances.type.kind !== "array" || clipDistances.type.count === null) {
    throw new TypeError("Reflected clip_distances output must be a fixed-size array.");
  }
  return Math.ceil(clipDistances.type.count / 4);
}

function highestLocationPlusOne(entry: GpuEntryPointInterface, direction: "inputs" | "outputs"): number {
  return Math.max(0, ...entry[direction]
    .filter((item) => item.locationKind === "location")
    .map((item) => Number(item.location) + 1));
}

function requiredInterStageVariables(
  pipeline: Extract<SerializableGpuPipelineDescriptor, { readonly kind: "render" }>,
  vertex: GpuEntryPointInterface,
  fragment: GpuEntryPointInterface | undefined,
): number {
  const vertexOutputs = vertex.outputs.filter((output) => output.locationKind === "location").length;
  const reservedVertexSlots = (pipeline.primitive.topology === "point-list" ? 1 : 0) + clipDistanceSlots(vertex);
  let required = Math.max(
    vertexOutputs + reservedVertexSlots,
    highestLocationPlusOne(vertex, "outputs") + reservedVertexSlots,
  );
  if (fragment) {
    const fragmentInputs = fragment.inputs.filter((input) => input.locationKind === "location").length;
    const fragmentBuiltins = fragment.inputs.filter((input) =>
      input.locationKind === "builtin" && INTER_STAGE_FRAGMENT_BUILTINS.has(String(input.location))).length;
    required = Math.max(
      required,
      fragmentInputs + fragmentBuiltins,
      highestLocationPlusOne(fragment, "inputs"),
    );
  }
  return required;
}

function interStageComponentCount(
  type: GpuTypeLayout,
  gpuInterface: GpuInterfaceManifest,
  activeRecords = new Set<string>(),
): number {
  switch (type.kind) {
    case "scalar":
    case "atomic":
      return 1;
    case "vector":
      return type.width;
    case "matrix":
      return type.columns * type.rows;
    case "array":
      if (type.count === null) throw new TypeError("Inter-stage IO cannot contain a runtime-sized array.");
      return type.count * interStageComponentCount(type.element, gpuInterface, activeRecords);
    case "record": { // Defensive support for reflectors that retain an IO structure reference.
      if (activeRecords.has(type.recordName)) throw new TypeError(`Inter-stage IO record ${type.recordName} is recursive.`);
      const record = gpuInterface.records.find((candidate) => candidate.name === type.recordName);
      if (!record) throw new TypeError(`Inter-stage IO references missing record ${type.recordName}.`);
      const nested = new Set(activeRecords);
      nested.add(type.recordName);
      return record.members.reduce(
        (sum, member) => sum + interStageComponentCount(member.type, gpuInterface, nested),
        0,
      );
    }
  }
}

function requiredInterStageComponents(
  vertex: GpuEntryPointInterface,
  fragment: GpuEntryPointInterface | undefined,
  gpuInterface: GpuInterfaceManifest,
): number {
  const countLocations = (items: GpuEntryPointInterface["inputs"]): number => items
    .filter((item) => item.locationKind === "location")
    .reduce((sum, item) => sum + interStageComponentCount(item.type, gpuInterface), 0);
  return Math.max(
    countLocations(vertex.outputs),
    fragment ? countLocations(fragment.inputs) : 0,
  );
}

/**
 * Rejects interface/pipeline requirements that understate exact reflected ABI
 * semantics, entry-point resource usage, inter-stage IO, or compute workgroups.
 */
export function validateShaderInterfaceRequirements(input: {
  readonly manifest: ShaderVersionManifestCore;
  readonly gpuInterface: GpuInterfaceManifest;
}): void {
  const { manifest, gpuInterface } = input;
  if (manifest.gpuInterface.interfaceId !== gpuInterface.interfaceId
    || manifest.gpuInterface.interfaceVersion !== gpuInterface.interfaceVersion
    || manifest.gpuInterface.interfaceAbiHash !== gpuInterface.interfaceAbiHash
    || manifest.gpuInterface.modelAbiHash !== gpuInterface.modelAbiHash) {
    throw new TypeError("Shader GPU interface reference differs from the reflected interface identity.");
  }
  const manifestModules = [...manifest.modules]
    .map(({ moduleId, sha256 }) => ({ moduleId, sha256 }))
    .sort((left, right) => left.moduleId < right.moduleId ? -1 : left.moduleId > right.moduleId ? 1 : 0);
  const interfaceModules = [...gpuInterface.modules]
    .map(({ moduleId, sha256 }) => ({ moduleId, sha256 }))
    .sort((left, right) => left.moduleId < right.moduleId ? -1 : left.moduleId > right.moduleId ? 1 : 0);
  if (canonicalizeGpuContract(manifestModules) !== canonicalizeGpuContract(interfaceModules)) {
    throw new TypeError("Shader modules differ from the exact reflected interface module set.");
  }

  validatePipelineDerivedRequirements({ requirements: manifest.requirements, pipelines: manifest.pipelines });
  const requiredSemantics = new Set(gpuInterface.modelAbi.semantics.map((projection) => projection.semantic));
  const declaredSemantics = new Set(manifest.requirements.semantics);
  for (const semantic of requiredSemantics) {
    if (!declaredSemantics.has(semantic)) throw new TypeError(`Shader requirements omit reflected model semantic ${semantic}.`);
  }

  const limits = declaredLimits(manifest.requirements);
  for (const pipeline of manifest.pipelines) {
    const stages = pipelineStages(pipeline);
    const entries = stages.map((stage) => ({ stage, entry: reflectedEntry(gpuInterface, stage, pipeline.pipelineId) }));
    for (const group of pipeline.layout.bindGroups) {
      for (const descriptorEntry of group.entries) {
        const used = entries.filter(({ stage, entry }) =>
          entry.bindingKeys.includes(`${stage.moduleId}:${group.group}:${descriptorEntry.binding}`));
        if (used.length === 0) throw new TypeError(`Pipeline ${pipeline.pipelineId} binding ${group.group}:${descriptorEntry.binding} is absent from its reflected entry points.`);
        if (canonicalizeGpuContract(orderedStages(descriptorEntry.visibility))
          !== canonicalizeGpuContract(orderedStages(used.map(({ stage }) => stage.stage)))) {
          throw new TypeError(`Pipeline ${pipeline.pipelineId} binding ${group.group}:${descriptorEntry.binding} visibility differs from reflected entry-point usage.`);
        }
        for (const { stage } of used) {
          const reflected = gpuInterface.bindings.find((binding) => binding.moduleId === stage.moduleId
            && binding.group === group.group && binding.binding === descriptorEntry.binding);
          if (!reflected || canonicalizeGpuContract(reflected.resource) !== canonicalizeGpuContract(descriptorEntry.resource)) {
            throw new TypeError(`Pipeline ${pipeline.pipelineId} binding ${stage.moduleId}:${group.group}:${descriptorEntry.binding} differs from the reflected interface.`);
          }
        }
      }
    }
    for (const { stage, entry } of entries) {
      for (const key of entry.bindingKeys) {
        const declared = pipeline.layout.bindGroups.some((group) => group.entries.some((descriptorEntry) =>
          key === `${stage.moduleId}:${group.group}:${descriptorEntry.binding}`));
        if (!declared) throw new TypeError(`Pipeline ${pipeline.pipelineId} omits reflected binding ${key}.`);
      }
    }

    if (pipeline.kind === "compute") {
      const entry = entries[0]?.entry;
      if (!entry?.workgroupSize) throw new TypeError(`Compute pipeline ${pipeline.pipelineId} lacks an exact reflected workgroup size.`);
      if (entry.workgroupStorageSize === null) throw new TypeError(`Compute pipeline ${pipeline.pipelineId} lacks an exact reflected workgroup storage size.`);
      const values = entry.workgroupSize.map((dimension) => dimension.kind === "literal" ? dimension.value : constantValue(gpuInterface, entry.moduleId, dimension.name, pipeline.compute.constants)) as [number, number, number];
      const invocations = values[0] * values[1] * values[2];
      if (!Number.isSafeInteger(invocations)) throw new TypeError(`Compute pipeline ${pipeline.pipelineId} workgroup invocation count is outside the safe manifest range.`);
      requireAtLeast(limits, "maxComputeWorkgroupSizeX", values[0]);
      requireAtLeast(limits, "maxComputeWorkgroupSizeY", values[1]);
      requireAtLeast(limits, "maxComputeWorkgroupSizeZ", values[2]);
      requireAtLeast(limits, "maxComputeInvocationsPerWorkgroup", invocations);
      requireAtLeast(limits, "maxComputeWorkgroupStorageSize", entry.workgroupStorageSize);
    } else {
      const vertex = entries.find(({ stage }) => stage.stage === "vertex")?.entry;
      const fragment = entries.find(({ stage }) => stage.stage === "fragment")?.entry;
      if (!vertex) throw new TypeError(`Render pipeline ${pipeline.pipelineId} lacks an exact reflected vertex entry point.`);
      requireAtLeast(limits, "maxInterStageShaderVariables", requiredInterStageVariables(pipeline, vertex, fragment));
      requireAtLeast(limits, "maxInterStageShaderComponents", requiredInterStageComponents(vertex, fragment, gpuInterface));
    }
  }
}

/** Rejects caller-declared requirements that understate facts derived from exact modules/interfaces. */
export function validateShaderDerivedRequirements(input: {
  readonly manifest: ShaderVersionManifestCore;
  readonly gpuInterface: GpuInterfaceManifest;
  readonly moduleSources: ReadonlyMap<string, string>;
}): void {
  const expectedModuleIds = [...input.manifest.modules.map((module) => module.moduleId)].sort(); const actualModuleIds = [...input.moduleSources.keys()].sort();
  if (expectedModuleIds.join("\n") !== actualModuleIds.join("\n")) throw new TypeError("Derived-requirement source modules differ from the exact shader manifest module set.");
  validateShaderInterfaceRequirements(input);
  const features = new Set(input.manifest.requirements.features);
  for (const feature of inferWgslRequiredFeatures([...input.moduleSources.values()])) if (!features.has(feature)) throw new TypeError(`Shader requirements omit WGSL-derived feature ${feature}.`);
}
