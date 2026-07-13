import { describe, expect, it } from "vitest";

import type {
  GpuBindingResourceLayout,
  GpuEntryPointInterface,
  GpuOverrideLayout,
  SerializableGpuComputePipelineDescriptor,
  SerializableGpuRenderPipelineDescriptor,
} from "../src/contracts.js";
import {
  normalizeBindings,
  normalizeEntryPoints,
  normalizeRecords,
  normalizeType,
  normalizeVertexInputs,
} from "../src/node/normalize-reflection.js";
import { validatePipelineInterfaces } from "../src/node/pipeline-validation.js";
import { reflectGpuInterface } from "../src/node/reflect.js";
import { validateAssembledGpuInterface } from "../src/node/validate-assembled.js";
import { analyzeWgslSource } from "../src/node/wgsl-source-analysis.js";

function computeEntry(overrides: readonly string[] = [], bindingKeys: readonly string[] = []): GpuEntryPointInterface {
  return {
    moduleId: "module",
    name: "main",
    stage: "compute",
    inputs: [],
    outputs: [],
    bindingKeys,
    overrideNames: overrides,
    workgroupSize: [{ kind: "literal", value: 1 }, { kind: "literal", value: 1 }, { kind: "literal", value: 1 }],
    workgroupStorageSize: 0,
  };
}

function computePipeline(
  entries: SerializableGpuComputePipelineDescriptor["layout"]["bindGroups"] = [],
  constants: Readonly<Record<string, boolean | number>> = {},
): SerializableGpuComputePipelineDescriptor {
  return {
    kind: "compute",
    pipelineId: "pipeline",
    layout: { bindGroups: entries },
    compute: { moduleId: "module", entryPoint: "main", constants },
  };
}

const storageBuffer: GpuBindingResourceLayout = {
  kind: "buffer",
  addressSpace: "storage",
  access: "read_write",
  recordName: "Data",
  minimumBindingSize: 4,
};

function bindingGroup(
  resource: GpuBindingResourceLayout = storageBuffer,
  visibility: readonly ("vertex" | "fragment" | "compute")[] = ["compute"],
  group = 0,
  binding = 0,
) {
  return [{ group, entries: [{ group, binding, resource, visibility }] }];
}

describe("reflection normalization branch coverage", () => {
  it("normalizes every scalar family and shorthand/fallback layout form", () => {
    expect(["bool", "f16", "f32", "i32", "u32"].map((name) => normalizeType({ name }))).toMatchObject([
      { kind: "scalar", scalar: "bool", byteSize: 4 },
      { kind: "scalar", scalar: "f16", byteSize: 2 },
      { kind: "scalar", scalar: "f32", byteSize: 4 },
      { kind: "scalar", scalar: "i32", byteSize: 4 },
      { kind: "scalar", scalar: "u32", byteSize: 4 },
    ]);
    expect(normalizeType({ name: "vec2", format: { name: "u32" } })).toMatchObject({ width: 2, alignment: 8 });
    expect(normalizeType({ name: "mat4x2", format: { name: "f32" } })).toMatchObject({ columns: 4, rows: 2, columnStride: 8 });
    expect(normalizeType({ name: "array", isArray: true, format: { name: "u32" }, count: 0, stride: 0 })).toMatchObject({ count: null, stride: 4, byteSize: null });
    expect(normalizeType({ name: "Tail", isStruct: true, align: 16, size: 32, members: [{ type: { isArray: true, count: 0 } }] })).toMatchObject({ kind: "record", byteSize: null });
  });

  it.each([
    [{ name: "atomic", format: { name: "f32" } }, /Unsupported atomic scalar/u],
    [{ name: "vec3", format: { name: "invented" } }, /Unsupported vector scalar/u],
    [{ name: "mat3x3", format: { name: "i32" } }, /Unsupported matrix scalar/u],
  ])("rejects an unsupported reflected shape %#", (type, error) => {
    expect(() => normalizeType(type)).toThrow(error);
  });

  it("normalizes records and fallback uniform/storage bindings without a pipeline descriptor", () => {
    const reflectedStruct = {
      name: "Data",
      align: 16,
      size: 16,
      members: [{
        name: "value",
        offset: 0,
        attributes: [{ name: "align", value: "16" }, { name: "size", value: "16" }],
        type: { name: "f32" },
      }],
    };
    const uniform = { name: "uniformData", group: 0, binding: 0, size: 16, type: { name: "Data", isStruct: true } };
    const storage = { name: "storageData", group: 0, binding: 1, size: 16, resourceType: 1, access: "read_write", type: { name: "Data", isStruct: true } };
    const reflection = {
      structs: [reflectedStruct],
      uniforms: [uniform],
      storage: [storage],
      textures: [],
      samplers: [],
      entry: { vertex: [], fragment: [], compute: [] },
      overrides: [],
    };
    expect(normalizeRecords(reflection)[0]).toMatchObject({
      addressSpaces: ["storage", "uniform"],
      members: [{ alignment: 16, occupiedByteSize: 16, explicitAlign: 16, explicitSize: 16 }],
    });
    expect(normalizeBindings("module", reflection, [])).toMatchObject([
      { variableName: "uniformData", resource: { kind: "buffer", addressSpace: "uniform", access: "read" } },
      { variableName: "storageData", resource: { kind: "buffer", addressSpace: "storage", access: "read_write" } },
    ]);
    expect(() => normalizeBindings("module", { ...reflection, uniforms: [], storage: [], textures: [{ name: "texture", group: 0, binding: 2 }], samplers: [] }, [])).toThrow(/explicit pipeline layout/u);
  });

  it("normalizes all entry-point stages and validates reflected vertex locations", () => {
    const io = { name: "value", locationType: "location", location: 0, interpolation: "flat", type: { name: "vec4f" } };
    const functionShape = { name: "entry", inputs: [io], outputs: [io], resources: [], overrides: [] };
    const entries = normalizeEntryPoints("module", {
      entry: { vertex: [functionShape], fragment: [functionShape], compute: [functionShape] },
    }, new Map([["entry", [{ kind: "literal", value: 2 }, { kind: "literal", value: 1 }, { kind: "literal", value: 1 }]]]), new Map([["entry", 64]]));
    expect(entries.map(({ stage, workgroupSize, workgroupStorageSize }) => ({ stage, workgroupSize, workgroupStorageSize }))).toEqual([
      { stage: "vertex", workgroupSize: null, workgroupStorageSize: null },
      { stage: "fragment", workgroupSize: null, workgroupStorageSize: null },
      { stage: "compute", workgroupSize: [{ kind: "literal", value: 2 }, { kind: "literal", value: 1 }, { kind: "literal", value: 1 }], workgroupStorageSize: 64 },
    ]);

    const render: SerializableGpuRenderPipelineDescriptor = {
      kind: "render",
      pipelineId: "render",
      layout: { bindGroups: [] },
      vertex: { moduleId: "module", entryPoint: "entry", constants: {} },
      fragment: null,
      vertexBuffers: [{ arrayStride: 16, stepMode: "instance", attributes: [{ format: "float32x4", offset: 0, shaderLocation: 0, semantic: null }] }],
      primitive: { topology: "triangle-list", stripIndexFormat: null, frontFace: "ccw", cullMode: "none", unclippedDepth: false },
      colorTargets: [],
      depthStencil: null,
      multisample: { count: 1, mask: 0xffff_ffff, alphaToCoverageEnabled: false },
    };
    expect(normalizeVertexInputs([render], entries)).toMatchObject([{ pipelineId: "render", bufferSlot: 0, stepMode: "instance" }]);
    expect(() => normalizeVertexInputs([{ ...render, vertex: { ...render.vertex, entryPoint: "missing" } }], entries)).toThrow(/was not reflected/u);
    expect(() => normalizeVertexInputs([{ ...render, vertexBuffers: [{ ...render.vertexBuffers[0]!, attributes: [{ ...render.vertexBuffers[0]!.attributes[0]!, shaderLocation: 1 }] }] }], entries)).toThrow(/absent from WGSL/u);
  });
});

describe("independent WGSL fail-closed branch coverage", () => {
  it("derives every declarative resource family and texture dimension", () => {
    const source = `
      @group(0) @binding(0) var filterSampler: sampler;
      @group(0) @binding(1) var compareSampler: sampler_comparison;
      @group(0) @binding(2) var sampled1d: texture_1d<f32>;
      @group(0) @binding(3) var sampled2dArray: texture_2d_array<i32>;
      @group(0) @binding(4) var sampledCube: texture_cube<u32>;
      @group(0) @binding(5) var sampledCubeArray: texture_cube_array<f32>;
      @group(0) @binding(6) var sampled3d: texture_3d<f32>;
      @group(0) @binding(7) var multisampled: texture_multisampled_2d<f32>;
      @group(0) @binding(8) var depth: texture_depth_2d;
      @group(0) @binding(9) var externalImage: texture_external;
      @group(0) @binding(10) var storageImage: texture_storage_3d<rgba8unorm, read_write>;
      @compute @workgroup_size(1) fn main() {}
    `;
    const resources = analyzeWgslSource(source, "resources").bindings.map((binding) => binding.resource);
    expect(resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "sampler", samplerType: "filtering" }),
      expect.objectContaining({ kind: "sampler", samplerType: "comparison" }),
      expect.objectContaining({ kind: "texture", viewDimension: "1d", sampleType: "float" }),
      expect.objectContaining({ kind: "texture", viewDimension: "2d-array", sampleType: "sint" }),
      expect.objectContaining({ kind: "texture", viewDimension: "cube", sampleType: "uint" }),
      expect.objectContaining({ kind: "texture", viewDimension: "cube-array" }),
      expect.objectContaining({ kind: "texture", viewDimension: "3d" }),
      expect.objectContaining({ kind: "texture", multisampled: true }),
      expect.objectContaining({ kind: "texture", sampleType: "depth" }),
      { kind: "external-texture" },
      expect.objectContaining({ kind: "storage-texture", access: "read-write", viewDimension: "3d" }),
    ]));
  });

  it.each([
    ["struct Data { flag: bool, } @group(0) @binding(0) var<storage, read> data: Data;", /bool in a host-shareable/u],
    ["struct Data { value: atomic<u32>, } @group(0) @binding(0) var<uniform> data: Data;", /atomic data in uniform/u],
    ["struct Data { value: atomic<u32>, } var<private> data: Data;", /atomic data outside/u],
    ["struct Data { values: array<u32>, } var<private> data: Data;", /runtime arrays are only valid/u],
    ["struct Data { value: f16, }", /uses f16 without enable/u],
    ["struct Data { values: array<f32, 2>, } @group(0) @binding(0) var<uniform> data: Data;", /uniform array stride/u],
    ["@group(0) var broken: sampler;", /both @group and @binding/u],
    ["struct Data { value: atomic<u32>, } @group(0) @binding(0) var<storage, read> data: Data;", /must use read_write/u],
    ["@compute @workgroup_size(1, 1, 1, 1) fn main() {}", /invalid @workgroup_size/u],
  ])("rejects invalid WGSL host/resource rules %#", (source, expected) => {
    expect(() => analyzeWgslSource(source, "invalid")).toThrow(expected);
  });

  it("accepts f16 only with an explicit enable and rejects unsupported resource dimensions", () => {
    expect(analyzeWgslSource("enable f16; struct Data { value: vec2h, }", "f16").records[0]).toMatchObject({ byteSize: 4 });
    expect(() => analyzeWgslSource("@group(0) @binding(0) var image: texture_4d<f32>;", "texture")).toThrow();
  });
});

describe("pipeline/interface validation edge coverage", () => {
  const sourceBinding = (resource: GpuBindingResourceLayout = storageBuffer) => ({
    moduleId: "module", variableName: "data", group: 0, binding: 0, resource,
  });

  it("accepts sampler and sampled-texture compatibility substitutions", () => {
    const cases: readonly [GpuBindingResourceLayout, GpuBindingResourceLayout][] = [
      [{ kind: "sampler", samplerType: "filtering" }, { kind: "sampler", samplerType: "non-filtering" }],
      [{ kind: "sampler", samplerType: "comparison" }, { kind: "sampler", samplerType: "comparison" }],
      [{ kind: "texture", sampleType: "float", viewDimension: "2d", multisampled: false }, { kind: "texture", sampleType: "unfilterable-float", viewDimension: "2d", multisampled: false }],
    ];
    for (const [source, declared] of cases) {
      expect(validatePipelineInterfaces({
        sourceBindings: [sourceBinding(source)],
        entryPoints: [computeEntry([], ["module:0:0"])],
        overrides: [],
        pipelines: [computePipeline(bindingGroup(declared))],
      }).bindings).toHaveLength(1);
    }
  });

  it.each([
    ["duplicate binding key", [sourceBinding(), sourceBinding()], [computeEntry([], ["module:0:0"])], [computePipeline(bindingGroup())], /Duplicate reflected/u],
    ["duplicate pipeline", [sourceBinding()], [computeEntry([], ["module:0:0"])], [computePipeline(bindingGroup()), computePipeline(bindingGroup())], /Duplicate or empty pipelineId/u],
    ["noncontiguous group", [sourceBinding()], [computeEntry([], ["module:0:0"])], [computePipeline(bindingGroup(storageBuffer, ["compute"], 1))], /contiguous from zero/u],
    ["mismatched group coordinate", [sourceBinding()], [computeEntry([], ["module:0:0"])], [computePipeline([{ group: 0, entries: [{ group: 1, binding: 0, resource: storageBuffer, visibility: ["compute"] }] }])], /mismatched group coordinate/u],
    ["repeated declared binding", [sourceBinding()], [computeEntry([], ["module:0:0"])], [computePipeline([{ group: 0, entries: [{ group: 0, binding: 0, resource: storageBuffer, visibility: ["compute"] }, { group: 0, binding: 0, resource: storageBuffer, visibility: ["compute"] }] }])], /repeats group/u],
    ["missing entry", [], [], [computePipeline()], /references missing compute entry/u],
    ["missing workgroup", [], [{ ...computeEntry(), workgroupSize: null }], [computePipeline()], /lacks @workgroup_size/u],
    ["missing workgroup storage", [], [{ ...computeEntry(), workgroupStorageSize: null }], [computePipeline()], /lacks reflected workgroup storage size/u],
    ["unused descriptor binding", [sourceBinding()], [computeEntry()], [computePipeline(bindingGroup())], /absent from its entry-point interface/u],
    ["undeclared source binding", [], [computeEntry([], ["module:0:0"])], [computePipeline(bindingGroup())], /undeclared source binding/u],
    ["omitted descriptor binding", [sourceBinding()], [computeEntry([], ["module:0:0"])], [computePipeline()], /omits reflected binding/u],
  ] as const)("rejects %s", (_label, sources, entries, pipelines, error) => {
    expect(() => validatePipelineInterfaces({ sourceBindings: sources, entryPoints: entries, overrides: [], pipelines })).toThrow(error);
  });

  it("rejects override aliases, unknown constants, missing declarations and missing defaults", () => {
    const declared: GpuOverrideLayout = { moduleId: "module", name: "COUNT", id: 4, type: "i32", defaultValue: null };
    const entry = computeEntry(["COUNT"]);
    expect(() => validatePipelineInterfaces({ sourceBindings: [], entryPoints: [entry], overrides: [declared], pipelines: [computePipeline([], { missing: 1 })] })).toThrow(/unknown or unused/u);
    expect(() => validatePipelineInterfaces({ sourceBindings: [], entryPoints: [entry], overrides: [declared], pipelines: [computePipeline([], { COUNT: 1, 4: 1 })] })).toThrow(/both name\/ID aliases/u);
    expect(() => validatePipelineInterfaces({ sourceBindings: [], entryPoints: [entry], overrides: [], pipelines: [computePipeline()] })).toThrow(/references missing override/u);
    expect(() => validatePipelineInterfaces({ sourceBindings: [], entryPoints: [entry], overrides: [declared], pipelines: [computePipeline()] })).toThrow(/must supply override/u);
  });
});

describe("assembled reflection error normalization", () => {
  it("rejects empty/duplicate modules and returns a generic diagnostic for a non-Error reflection failure", async () => {
    await expect(reflectGpuInterface({
      interfaceId: "empty",
      interfaceVersion: "1",
      modules: [],
      pipelines: [],
      modelFacingRecordNames: [],
      modelFacingBindings: [],
      semantics: [],
    })).rejects.toThrow(/At least one/u);

    await expect(reflectGpuInterface({
      interfaceId: "duplicate",
      interfaceVersion: "1",
      modules: [{ moduleId: "same", source: "" }, { moduleId: "same", source: "" }],
      pipelines: [],
      modelFacingRecordNames: [],
      modelFacingBindings: [],
      semantics: [],
    })).rejects.toThrow(/Duplicate moduleId/u);

    const assembled = {
      interfaceId: "broken",
      interfaceVersion: "1",
      get modules(): never { throw "not-an-error"; },
      pipelines: [],
      modelFacingRecordNames: [],
      modelFacingBindings: [],
      semantics: [],
    };
    const result = await validateAssembledGpuInterface({ assembled });
    expect(result).toEqual({ ok: false, diagnostics: [{ code: "invalid-contract", severity: "error", message: "WGSL reflection failed." }] });
  });
});
