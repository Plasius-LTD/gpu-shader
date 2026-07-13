import { readdir, readFile, lstat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { canonicalizeGpuContract } from "../canonical-json.js";
import { createGpuRecordCodec } from "../codec/codec.js";
import { encodeGpuVertexFormat } from "../codec/vertex-format.js";
import type {
  GpuInterfaceManifest,
  ModelGpuCompatibilityDescriptor,
  ShaderQualificationBundleManifest,
  ShaderQualificationFixtureManifest,
  ShaderVersionManifestCore,
} from "../contracts.js";
import { computeGpuAbiHash, computeShaderManifestCoreSha256, computeSha256 } from "../hash.js";
import { parseGpuInterfaceManifest, parseShaderQualificationModelCompatibilityFixture, parseShaderVersionManifestCore } from "../manifest-validation.js";
import { validateShaderDerivedRequirements } from "../requirements-validation.js";
import { validateQualificationBundleManifest, validateQualificationFixture } from "../testing/qualification-bundle.js";
import { validateAssembledGpuInterface } from "./validate-assembled.js";

const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const TEXEL_BYTES = new Map<string, number>([
  ["r8unorm", 1], ["r8snorm", 1], ["r8uint", 1], ["r8sint", 1],
  ["r16unorm", 2], ["r16snorm", 2], ["r16uint", 2], ["r16sint", 2], ["r16float", 2], ["rg8unorm", 2], ["rg8snorm", 2], ["rg8uint", 2], ["rg8sint", 2],
  ["r32uint", 4], ["r32sint", 4], ["r32float", 4], ["rg16unorm", 4], ["rg16snorm", 4], ["rg16uint", 4], ["rg16sint", 4], ["rg16float", 4], ["rgba8unorm", 4], ["rgba8unorm-srgb", 4], ["rgba8snorm", 4], ["rgba8uint", 4], ["rgba8sint", 4], ["bgra8unorm", 4], ["bgra8unorm-srgb", 4], ["rgb9e5ufloat", 4], ["rgb10a2uint", 4], ["rgb10a2unorm", 4], ["rg11b10ufloat", 4],
  ["rg32uint", 8], ["rg32sint", 8], ["rg32float", 8], ["rgba16unorm", 8], ["rgba16snorm", 8], ["rgba16uint", 8], ["rgba16sint", 8], ["rgba16float", 8],
  ["rgba32uint", 16], ["rgba32sint", 16], ["rgba32float", 16],
]);

function checkedProduct(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result)) throw new TypeError(`${label} exceeds the safe integer bound.`);
  return result;
}

function checkedSum(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new TypeError(`${label} exceeds the safe integer bound.`);
  return result;
}

function textureDataBounds(
  width: number,
  height: number,
  depthOrArrayLayers: number,
  bytesPerTexel: number,
  bytesPerRow: number,
  rowsPerImage: number,
  label: string,
): { readonly minimum: number; readonly maximum: number } {
  const rowBytes = checkedProduct(width, bytesPerTexel, `${label} row byte length`);
  if (bytesPerRow < rowBytes || bytesPerRow % bytesPerTexel !== 0) throw new TypeError(`${label} bytesPerRow is incompatible with its texel row.`);
  if (rowsPerImage < height) throw new TypeError(`${label} rowsPerImage is smaller than its image height.`);
  const imageStride = checkedProduct(bytesPerRow, rowsPerImage, `${label} image stride`);
  const priorImages = checkedProduct(imageStride, depthOrArrayLayers - 1, `${label} prior-image byte length`);
  const priorRows = checkedProduct(bytesPerRow, height - 1, `${label} prior-row byte length`);
  const minimum = checkedSum(priorImages, checkedSum(priorRows, rowBytes, `${label} final-image byte length`), `${label} required byte length`);
  return { minimum, maximum: checkedProduct(imageStride, depthOrArrayLayers, `${label} padded byte capacity`) };
}

function slash(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

async function inventoryFiles(root: string): Promise<Map<string, Uint8Array>> {
  const result = new Map<string, Uint8Array>();
  const folded = new Map<string, { path: string; kind: "file" | "directory" }>();
  let total = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) throw new TypeError(`Bundle path ${entry.name} is a symbolic link.`);
      const entryPath = slash(relative(root, absolute));
      const parts = entryPath.split("/");
      parts.forEach((_, index) => {
        const prefix = parts.slice(0, index + 1).join("/");
        const kind = index === parts.length - 1 && !stats.isDirectory() ? "file" : "directory";
        const key = prefix.toLowerCase(); const existing = folded.get(key);
        if (existing && (existing.path !== prefix || existing.kind !== kind)) throw new TypeError(`Bundle has a case-fold or file/directory prefix collision at ${prefix}.`);
        folded.set(key, { path: prefix, kind });
      });
      if (stats.isDirectory()) { await walk(absolute); continue; }
      if (!stats.isFile()) throw new TypeError(`Bundle path ${entry.name} is not a regular file.`);
      if ((stats.mode & 0o111) !== 0) throw new TypeError(`Bundle file ${entry.name} is executable.`);
      const path = entryPath;
      const bytes = new Uint8Array(await readFile(absolute)); total += bytes.byteLength;
      if (total > MAX_BUNDLE_BYTES) throw new TypeError("Bundle exceeds the 256 MiB admission bound.");
      result.set(path, bytes);
    }
  };
  await walk(root);
  return result;
}

function json(bytes: Uint8Array, label: string): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (cause) { throw new TypeError(`${label} is not UTF-8 JSON.`, { cause }); }
}

function fixtureDataPaths(value: ShaderQualificationFixtureManifest): { path: string; sha256: string }[] {
  const refs: { path: string; sha256: string }[] = [];
  for (const resource of value.resources) if ("initialData" in resource && resource.initialData) refs.push(resource.initialData);
  return refs;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function assertExactCompileUnitPipelines(
  bundle: ShaderQualificationBundleManifest,
  shaderManifestCore: ShaderVersionManifestCore,
): void {
  const declared = new Map(shaderManifestCore.pipelines.map((pipeline) => [pipeline.pipelineId, pipeline]));
  const exercised = new Set<string>();
  for (const unit of bundle.inventory.compileUnits) {
    if (canonicalizeGpuContract(unit.interfaceRef) !== canonicalizeGpuContract(shaderManifestCore.gpuInterface)) {
      throw new TypeError(`Compile unit ${unit.compileUnitId} interface reference differs from the shader manifest core.`);
    }
    for (const pipeline of unit.pipelines) {
      const expected = declared.get(pipeline.pipelineId);
      if (!expected || canonicalizeGpuContract(pipeline) !== canonicalizeGpuContract(expected)) {
        throw new TypeError(`Compile unit ${unit.compileUnitId} pipeline ${pipeline.pipelineId} differs from the shader manifest core.`);
      }
      exercised.add(pipeline.pipelineId);
    }
  }
  if (exercised.size !== declared.size || [...declared.keys()].some((pipelineId) => !exercised.has(pipelineId))) {
    throw new TypeError("Compile-unit inventory does not exercise every shader manifest core pipeline.");
  }
}

export interface AdmittedQualificationBundle {
  readonly root: string;
  readonly manifest: ShaderQualificationBundleManifest;
  readonly shaderManifestCore: ShaderVersionManifestCore;
  readonly fixtures: ReadonlyMap<string, ShaderQualificationFixtureManifest>;
  readonly gpuInterface: GpuInterfaceManifest;
  readonly modelFixtures: ReadonlyMap<string, ModelGpuCompatibilityDescriptor>;
  readonly fileBytes: ReadonlyMap<string, Uint8Array>;
}

/** Recomputes the data-only closure, final-WGSL reflection, ABI hashes, fixtures, assembly, and core digest. */
export async function admitQualificationBundle(directory: string): Promise<AdmittedQualificationBundle> {
  const root = resolve(directory); const rootStats = await lstat(root); if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new TypeError("Qualification bundle must be an extracted regular directory.");
  const files = await inventoryFiles(root); const qualificationBytes = files.get("qualification.json"); if (!qualificationBytes) throw new TypeError("Bundle root must contain qualification.json.");
  const parsed = validateQualificationBundleManifest(json(qualificationBytes, "qualification.json")); if (!parsed.ok) throw new TypeError(parsed.diagnostics.map((item) => item.message).join("; "));
  const bundle = parsed.value; const declared = new Map<string, string>([["qualification.json", "qualification-envelope"]]);
  const claim = (path: string, role: string): void => { const existing = declared.get(path); if (existing && existing !== role) throw new TypeError(`Bundle path ${path} is reused as ${existing} and ${role}.`); declared.set(path, role); };
  claim(bundle.shaderManifestCorePath, "shader-manifest-core");
  claim(bundle.gpuInterfaceManifest.path, "gpu-interface-manifest");
  for (const fixture of bundle.modelCompatibilityFixtures) claim(fixture.path, `model-compatibility:${fixture.fixtureId}`);
  for (const fragment of bundle.inventory.fragments) claim(fragment.path, `fragment:${fragment.fragmentId}`);
  for (const module of bundle.modules) claim(module.path, `module:${module.moduleId}`);
  for (const fixture of bundle.fixtures) claim(fixture.path, `fixture:${fixture.fixtureId}`);
  const requireBytes = (path: string): Uint8Array => { const bytes = files.get(path); if (!bytes) throw new TypeError(`Declared bundle file ${path} is missing.`); return bytes; };
  for (const fragment of bundle.inventory.fragments) if (await computeSha256(requireBytes(fragment.path)) !== fragment.sha256) throw new TypeError(`Fragment ${fragment.fragmentId} digest differs.`);
  const fixtures = new Map<string, ShaderQualificationFixtureManifest>();
  for (const ref of bundle.fixtures) {
    const bytes = requireBytes(ref.path); if (await computeSha256(bytes) !== ref.sha256) throw new TypeError(`Fixture ${ref.fixtureId} digest differs.`);
    const unit = bundle.inventory.compileUnits.find((candidate) => candidate.qualificationFixture.fixtureId === ref.fixtureId);
    if (!unit) throw new TypeError(`Fixture ${ref.fixtureId} is not referenced by a compile unit.`);
    const parsedFixture = validateQualificationFixture(json(bytes, ref.path), unit); if (!parsedFixture.ok) throw new TypeError(parsedFixture.diagnostics.map((item) => item.message).join("; "));
    if (parsedFixture.value.fixtureId !== ref.fixtureId) throw new TypeError(`Fixture ${ref.fixtureId} identity differs.`);
    fixtures.set(ref.fixtureId, parsedFixture.value);
    for (const data of fixtureDataPaths(parsedFixture.value)) { claim(data.path, `fixture-data:${data.sha256}`); if (await computeSha256(requireBytes(data.path)) !== data.sha256) throw new TypeError(`Fixture data ${data.path} digest differs.`); }
    for (const resource of parsedFixture.value.resources) {
      if (resource.kind === "sampler" || !resource.initialData) continue;
      const data = requireBytes(resource.initialData.path);
      if (resource.kind === "buffer") {
        if (data.byteLength !== resource.byteLength) throw new TypeError(`Buffer ${resource.resourceId} initialData must exactly cover its declared bytes.`);
        continue;
      }
      if (resource.kind !== "texture") continue;
      const bytesPerTexel = TEXEL_BYTES.get(resource.format); if (!bytesPerTexel || resource.initialData.aspect !== "all") throw new TypeError(`Texture ${resource.resourceId} initialData uses an unsupported v1 format/aspect.`);
      if (!resource.usage.includes("copy-dst") || resource.sampleCount !== 1 || resource.initialData.mipLevel !== 0 || resource.initialData.origin.some((axis) => axis !== 0)) throw new TypeError(`Texture ${resource.resourceId} initialData violates the full mip-zero fixture-v1 upload contract.`);
      const capacity = textureDataBounds(resource.size[0], resource.size[1], resource.size[2], bytesPerTexel, resource.initialData.bytesPerRow, resource.initialData.rowsPerImage, `Texture ${resource.resourceId} initialData`);
      if (data.byteLength < capacity.minimum || data.byteLength > capacity.maximum) throw new TypeError(`Texture ${resource.resourceId} initialData byte length is outside its declared row/image capacity.`);
    }
  }
  const fragments = new Map(bundle.inventory.fragments.map((fragment) => [fragment.fragmentId, requireBytes(fragment.path)]));
  const moduleRefs = new Map(bundle.modules.map((module) => [module.moduleId, module]));
  for (const unit of bundle.inventory.compileUnits) {
    const consumed = new Set<string>();
    for (const module of unit.modules) {
      if (module.assembly.kind !== "concat-v1" || module.assembly.fragmentIds.length === 0) throw new TypeError(`Compile unit ${unit.compileUnitId} has an unsupported/vacuous assembly recipe.`);
      const pieces = module.assembly.fragmentIds.map((fragmentId) => { const bytes = fragments.get(fragmentId); if (!bytes) throw new TypeError(`Assembly references missing fragment ${fragmentId}.`); consumed.add(fragmentId); return bytes; });
      const length = pieces.reduce((sum, bytes) => sum + bytes.byteLength, 0) + pieces.length - 1; const assembled = new Uint8Array(length); let cursor = 0;
      pieces.forEach((bytes, index) => { assembled.set(bytes, cursor); cursor += bytes.byteLength; if (index < pieces.length - 1) assembled[cursor++] = 0x0a; });
      if (await computeSha256(assembled) !== module.sha256) throw new TypeError(`Compile unit ${unit.compileUnitId} assembled module ${module.moduleId} digest differs.`);
      const ref = moduleRefs.get(module.moduleId); if (!ref || ref.sha256 !== module.sha256 || await computeSha256(requireBytes(ref.path)) !== ref.sha256 || !Buffer.from(assembled).equals(Buffer.from(requireBytes(ref.path)))) throw new TypeError(`Bundle module ${module.moduleId} differs from deterministic assembly.`);
    }
    const claimed = [...unit.fragmentIds].sort(); const actual = [...consumed].sort(); if (claimed.join("\n") !== actual.join("\n")) throw new TypeError(`Compile unit ${unit.compileUnitId} fragment claims differ from assembly consumption.`);
  }
  const shaderManifestCore = parseShaderVersionManifestCore(
    json(requireBytes(bundle.shaderManifestCorePath), bundle.shaderManifestCorePath),
  );
  assertExactCompileUnitPipelines(bundle, shaderManifestCore);
  const interfaceBytes = requireBytes(bundle.gpuInterfaceManifest.path); if (await computeSha256(interfaceBytes) !== bundle.gpuInterfaceManifest.sha256) throw new TypeError("GPU interface manifest file digest differs."); const claimedGpuInterface = parseGpuInterfaceManifest(json(interfaceBytes, bundle.gpuInterfaceManifest.path));
  if (shaderManifestCore.gpuInterface.manifestSha256 !== bundle.gpuInterfaceManifest.sha256 || shaderManifestCore.gpuInterface.interfaceAbiHash !== claimedGpuInterface.interfaceAbiHash || shaderManifestCore.gpuInterface.modelAbiHash !== claimedGpuInterface.modelAbiHash || shaderManifestCore.gpuInterface.interfaceId !== claimedGpuInterface.interfaceId || shaderManifestCore.gpuInterface.interfaceVersion !== claimedGpuInterface.interfaceVersion) throw new TypeError("Shader manifest core GPU interface reference differs from bundled interface.");
  const decoder = new TextDecoder("utf-8", { fatal: true }); const moduleSources = new Map(bundle.modules.map((module) => [module.moduleId, decoder.decode(requireBytes(module.path))]));
  const reflected = await validateAssembledGpuInterface({
    assembled: {
      interfaceId: claimedGpuInterface.interfaceId,
      interfaceVersion: claimedGpuInterface.interfaceVersion,
      modules: bundle.modules.map((module) => ({ moduleId: module.moduleId, source: moduleSources.get(module.moduleId)! })),
      pipelines: shaderManifestCore.pipelines,
      modelFacingRecordNames: claimedGpuInterface.modelAbi.recordNames,
      modelFacingBindings: claimedGpuInterface.modelAbi.bindings.map((binding) => ({ ...binding.source, semantic: binding.semantic })),
      semantics: claimedGpuInterface.modelAbi.semantics,
    },
    claimedManifest: claimedGpuInterface,
  });
  if (!reflected.ok) throw new TypeError(reflected.diagnostics.map((item) => item.message).join("; "));
  const gpuInterface = reflected.value;
  const regeneratedShaderAbiHash = await computeGpuAbiHash({
    kind: "shader",
    interface: gpuInterface,
    pipelines: shaderManifestCore.pipelines,
    requirements: shaderManifestCore.requirements,
  });
  if (regeneratedShaderAbiHash !== shaderManifestCore.shaderAbiHash || regeneratedShaderAbiHash !== bundle.subject.shaderAbiHash) {
    throw new TypeError("Shader ABI hash differs from regenerated final WGSL interface and pipeline descriptors.");
  }
  validateShaderDerivedRequirements({ manifest: shaderManifestCore, gpuInterface, moduleSources });
  const modelFixtures = new Map<string, ModelGpuCompatibilityDescriptor>();
  for (const ref of bundle.modelCompatibilityFixtures) {
    const modelBytes = requireBytes(ref.path); if (await computeSha256(modelBytes) !== ref.sha256) throw new TypeError(`Model compatibility fixture ${ref.fixtureId} digest differs.`);
    const fixture = parseShaderQualificationModelCompatibilityFixture(json(modelBytes, ref.path));
    if (fixture.fixtureId !== ref.fixtureId) throw new TypeError(`Model compatibility fixture ${ref.fixtureId} identity differs.`);
    const model = fixture.model;
    if (model.modelAbiHash !== gpuInterface.modelAbiHash || !shaderManifestCore.compatibleModelInterfaces.some((candidate) => candidate.interfaceId === model.gpuInterface.interfaceId
      && candidate.interfaceVersion === model.gpuInterface.interfaceVersion && candidate.manifestSha256 === model.gpuInterface.manifestSha256
      && candidate.interfaceAbiHash === model.gpuInterface.interfaceAbiHash && candidate.modelAbiHash === model.modelAbiHash)) throw new TypeError(`Model compatibility fixture ${ref.fixtureId} is not an exact advertised compatible model interface.`);
    if (shaderManifestCore.requirements.semantics.some((semantic) => !model.providedSemantics.includes(semantic))) throw new TypeError(`Model compatibility fixture ${ref.fixtureId} lacks shader-required semantics.`);
    modelFixtures.set(ref.fixtureId, model);
  }
  const fixtureModelAbiHashes = [...new Set([...modelFixtures.values()].map((model) => model.modelAbiHash))].sort();
  if (canonicalizeGpuContract(fixtureModelAbiHashes) !== canonicalizeGpuContract([...bundle.subject.modelAbiHashes].sort())) throw new TypeError("Qualification subject model ABI hashes differ from admitted model fixtures.");
  const requiredModelBindings = gpuInterface.modelAbi.bindings.filter((binding) => binding.resource.kind === "buffer" && binding.resource.recordName !== null);
  const requiredModelVertices = gpuInterface.modelAbi.vertexInputs;
  for (const unit of bundle.inventory.compileUnits) {
    const fixture = fixtures.get(unit.qualificationFixture.fixtureId); if (!fixture) throw new TypeError(`Compile unit ${unit.compileUnitId} is missing its admitted fixture.`);
    const probed = new Set<string>();
    for (const probe of fixture.layoutProbes) {
      const outputRecord = gpuInterface.records.find((candidate) => candidate.name === probe.output.recordName); if (!outputRecord) throw new TypeError(`Layout probe ${probe.probeId} output references a missing reflected record.`); const outputCodec = createGpuRecordCodec<Record<string, unknown>>(outputRecord, gpuInterface.records); const expectedBytes = new Uint8Array(outputCodec.encode(probe.output.expectedValue as Record<string, unknown>)); const readback = fixture.readbacks[probe.output.readbackIndex]; if (!readback || expectedBytes.byteLength !== readback.byteLength || canonicalizeGpuContract(outputCodec.decode(expectedBytes)) !== canonicalizeGpuContract(probe.output.expectedValue) || await computeSha256(expectedBytes) !== readback.expectedSha256) throw new TypeError(`Layout probe ${probe.probeId} expected GPU output is not an exact reflected-codec readback.`);
      if (probe.kind === "buffer-record") {
        const sourceKey = `${probe.source.moduleId}:${probe.source.group}:${probe.source.binding}`; const selected = requiredModelBindings.find((binding) => `${binding.source.moduleId}:${binding.source.group}:${binding.source.binding}` === sourceKey);
        if (!selected || selected.resource.kind !== "buffer" || selected.resource.recordName !== probe.source.recordName) throw new TypeError(`Layout probe ${probe.probeId} does not identify an exact model-facing record binding.`);
        const pipeline = unit.pipelines.find((candidate) => candidate.pipelineId === probe.pipelineId); const pipelineModules = pipeline?.kind === "compute" ? [pipeline.compute.moduleId] : pipeline ? [pipeline.vertex.moduleId, pipeline.fragment?.moduleId].filter(Boolean) : []; if (!pipeline || !pipelineModules.includes(probe.source.moduleId)) throw new TypeError(`Layout probe ${probe.probeId} pipeline does not execute its declared WGSL module.`);
        const record = gpuInterface.records.find((candidate) => candidate.name === probe.source.recordName); if (!record) throw new TypeError(`Layout probe ${probe.probeId} references a missing input record.`); const codec = createGpuRecordCodec<Record<string, unknown>>(record, gpuInterface.records);
        const inputBytes = new Uint8Array(codec.encode(probe.input.value as Record<string, unknown>)); if (inputBytes.byteLength !== probe.input.byteLength || canonicalizeGpuContract(codec.decode(inputBytes)) !== canonicalizeGpuContract(probe.input.value)) throw new TypeError(`Layout probe ${probe.probeId} input is not an exact codec-roundtrippable record value.`);
        const resource = fixture.resources.find((candidate) => candidate.resourceId === probe.input.resourceId); if (!resource || resource.kind !== "buffer" || !resource.initialData) throw new TypeError(`Layout probe ${probe.probeId} input resource lacks admitted initial bytes.`); const initialBytes = requireBytes(resource.initialData.path).subarray(probe.input.byteOffset, probe.input.byteOffset + probe.input.byteLength); if (!equalBytes(inputBytes, initialBytes)) throw new TypeError(`Layout probe ${probe.probeId} CPU encoding differs from exact uploaded input bytes.`);
        probed.add(`binding:${sourceKey}`);
        continue;
      }
      const vertexKey = `${probe.source.pipelineId}:${probe.source.shaderLocation}:${probe.source.semantic}`; const selected = requiredModelVertices.find((vertex) => `${vertex.source.pipelineId}:${vertex.source.shaderLocation}:${vertex.semantic}` === vertexKey); if (!selected) throw new TypeError(`Layout probe ${probe.probeId} does not identify an exact model-facing vertex semantic.`);
      const pipeline = unit.pipelines.find((candidate) => candidate.pipelineId === probe.source.pipelineId); if (!pipeline || pipeline.kind !== "render") throw new TypeError(`Layout probe ${probe.probeId} does not execute its declared render pipeline.`); const layout = pipeline.vertexBuffers[probe.input.vertexBufferSlot]; const attribute = layout?.attributes.find((candidate) => candidate.shaderLocation === probe.source.shaderLocation); if (!layout || !attribute || attribute.semantic !== probe.source.semantic || attribute.format !== selected.format || attribute.offset !== selected.offset || layout.arrayStride !== selected.arrayStride || layout.stepMode !== selected.stepMode) throw new TypeError(`Layout probe ${probe.probeId} pipeline vertex layout differs from the reflected model ABI.`);
      const command = fixture.commands[probe.commandIndex]; if (!command || command.kind !== "draw" || command.pipelineId !== pipeline.pipelineId) throw new TypeError(`Layout probe ${probe.probeId} does not identify its exact draw command.`); const commandBuffer = command.vertexBuffers.find((candidate) => candidate.slot === probe.input.vertexBufferSlot); if (!commandBuffer || commandBuffer.resourceId !== probe.input.resourceId) throw new TypeError(`Layout probe ${probe.probeId} input is not bound at its reflected vertex-buffer slot.`); const first = selected.stepMode === "vertex" ? command.firstVertex : command.firstInstance; const count = selected.stepMode === "vertex" ? command.vertexCount : command.instanceCount; if (probe.input.elementIndex < first || probe.input.elementIndex >= first + count) throw new TypeError(`Layout probe ${probe.probeId} element is not fetched by its draw command.`);
      const resource = fixture.resources.find((candidate) => candidate.resourceId === probe.input.resourceId); if (!resource || resource.kind !== "buffer" || !resource.initialData || !resource.usage.includes("vertex")) throw new TypeError(`Layout probe ${probe.probeId} input resource lacks admitted vertex bytes.`); const inputBytes = encodeGpuVertexFormat(selected.format, probe.input.value); const byteOffset = commandBuffer.offset + probe.input.elementIndex * selected.arrayStride + selected.offset; const boundEnd = commandBuffer.offset + commandBuffer.size; if (!Number.isSafeInteger(byteOffset) || byteOffset < commandBuffer.offset || byteOffset + inputBytes.byteLength > boundEnd || byteOffset + inputBytes.byteLength > resource.byteLength) throw new TypeError(`Layout probe ${probe.probeId} vertex fetch range is outside its bound buffer.`); const initialBytes = requireBytes(resource.initialData.path).subarray(byteOffset, byteOffset + inputBytes.byteLength); if (!equalBytes(inputBytes, initialBytes)) throw new TypeError(`Layout probe ${probe.probeId} CPU vertex encoding differs from exact uploaded input bytes.`); probed.add(`vertex:${vertexKey}`);
    }
    for (const binding of requiredModelBindings) { const key = `${binding.source.moduleId}:${binding.source.group}:${binding.source.binding}`; if (!probed.has(`binding:${key}`)) throw new TypeError(`Compile unit ${unit.compileUnitId} lacks a structured layout probe for model binding ${key}.`); }
    for (const vertex of requiredModelVertices) { const key = `${vertex.source.pipelineId}:${vertex.source.shaderLocation}:${vertex.semantic}`; if (!probed.has(`vertex:${key}`)) throw new TypeError(`Compile unit ${unit.compileUnitId} lacks a vertex byte-stream probe for model semantic ${vertex.semantic} (${key}).`); }
  }
  const coreHash = await computeShaderManifestCoreSha256(shaderManifestCore); if (coreHash !== bundle.subject.shaderManifestCore.sha256 || shaderManifestCore.shaderId !== bundle.subject.shaderManifestCore.shaderId || shaderManifestCore.version !== bundle.subject.shaderManifestCore.version || shaderManifestCore.shaderAbiHash !== bundle.subject.shaderAbiHash) throw new TypeError("Shader manifest core identity/digest differs from qualification subject.");
  const manifestModules = [...shaderManifestCore.modules].map(({ moduleId, sha256 }) => ({ moduleId, sha256 })).sort((a, b) => a.moduleId < b.moduleId ? -1 : 1); const bundleModules = [...bundle.modules].map(({ moduleId, sha256 }) => ({ moduleId, sha256 })).sort((a, b) => a.moduleId < b.moduleId ? -1 : 1); if (canonicalizeGpuContract(manifestModules) !== canonicalizeGpuContract(bundleModules)) throw new TypeError("Shader manifest core module set differs from bundle modules.");
  if (files.size !== declared.size || [...files.keys()].some((path) => !declared.has(path))) throw new TypeError(`Bundle contains undeclared files: ${[...files.keys()].filter((path) => !declared.has(path)).join(", ")}.`);
  return { root, manifest: bundle, shaderManifestCore, fixtures, gpuInterface, modelFixtures, fileBytes: files };
}
