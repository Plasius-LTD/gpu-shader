import { canonicalizeGpuContract } from "../../canonical-json.js";
import { validateModelShaderCompatibility } from "../../compatibility.js";
import type { ShaderCompileUnitManifest, Sha256Hex } from "../../contracts.js";
import { computeSha256 } from "../../hash.js";
import type { AdmittedQualificationBundle } from "../../node/bundle-admission.js";
import { validateAssembledGpuInterface } from "../../node/validate-assembled.js";

export interface TrustedReflectionProof {
  readonly moduleSources: ReadonlyMap<string, string>;
  readonly assemblySha256ByUnit: ReadonlyMap<string, Sha256Hex>;
  readonly reflectionSha256: Sha256Hex;
  readonly durationMs: number;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalizeGpuContract(left) === canonicalizeGpuContract(right);
}

/** Re-reflects exact final WGSL and proves every compile-unit descriptor projection. */
export async function createTrustedReflectionProof(
  admitted: AdmittedQualificationBundle,
): Promise<TrustedReflectionProof> {
  const started = performance.now();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const moduleSources = new Map<string, string>();
  for (const module of admitted.manifest.modules) {
    const bytes = admitted.fileBytes.get(module.path);
    if (!bytes) throw new TypeError(`Admitted final WGSL module ${module.moduleId} is missing.`);
    moduleSources.set(module.moduleId, decoder.decode(bytes));
  }
  const reflected = await validateAssembledGpuInterface({
    assembled: {
      interfaceId: admitted.gpuInterface.interfaceId,
      interfaceVersion: admitted.gpuInterface.interfaceVersion,
      modules: admitted.manifest.modules.map((module) => ({ moduleId: module.moduleId, source: moduleSources.get(module.moduleId)! })),
      pipelines: admitted.shaderManifestCore.pipelines,
      modelFacingRecordNames: admitted.gpuInterface.modelAbi.recordNames,
      modelFacingBindings: admitted.gpuInterface.modelAbi.bindings.map((binding) => ({ ...binding.source, semantic: binding.semantic })),
      semantics: admitted.gpuInterface.modelAbi.semantics,
    },
    claimedManifest: admitted.gpuInterface,
  });
  if (!reflected.ok) throw new TypeError(reflected.diagnostics.map((item) => item.message).join("; "));
  const shaderPipelines = new Map(admitted.shaderManifestCore.pipelines.map((pipeline) => [pipeline.pipelineId, pipeline]));
  const usedPipelineIds = new Set<string>();
  const assemblySha256ByUnit = new Map<string, Sha256Hex>();
  for (const unit of admitted.manifest.inventory.compileUnits) {
    if (!canonicalEqual(unit.interfaceRef, admitted.shaderManifestCore.gpuInterface)) {
      throw new TypeError(`Compile unit ${unit.compileUnitId} interface reference differs from the admitted shader core.`);
    }
    for (const pipeline of unit.pipelines) {
      const declared = shaderPipelines.get(pipeline.pipelineId);
      if (!declared || !canonicalEqual(declared, pipeline)) {
        throw new TypeError(`Compile unit ${unit.compileUnitId} pipeline ${pipeline.pipelineId} differs from the admitted shader core.`);
      }
      usedPipelineIds.add(pipeline.pipelineId);
    }
    const constants = new Map<string, boolean | number>();
    for (const pipeline of unit.pipelines) {
      const stages = pipeline.kind === "compute" ? [pipeline.compute] : [pipeline.vertex, ...(pipeline.fragment ? [pipeline.fragment] : [])];
      for (const stage of stages) for (const [name, value] of Object.entries(stage.constants)) {
        const prior = constants.get(name);
        if (prior !== undefined && prior !== value) throw new TypeError(`Compile unit ${unit.compileUnitId} override ${name} differs between stages.`);
        constants.set(name, value);
      }
    }
    if (!canonicalEqual(Object.fromEntries([...constants.entries()].sort()), unit.overrideValues)) {
      throw new TypeError(`Compile unit ${unit.compileUnitId} override set differs from its exact pipeline constants.`);
    }
    assemblySha256ByUnit.set(unit.compileUnitId, await computeSha256(canonicalizeGpuContract({
      compileUnitId: unit.compileUnitId,
      fragments: unit.fragmentIds,
      modules: unit.modules,
      admittedModuleDigests: unit.modules.map((module) => ({
        moduleId: module.moduleId,
        sha256: admitted.manifest.modules.find((candidate) => candidate.moduleId === module.moduleId)?.sha256 ?? null,
      })),
    })));
  }
  if (usedPipelineIds.size !== shaderPipelines.size || [...shaderPipelines.keys()].some((id) => !usedPipelineIds.has(id))) {
    throw new TypeError("Compile-unit inventory does not exercise every admitted shader pipeline.");
  }
  const compatibleHashes = new Set<string>();
  for (const model of admitted.modelFixtures.values()) {
    const compatibility = validateModelShaderCompatibility({
      model,
      shader: admitted.shaderManifestCore,
      gpuInterface: admitted.gpuInterface,
    });
    if (!compatibility.ok) throw new TypeError(compatibility.diagnostics.map((item) => item.message).join("; "));
    compatibleHashes.add(model.modelAbiHash);
  }
  if (!canonicalEqual([...compatibleHashes].sort(), [...admitted.manifest.subject.modelAbiHashes].sort())) {
    throw new TypeError("Admitted model compatibility fixtures differ from the qualification subject ABI set.");
  }
  const reflectionSha256 = await computeSha256(canonicalizeGpuContract({
    interfaceAbiHash: reflected.value.interfaceAbiHash,
    modelAbiHash: reflected.value.modelAbiHash,
    manifest: reflected.value,
  }));
  return {
    moduleSources,
    assemblySha256ByUnit,
    reflectionSha256,
    durationMs: Math.max(0, Math.round(performance.now() - started)),
  };
}

export function unitModuleSources(
  unit: ShaderCompileUnitManifest,
  proof: TrustedReflectionProof,
): readonly { readonly moduleId: string; readonly source: string }[] {
  return unit.modules.map((module) => {
    const source = proof.moduleSources.get(module.moduleId);
    if (!source) throw new TypeError(`Compile unit ${unit.compileUnitId} module ${module.moduleId} lacks reflected source.`);
    return { moduleId: module.moduleId, source };
  });
}
