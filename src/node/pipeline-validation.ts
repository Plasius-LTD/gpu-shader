import { canonicalizeGpuContract } from "../canonical-json.js";
import type {
  GpuBindingLayout,
  GpuBindingResourceLayout,
  GpuEntryPointInterface,
  GpuOverrideLayout,
  GpuShaderStage,
  GpuTypeLayout,
  GpuVertexInputLayout,
  SerializableGpuPipelineDescriptor,
} from "../contracts.js";
import type { SourceBinding } from "./wgsl-source-analysis.js";

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedStages(stages: Iterable<GpuShaderStage>): GpuShaderStage[] {
  const order: Readonly<Record<GpuShaderStage, number>> = { vertex: 0, fragment: 1, compute: 2 };
  return [...new Set(stages)].sort((left, right) => order[left] - order[right]);
}

function sameResource(source: GpuBindingResourceLayout, declared: GpuBindingResourceLayout): boolean {
  if (source.kind !== declared.kind) return false;
  if (source.kind === "sampler" && declared.kind === "sampler") {
    return source.samplerType === "comparison" ? declared.samplerType === "comparison" : declared.samplerType !== "comparison";
  }
  if (source.kind === "texture" && declared.kind === "texture") {
    const sampleTypeMatches = source.sampleType === "float"
      ? declared.sampleType === "float" || declared.sampleType === "unfilterable-float"
      : source.sampleType === declared.sampleType;
    return sampleTypeMatches
      && source.viewDimension === declared.viewDimension
      && source.multisampled === declared.multisampled;
  }
  return canonicalizeGpuContract(source) === canonicalizeGpuContract(declared);
}

interface VertexFormatInfo {
  readonly scalar: "f16" | "f32" | "i32" | "u32";
  readonly width: 1 | 2 | 3 | 4;
  readonly byteSize: number;
  readonly alignment: number;
}

function vertexFormat(format: string): VertexFormatInfo | null {
  const direct = /^(float32|sint32|uint32)(?:x([234]))?$/u.exec(format);
  if (direct) {
    return {
      scalar: direct[1] === "float32" ? "f32" : direct[1] === "sint32" ? "i32" : "u32",
      width: Number(direct[2] ?? 1) as 1 | 2 | 3 | 4,
      byteSize: 4 * Number(direct[2] ?? 1), alignment: 4,
    };
  }
  const half = /^float16x([24])$/u.exec(format);
  if (half) {
    const width = Number(half[1]) as 2 | 4;
    const byteSize = 2 * width;
    return { scalar: "f16", width, byteSize, alignment: Math.min(4, byteSize) };
  }
  const small = /^(u|s)(?:int)(8|16)x([24])$/u.exec(format);
  if (small) {
    const bytes = Number(small[2]) / 8;
    const width = Number(small[3]) as 2 | 4;
    const byteSize = bytes * width;
    return { scalar: small[1] === "u" ? "u32" : "i32", width, byteSize, alignment: Math.min(4, byteSize) };
  }
  if (format === "unorm8x4-bgra") return { scalar: "f32", width: 4, byteSize: 4, alignment: 4 };
  const normalized = /^(?:u|s)norm(8|16)x([24])$/u.exec(format);
  if (normalized) {
    const bytes = Number(normalized[1]) / 8;
    const width = Number(normalized[2]) as 2 | 4;
    const byteSize = bytes * width;
    return { scalar: "f32", width, byteSize, alignment: Math.min(4, byteSize) };
  }
  if (format === "unorm10-10-10-2") return { scalar: "f32", width: 4, byteSize: 4, alignment: 4 };
  return null;
}

function shaderVertexType(type: GpuTypeLayout): { scalar: string; width: number } | null {
  if (type.kind === "scalar") return { scalar: type.scalar, width: 1 };
  if (type.kind === "vector") return { scalar: type.scalar, width: type.width };
  return null;
}

function validateVertexInputs(
  pipelines: readonly SerializableGpuPipelineDescriptor[],
  entryPoints: readonly GpuEntryPointInterface[],
): GpuVertexInputLayout[] {
  const result: GpuVertexInputLayout[] = [];
  for (const pipeline of pipelines) {
    if (pipeline.kind !== "render") continue;
    const entry = entryPoints.find((candidate) => candidate.moduleId === pipeline.vertex.moduleId
      && candidate.name === pipeline.vertex.entryPoint && candidate.stage === "vertex");
    if (!entry) throw new TypeError(`Vertex entry point ${pipeline.vertex.moduleId}:${pipeline.vertex.entryPoint} was not reflected.`);
    const locations = new Set<number>();
    pipeline.vertexBuffers.forEach((buffer, bufferSlot) => {
      if (!Number.isSafeInteger(buffer.arrayStride) || buffer.arrayStride < 0 || buffer.arrayStride > 2048 || buffer.arrayStride % 4 !== 0) {
        throw new TypeError(`Pipeline ${pipeline.pipelineId} buffer ${bufferSlot} has invalid arrayStride.`);
      }
      for (const attribute of buffer.attributes) {
        if (!Number.isSafeInteger(attribute.shaderLocation) || attribute.shaderLocation < 0 || attribute.shaderLocation >= 16) {
          throw new TypeError(`Pipeline ${pipeline.pipelineId} has invalid shader location ${attribute.shaderLocation}.`);
        }
        if (locations.has(attribute.shaderLocation)) throw new TypeError(`Pipeline ${pipeline.pipelineId} repeats shader location ${attribute.shaderLocation}.`);
        locations.add(attribute.shaderLocation);
        const format = vertexFormat(attribute.format);
        if (!format) throw new TypeError(`Pipeline ${pipeline.pipelineId} uses unsupported vertex format ${attribute.format}.`);
        if (!Number.isSafeInteger(attribute.offset) || attribute.offset < 0 || attribute.offset % format.alignment !== 0
          || attribute.offset + format.byteSize > buffer.arrayStride) {
          throw new TypeError(`Pipeline ${pipeline.pipelineId} has an out-of-bounds or misaligned vertex attribute.`);
        }
        const input = entry.inputs.find((candidate) => candidate.locationKind === "location" && candidate.location === attribute.shaderLocation);
        if (!input) throw new TypeError(`Pipeline ${pipeline.pipelineId} location ${attribute.shaderLocation} is absent from WGSL.`);
        const shaderType = shaderVertexType(input.type);
        const baseCompatible = shaderType && (format.scalar === "f16" || format.scalar === "f32"
          ? shaderType.scalar === "f16" || shaderType.scalar === "f32"
          : shaderType.scalar === format.scalar);
        if (!baseCompatible) {
          throw new TypeError(`Pipeline ${pipeline.pipelineId} format ${attribute.format} is incompatible with reflected shader input ${attribute.shaderLocation}.`);
        }
        result.push({
          pipelineId: pipeline.pipelineId, moduleId: pipeline.vertex.moduleId, entryPoint: pipeline.vertex.entryPoint,
          shaderLocation: attribute.shaderLocation, shaderType: input.type, bufferSlot, format: attribute.format,
          offset: attribute.offset, arrayStride: buffer.arrayStride, stepMode: buffer.stepMode, semantic: attribute.semantic,
        });
      }
    });
  }
  return result.sort((left, right) => compareString(left.pipelineId, right.pipelineId) || left.shaderLocation - right.shaderLocation);
}

interface StageUse {
  readonly moduleId: string;
  readonly entryPoint: string;
  readonly stage: GpuShaderStage;
}

/** Cross-checks assembled entry points, resources, overrides, pipeline layouts, and vertex byte interpretation. */
export function validatePipelineInterfaces(input: {
  readonly sourceBindings: readonly SourceBinding[];
  readonly entryPoints: readonly GpuEntryPointInterface[];
  readonly overrides: readonly GpuOverrideLayout[];
  readonly pipelines: readonly SerializableGpuPipelineDescriptor[];
}): { readonly bindings: readonly GpuBindingLayout[]; readonly vertexInputs: readonly GpuVertexInputLayout[] } {
  const pipelineIds = new Set<string>();
  const resourcesByKey = new Map<string, GpuBindingResourceLayout>();
  const visibilityByKey = new Map<string, Set<GpuShaderStage>>();
  const sourceByKey = new Map(input.sourceBindings.map((binding) => [`${binding.moduleId}:${binding.group}:${binding.binding}`, binding]));
  if (sourceByKey.size !== input.sourceBindings.length) throw new TypeError("Duplicate reflected module binding key.");

  for (const pipeline of input.pipelines) {
    if (!pipeline.pipelineId || pipelineIds.has(pipeline.pipelineId)) throw new TypeError(`Duplicate or empty pipelineId ${pipeline.pipelineId}.`);
    pipelineIds.add(pipeline.pipelineId);
    const groups = [...pipeline.layout.bindGroups].sort((left, right) => left.group - right.group);
    groups.forEach((group, index) => {
      if (group.group !== index) throw new TypeError(`Pipeline ${pipeline.pipelineId} bind groups must be unique and contiguous from zero.`);
      const bindings = new Set<number>();
      for (const entry of group.entries) {
        if (entry.group !== group.group) throw new TypeError(`Pipeline ${pipeline.pipelineId} binding ${entry.binding} repeats a mismatched group coordinate.`);
        if (bindings.has(entry.binding)) throw new TypeError(`Pipeline ${pipeline.pipelineId} repeats group ${group.group} binding ${entry.binding}.`);
        bindings.add(entry.binding);
      }
    });
    const stages: StageUse[] = pipeline.kind === "compute"
      ? [{ moduleId: pipeline.compute.moduleId, entryPoint: pipeline.compute.entryPoint, stage: "compute" }]
      : [
          { moduleId: pipeline.vertex.moduleId, entryPoint: pipeline.vertex.entryPoint, stage: "vertex" },
          ...(pipeline.fragment ? [{ moduleId: pipeline.fragment.moduleId, entryPoint: pipeline.fragment.entryPoint, stage: "fragment" as const }] : []),
        ];
    const stageEntries = stages.map((stage) => {
      const entry = input.entryPoints.find((candidate) => candidate.moduleId === stage.moduleId
        && candidate.name === stage.entryPoint && candidate.stage === stage.stage);
      if (!entry) throw new TypeError(`Pipeline ${pipeline.pipelineId} references missing ${stage.stage} entry point ${stage.moduleId}:${stage.entryPoint}.`);
      if (stage.stage === "compute" && entry.workgroupSize === null) throw new TypeError(`Compute entry point ${stage.entryPoint} lacks @workgroup_size.`);
      if (stage.stage === "compute" && entry.workgroupStorageSize === null) throw new TypeError(`Compute entry point ${stage.entryPoint} lacks reflected workgroup storage size.`);
      const programmable = pipeline.kind === "compute" ? pipeline.compute
        : stage.stage === "vertex" ? pipeline.vertex : pipeline.fragment!;
      const suppliedOverrides = new Set<string>();
      for (const [constant, value] of Object.entries(programmable.constants)) {
        const override = input.overrides.find((candidate) => candidate.moduleId === stage.moduleId
          && (candidate.name === constant || (candidate.id !== null && String(candidate.id) === constant)));
        if (!override || !entry.overrideNames.includes(override.name)) throw new TypeError(`Pipeline ${pipeline.pipelineId} supplies unknown or unused override ${constant}.`);
        if (suppliedOverrides.has(override.name)) throw new TypeError(`Pipeline ${pipeline.pipelineId} supplies both name/ID aliases for override ${override.name}.`);
        suppliedOverrides.add(override.name);
        const valid = override.type === "bool" ? typeof value === "boolean"
          : typeof value === "number" && Number.isFinite(value) && (
            override.type === "u32" ? Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff
              : override.type === "i32" ? Number.isInteger(value) && value >= -0x8000_0000 && value <= 0x7fff_ffff
              : override.type === "f32" ? Number.isFinite(Math.fround(value))
              : Math.abs(value) <= 65_504
          );
        if (!valid) throw new TypeError(`Pipeline ${pipeline.pipelineId} constant ${constant} is incompatible with ${override.type}.`);
      }
      for (const name of entry.overrideNames) {
        const override = input.overrides.find((candidate) => candidate.moduleId === stage.moduleId && candidate.name === name);
        if (!override) throw new TypeError(`Entry point ${stage.entryPoint} references missing override ${name}.`);
        if (override.defaultValue === null && !suppliedOverrides.has(name)) throw new TypeError(`Pipeline ${pipeline.pipelineId} must supply override ${name} without a default.`);
      }
      return { stage, entry };
    });
    for (const group of groups) {
      for (const declared of group.entries) {
        const used = stageEntries.filter(({ stage, entry }) => entry.bindingKeys.includes(`${stage.moduleId}:${group.group}:${declared.binding}`));
        if (used.length === 0) throw new TypeError(`Pipeline ${pipeline.pipelineId} descriptor binding ${group.group}:${declared.binding} is absent from its entry-point interface.`);
        const expectedVisibility = sortedStages(used.map(({ stage }) => stage.stage));
        if (canonicalizeGpuContract(sortedStages(declared.visibility)) !== canonicalizeGpuContract(expectedVisibility)) {
          throw new TypeError(`Pipeline ${pipeline.pipelineId} binding ${group.group}:${declared.binding} has incorrect stage visibility.`);
        }
        for (const { stage } of used) {
          const key = `${stage.moduleId}:${group.group}:${declared.binding}`;
          const source = sourceByKey.get(key);
          if (!source) throw new TypeError(`Entry point uses undeclared source binding ${key}.`);
          if (!sameResource(source.resource, declared.resource)) throw new TypeError(`Pipeline ${pipeline.pipelineId} binding ${key} differs from final WGSL.`);
          const previous = resourcesByKey.get(key);
          if (previous && canonicalizeGpuContract(previous) !== canonicalizeGpuContract(declared.resource)) {
            throw new TypeError(`Binding ${key} has inconsistent pipeline resource layouts.`);
          }
          resourcesByKey.set(key, declared.resource);
          const visibility = visibilityByKey.get(key) ?? new Set<GpuShaderStage>();
          visibility.add(stage.stage);
          visibilityByKey.set(key, visibility);
        }
      }
    }
    for (const { stage, entry } of stageEntries) {
      for (const key of entry.bindingKeys) {
        const [, groupText, bindingText] = key.split(":");
        const group = Number(groupText);
        const binding = Number(bindingText);
        const declared = groups.find((candidate) => candidate.group === group)?.entries.find((candidate) => candidate.binding === binding);
        if (!declared) throw new TypeError(`Pipeline ${pipeline.pipelineId} omits reflected binding ${key} used by ${stage.entryPoint}.`);
      }
    }
  }

  const bindings = input.sourceBindings.filter((source) => resourcesByKey.has(`${source.moduleId}:${source.group}:${source.binding}`)).map((source) => {
    const key = `${source.moduleId}:${source.group}:${source.binding}`;
    return {
      moduleId: source.moduleId, variableName: source.variableName, group: source.group, binding: source.binding,
      resource: resourcesByKey.get(key)!, visibility: sortedStages(visibilityByKey.get(key) ?? []),
    } satisfies GpuBindingLayout;
  }).sort((left, right) => compareString(left.moduleId, right.moduleId) || left.group - right.group || left.binding - right.binding);
  return { bindings, vertexInputs: validateVertexInputs(input.pipelines, input.entryPoints) };
}
