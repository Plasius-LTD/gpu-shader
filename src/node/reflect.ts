import { WgslReflect } from "wgsl_reflect/wgsl_reflect.module.js";
import { canonicalizeGpuContract } from "../canonical-json.js";
import {
  GPU_INTERFACE_MANIFEST_VERSION,
  type GpuInterfaceManifest,
  type ReflectGpuInterfaceInput,
} from "../contracts.js";
import { computeGpuAbiHash, computeSha256 } from "../hash.js";
import { parseGpuInterfaceManifest } from "../manifest-validation.js";
import {
  normalizeEntryPoints,
  normalizeOverrides,
  normalizeRecords,
} from "./normalize-reflection.js";
import { validatePipelineInterfaces } from "./pipeline-validation.js";
import { readTrustedGpuShaderPackageVersion } from "./package-metadata.js";
import { analyzeWgslSource, assertReflectedRecordLayouts } from "./wgsl-source-analysis.js";

function assertModelSelectors(manifest: GpuInterfaceManifest): void {
  const records = new Set(manifest.records.map((record) => record.name));
  const containsNonHostShareable = (type: GpuInterfaceManifest["records"][number]["members"][number]["type"]): boolean =>
    type.kind === "scalar" && type.scalar === "bool"
    || type.kind === "vector" && type.scalar === "bool"
    || type.kind === "array" && containsNonHostShareable(type.element)
    || type.kind === "record" && (manifest.records.find((record) => record.name === type.recordName)?.members.some((member) => containsNonHostShareable(member.type)) ?? true);
  for (const name of manifest.modelAbi.recordNames) {
    if (!records.has(name)) throw new TypeError(`Model-facing record ${name} was not found in final assembled WGSL.`);
    const record = manifest.records.find((candidate) => candidate.name === name)!;
    if (record.members.some((member) => containsNonHostShareable(member.type))) throw new TypeError(`Model-facing record ${name} is not host-shareable.`);
  }
  const selectorKeys = manifest.modelAbi.bindings.map((binding) => `${binding.source.moduleId}:${binding.source.group}:${binding.source.binding}`);
  if (new Set(selectorKeys).size !== selectorKeys.length) throw new TypeError("Model-facing binding selectors must be unique.");
  for (const binding of manifest.modelAbi.bindings) {
    if (binding.semantic !== null && !manifest.modelAbi.semantics.some((item) => item.semantic === binding.semantic)) {
      throw new TypeError(`Model-facing binding semantic ${binding.semantic} has no semantic projection.`);
    }
  }
  const vertexSemantics = new Map<string, number>();
  for (const vertex of manifest.modelAbi.vertexInputs) {
    vertexSemantics.set(vertex.semantic, (vertexSemantics.get(vertex.semantic) ?? 0) + 1);
  }
  for (const mapping of manifest.modelAbi.semantics) {
    if (mapping.source.kind === "record-member") {
      const source = mapping.source;
      const record = manifest.records.find((item) => item.name === source.recordName);
      if (!record) throw new TypeError(`Semantic ${mapping.semantic} references missing record ${source.recordName}.`);
      let current = record;
      for (const [index, memberName] of source.memberPath.entries()) {
        const member = current.members.find((item) => item.name === memberName);
        if (!member) throw new TypeError(`Semantic ${mapping.semantic} references missing member ${memberName}.`);
        if (index < source.memberPath.length - 1) {
          if (member.type.kind !== "record") throw new TypeError(`Semantic ${mapping.semantic} traverses a non-record member.`);
          const recordName = member.type.recordName;
          const nested = manifest.records.find((item) => item.name === recordName);
          if (!nested) throw new TypeError(`Semantic ${mapping.semantic} references missing nested record.`);
          current = nested;
        }
      }
    } else if (mapping.source.kind === "vertex-attribute") {
      const source = mapping.source;
      const input = manifest.vertexInputs.find((item) => item.pipelineId === source.pipelineId
        && item.shaderLocation === source.shaderLocation);
      const selected = manifest.modelAbi.vertexInputs.filter((item) => item.semantic === mapping.semantic);
      if (!input || input.semantic !== mapping.semantic || vertexSemantics.get(mapping.semantic) !== 1 || selected.length !== 1
        || selected[0]!.source.pipelineId !== source.pipelineId || selected[0]!.source.shaderLocation !== source.shaderLocation) {
        throw new TypeError(`Vertex semantic ${mapping.semantic} must identify exactly one model vertex byte stream.`);
      }
    } else {
      const selected = manifest.modelAbi.bindings.filter((item) => item.semantic === mapping.semantic);
      if (selected.length !== 1 || selected[0]!.source.moduleId !== mapping.source.moduleId
        || selected[0]!.source.group !== mapping.source.group || selected[0]!.source.binding !== mapping.source.binding) {
        throw new TypeError(`Binding semantic ${mapping.semantic} must identify exactly one matching model resource.`);
      }
    }
  }
}

/** Reflects final assembled WGSL; selectors can identify data but never supply layout numbers. */
export async function reflectGpuInterface(input: ReflectGpuInterfaceInput): Promise<GpuInterfaceManifest> {
  if (input.modules.length === 0) throw new TypeError("At least one final assembled WGSL module is required.");
  const packageVersion = await readTrustedGpuShaderPackageVersion();
  const moduleIds = new Set<string>();
  const moduleDigests = [];
  const records = [];
  const sourceBindings = [];
  const entryPoints = [];
  const overrides = [];
  for (const module of input.modules) {
    if (moduleIds.has(module.moduleId)) throw new TypeError(`Duplicate moduleId ${module.moduleId}.`);
    moduleIds.add(module.moduleId);
    const source = analyzeWgslSource(module.source, module.moduleId);
    const reflection = new WgslReflect(module.source);
    const reflectedRecords = normalizeRecords(reflection);
    assertReflectedRecordLayouts(source.records, reflectedRecords);
    const reflectedOverrides = normalizeOverrides(module.moduleId, reflection);
    const reflectedOverrideProjection = reflectedOverrides.map(({ moduleId, name, id, type }) => ({ moduleId, name, id, type }));
    const sourceOverrideProjection = source.overrides.map(({ moduleId, name, id, type }) => ({ moduleId, name, id, type }));
    if (canonicalizeGpuContract(reflectedOverrideProjection) !== canonicalizeGpuContract(sourceOverrideProjection)) {
      throw new TypeError(`Independent and reflected override declarations disagree in module ${module.moduleId}.`);
    }
    moduleDigests.push({ moduleId: module.moduleId, sha256: await computeSha256(module.source) });
    records.push(...source.records);
    sourceBindings.push(...source.bindings);
    entryPoints.push(...normalizeEntryPoints(
      module.moduleId,
      reflection,
      source.workgroupSizes,
      source.workgroupStorageSizes,
    ));
    overrides.push(...source.overrides);
  }
  const recordsByName = new Map<string, typeof records[number]>();
  for (const candidate of records) {
    const existing = recordsByName.get(candidate.name);
    if (!existing) {
      recordsByName.set(candidate.name, candidate);
      continue;
    }
    const structural = (record: typeof candidate) => ({ ...record, addressSpaces: [] });
    if (canonicalizeGpuContract(structural(existing)) !== canonicalizeGpuContract(structural(candidate))) {
      throw new TypeError(`Canonical record ${candidate.name} has different layouts in final modules.`);
    }
    recordsByName.set(candidate.name, {
      ...existing,
      addressSpaces: [...new Set([...existing.addressSpaces, ...candidate.addressSpaces])].sort(),
    });
  }
  const selectedEntryKeys = new Set<string>();
  for (const pipeline of input.pipelines) {
    if (pipeline.kind === "compute") selectedEntryKeys.add(`${pipeline.compute.moduleId}:compute:${pipeline.compute.entryPoint}`);
    else {
      selectedEntryKeys.add(`${pipeline.vertex.moduleId}:vertex:${pipeline.vertex.entryPoint}`);
      if (pipeline.fragment) selectedEntryKeys.add(`${pipeline.fragment.moduleId}:fragment:${pipeline.fragment.entryPoint}`);
    }
  }
  const selectedEntryPoints = entryPoints.filter((entry) => selectedEntryKeys.has(`${entry.moduleId}:${entry.stage}:${entry.name}`));
  const pipelineInterface = validatePipelineInterfaces({ sourceBindings, entryPoints: selectedEntryPoints, overrides, pipelines: input.pipelines });
  const selectedOverrideKeys = new Set(selectedEntryPoints.flatMap((entry) => entry.overrideNames.map((name) => `${entry.moduleId}:${name}`)));
  const selectedOverrides = overrides.filter((override) => selectedOverrideKeys.has(`${override.moduleId}:${override.name}`));
  const canonicalRecords = [...recordsByName.values()].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const selectedBindings = input.modelFacingBindings.map((selector) => {
    const reflected = pipelineInterface.bindings.find((candidate) => candidate.moduleId === selector.moduleId
      && candidate.group === selector.group && candidate.binding === selector.binding);
    if (!reflected) throw new TypeError(`Model-facing binding ${selector.moduleId}:${selector.group}:${selector.binding} was not reflected.`);
    if (reflected.resource.kind === "buffer" && reflected.resource.recordName === null) {
      throw new TypeError(
        `Model-facing buffer ${selector.moduleId}:${selector.group}:${selector.binding} must use a named WGSL record root.`,
      );
    }
    return {
      source: { moduleId: selector.moduleId, group: selector.group, binding: selector.binding },
      resource: JSON.parse(canonicalizeGpuContract(reflected.resource)) as typeof reflected.resource,
      semantic: selector.semantic ?? null,
    };
  });
  const modelVerticesBySemantic = new Map<string, {
    source: { pipelineId: string; shaderLocation: number };
    format: string; offset: number; arrayStride: number; stepMode: "vertex" | "instance"; semantic: string;
  }>();
  for (const item of pipelineInterface.vertexInputs.filter((candidate) => candidate.semantic !== null)) {
    const projected = {
      source: { pipelineId: item.pipelineId, shaderLocation: item.shaderLocation },
      format: item.format, offset: item.offset, arrayStride: item.arrayStride,
      stepMode: item.stepMode, semantic: item.semantic!,
    };
    const existing = modelVerticesBySemantic.get(projected.semantic);
    if (existing && canonicalizeGpuContract({ ...existing, source: null }) !== canonicalizeGpuContract({ ...projected, source: null })) {
      throw new TypeError(`Vertex semantic ${projected.semantic} has inconsistent model byte interpretations.`);
    }
    modelVerticesBySemantic.set(projected.semantic, projected);
  }
  const modelVertexInputs = [...modelVerticesBySemantic.values()].sort((left, right) => left.semantic < right.semantic ? -1 : left.semantic > right.semantic ? 1 : 0);
  const placeholder = "0".repeat(64) as GpuInterfaceManifest["modelAbiHash"];
  const draft: GpuInterfaceManifest = {
    contractVersion: GPU_INTERFACE_MANIFEST_VERSION,
    interfaceId: input.interfaceId,
    interfaceVersion: input.interfaceVersion,
    modules: moduleDigests,
    records: canonicalRecords,
    bindings: pipelineInterface.bindings,
    entryPoints: selectedEntryPoints,
    vertexInputs: pipelineInterface.vertexInputs,
    overrides: selectedOverrides,
    modelAbi: {
      recordNames: [...input.modelFacingRecordNames],
      bindings: selectedBindings,
      vertexInputs: modelVertexInputs,
      semantics: [...input.semantics],
    },
    modelAbiHash: placeholder,
    interfaceAbiHash: placeholder,
    generatedBy: {
      packageVersion,
      reflector: "wgsl_reflect",
      reflectorVersion: "1.5.0",
    },
  };
  assertModelSelectors(draft);
  const manifest: GpuInterfaceManifest = {
    ...draft,
    modelAbiHash: await computeGpuAbiHash({ kind: "model", interface: draft }),
    interfaceAbiHash: await computeGpuAbiHash({ kind: "interface", interface: draft }),
  };
  return parseGpuInterfaceManifest(manifest);
}
