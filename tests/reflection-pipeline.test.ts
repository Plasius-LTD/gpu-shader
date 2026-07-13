import { WgslReflect } from "wgsl_reflect/wgsl_reflect.module.js";
import { describe, expect, it } from "vitest";

import type {
  GpuEntryPointInterface,
  GpuTypeLayout,
  SerializableGpuRenderPipelineDescriptor,
} from "../src/contracts.js";
import {
  normalizeBindings,
  normalizeEntryPoints,
  normalizeOverrides,
  normalizeRecords,
  normalizeType,
  normalizeVertexInputs,
} from "../src/node/normalize-reflection.js";
import { validatePipelineInterfaces } from "../src/node/pipeline-validation.js";
import { reflectGpuInterface } from "../src/node/reflect.js";
import { parseGpuInterfaceManifest } from "../src/manifest-validation.js";
import { validateAssembledGpuInterface } from "../src/node/validate-assembled.js";
import {
  analyzeWgslSource,
  assertReflectedRecordLayouts,
} from "../src/node/wgsl-source-analysis.js";
import {
  clone,
  COMPUTE_WGSL,
  computePipeline,
  reflectedInterface,
} from "./fixtures.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

describe("independent WGSL source analysis", () => {
  it("derives nested structs, arrays, matrices, atomics, address spaces, align/size and overrides", () => {
    const analysis = analyzeWgslSource(COMPUTE_WGSL, "compute");
    expect(analysis.records.map((record) => record.name)).toEqual(["ModelData", "Nested"]);
    const nested = analysis.records.find((record) => record.name === "Nested")!;
    expect(nested).toMatchObject({
      alignment: 16,
      byteSize: 16,
      minimumByteSize: 16,
      addressSpaces: ["storage"],
      runtimeArrayMember: null,
    });
    expect(nested.members.map(({ name, offset }) => ({ name, offset }))).toEqual([
      { name: "axis", offset: 0 },
      { name: "weight", offset: 12 },
    ]);
    const model = analysis.records.find((record) => record.name === "ModelData")!;
    expect(model).toMatchObject({ alignment: 16, byteSize: 112, minimumByteSize: 112, addressSpaces: ["storage"] });
    expect(model.members.map(({ name, offset, occupiedByteSize }) => ({ name, offset, occupiedByteSize }))).toEqual([
      { name: "transform", offset: 0, occupiedByteSize: 48 },
      { name: "samples", offset: 48, occupiedByteSize: 32 },
      { name: "counter", offset: 80, occupiedByteSize: 4 },
      { name: "radius", offset: 96, occupiedByteSize: 16 },
    ]);
    expect(model.members[0]!.type).toMatchObject({ kind: "matrix", columns: 3, rows: 3, columnStride: 16 });
    expect(model.members[1]!.type).toMatchObject({ kind: "array", count: 2, stride: 16 });
    expect(model.members[2]!.type).toEqual({ kind: "atomic", scalar: "u32", alignment: 4, byteSize: 4 });
    expect(analysis.overrides).toEqual([{
      moduleId: "compute", name: "WORKGROUP_X", id: 7, type: "u32", defaultValue: 1,
    }]);
    expect(analysis.workgroupSizes.get("main")).toEqual([
      { kind: "override", name: "WORKGROUP_X" },
      { kind: "literal", value: 2 },
      { kind: "literal", value: 1 },
    ]);
  });

  it("supports runtime arrays and propagates function/private/workgroup usage transitively", () => {
    const source = `
      struct Element { value: vec4f, }
      struct Tail { count: u32, values: array<Element>, }
      struct Wrapper { element: Element, }
      var<private> privateValue: Wrapper;
      var<workgroup> workValue: Wrapper;
      @group(0) @binding(0) var<storage, read_write> tail: Tail;
      fn helper(input: Wrapper) { var local: Wrapper = input; privateValue = local; workValue = local; }
      @compute @workgroup_size(1) fn main() { helper(privateValue); tail.count = 1u; }
    `;
    const analysis = analyzeWgslSource(source, "spaces");
    const tail = analysis.records.find((record) => record.name === "Tail")!;
    expect(tail).toMatchObject({ byteSize: null, minimumByteSize: 16, runtimeArrayMember: "values" });
    expect(analysis.bindings[0]!.resource).toMatchObject({
      kind: "buffer",
      recordName: "Tail",
      minimumBindingSize: 32,
    });
    const element = analysis.records.find((record) => record.name === "Element")!;
    expect(element.addressSpaces).toEqual(["function", "private", "storage", "workgroup"]);
    expect(analysis.records.find((record) => record.name === "Wrapper")!.addressSpaces).toEqual([
      "function", "private", "workgroup",
    ]);
    expect(analysis.workgroupStorageSizes.get("main")).toBe(16);
  });

  it("derives WebGPU workgroup storage from statically used variables and called functions", () => {
    const source = `
      var<workgroup> scalar: u32;
      var<workgroup> scratch: array<vec4f, 4>;
      var<workgroup> unused: array<vec4f, 8>;
      fn helper() { scratch[0] = vec4f(1); }
      @compute @workgroup_size(1) fn main() { scalar = 1u; helper(); }
      @compute @workgroup_size(1) fn scalarOnly() { scalar = 2u; }
    `;
    const analysis = analyzeWgslSource(source, "workgroup-storage");
    expect(analysis.workgroupStorageSizes).toEqual(new Map([
      ["main", 80],
      ["scalarOnly", 16],
    ]));
  });

  it("does not treat an unallocated workgroup pointer type as workgroup storage", () => {
    const source = `
      override COUNT: u32 = 4u;
      fn writeFirst(target: ptr<workgroup, array<u32, COUNT>>) { (*target)[0] = 1u; }
      @compute @workgroup_size(1) fn main() {}
    `;
    const analysis = analyzeWgslSource(source, "workgroup-pointer");
    expect(analysis.workgroupStorageSizes.get("main")).toBe(0);
  });

  it.each([
    ["struct Bad { @align(8) value: vec4f, }", /invalid @align/u],
    ["struct Bad { @size(2) value: f32, }", /invalid @size/u],
    ["struct Bad { values: array<u32>, tail: u32, }", /non-final runtime-sized array/u],
    ["struct Bad { values: array<array<u32>>, }", /runtime-sized array cannot be nested/u],
    ["var<private> duplicate: u32; var<private> duplicate: u32;", /more than once/u],
    ["@group(0) @binding(0) var a: sampler; @group(0) @binding(0) var b: sampler;", /duplicate binding/u],
    ["@id(1) override A: u32; @id(1) override B: u32;", /repeats override/u],
    ["@compute @workgroup_size(MISSING) fn main() {}", /unknown workgroup override/u],
    ["override COUNT: u32 = 4u; var<workgroup> values: array<u32, COUNT>; @compute @workgroup_size(1) fn main() { values[0] = 1u; }", /exact reflected byte size/u],
    ["override COUNT: u32 = 4u; alias Values = array<u32, COUNT>; var<workgroup> values: Values; @compute @workgroup_size(1) fn main() { values[0] = 1u; }", /exact reflected byte size/u],
    ["override COUNT: u32 = 4u; struct Values { data: array<u32, COUNT>, } var<workgroup> values: Values; @compute @workgroup_size(1) fn main() { values.data[0] = 1u; }", /exact reflected byte size/u],
  ])("rejects malformed final WGSL: %s", (source, message) => {
    expect(() => analyzeWgslSource(source, "bad")).toThrow(message);
  });

  it("rejects independent/reflection layout disagreement", async () => {
    const manifest = await reflectedInterface();
    const changed = clone(manifest.records);
    (changed[0] as Mutable<typeof changed[number]>).minimumByteSize += 16;
    expect(() => assertReflectedRecordLayouts(manifest.records, changed)).toThrow(/disagree/u);
    expect(() => assertReflectedRecordLayouts(manifest.records, changed.slice(1))).toThrow(/inventories differ/u);
  });
});

describe("final assembled reflection", () => {
  it("stores exact workgroup bytes in the compute entry-point contract", async () => {
    const source = `
      var<workgroup> scalar: u32;
      var<workgroup> scratch: array<vec4f, 4>;
      @compute @workgroup_size(4) fn main() { scalar = 1u; scratch[0] = vec4f(1); }
    `;
    const manifest = await reflectGpuInterface({
      interfaceId: "workgroup.interface",
      interfaceVersion: "1",
      modules: [{ moduleId: "workgroup", source }],
      pipelines: [{
        kind: "compute",
        pipelineId: "workgroup.pipeline",
        layout: { bindGroups: [] },
        compute: { moduleId: "workgroup", entryPoint: "main", constants: {} },
      }],
      modelFacingRecordNames: [],
      modelFacingBindings: [],
      semantics: [],
    });
    expect(manifest.entryPoints[0]).toMatchObject({
      stage: "compute",
      workgroupStorageSize: 80,
    });
    expect(parseGpuInterfaceManifest(manifest).entryPoints[0]!.workgroupStorageSize).toBe(80);

    const stale = clone(manifest);
    (stale.entryPoints[0] as Mutable<typeof stale.entryPoints[number]>).workgroupStorageSize = null;
    expect(() => parseGpuInterfaceManifest(stale)).toThrow(/workgroupStorageSize/u);
  });

  it("regresses gpu-fluid Uint8/u32 solid masks and vec3/vec4 velocity packing", async () => {
    const source = `
      struct FluidCell { velocity: vec4f, solid: u32, }
      struct FluidCells { cells: array<FluidCell>, }
      @group(0) @binding(0) var<storage, read_write> fluid: FluidCells;
      @compute @workgroup_size(1) fn main() { fluid.cells[0].solid = 1u; }
    `;
    const pipeline = {
      kind: "compute" as const,
      pipelineId: "fluid.pipeline",
      layout: { bindGroups: [{ group: 0, entries: [{
        group: 0,
        binding: 0,
        resource: { kind: "buffer" as const, addressSpace: "storage" as const, access: "read_write" as const, recordName: "FluidCells", minimumBindingSize: 32 },
        visibility: ["compute" as const],
      }] }] },
      compute: { moduleId: "fluid", entryPoint: "main", constants: {} },
    };
    const manifest = await reflectGpuInterface({
      interfaceId: "fluid.interface",
      interfaceVersion: "1",
      modules: [{ moduleId: "fluid", source }],
      pipelines: [pipeline],
      modelFacingRecordNames: ["FluidCell", "FluidCells"],
      modelFacingBindings: [{ moduleId: "fluid", group: 0, binding: 0, semantic: "fluid.cells" }],
      semantics: [{ semantic: "fluid.cells", source: { kind: "binding", moduleId: "fluid", group: 0, binding: 0 } }],
    });
    const cell = manifest.records.find((record) => record.name === "FluidCell")!;
    expect(cell).toMatchObject({ alignment: 16, byteSize: 32, minimumByteSize: 32 });
    expect(cell.members.map(({ name, offset, valueByteSize }) => ({ name, offset, valueByteSize }))).toEqual([
      { name: "velocity", offset: 0, valueByteSize: 16 },
      { name: "solid", offset: 16, valueByteSize: 4 },
    ]);
    expect(manifest.bindings[0]!.resource).toMatchObject({ minimumBindingSize: 32 });
  });

  it("uses one runtime-array element for WebGPU minBindingSize and rejects the fixed prefix", async () => {
    const source = `
      struct Tail { count: u32, values: array<vec4f>, }
      @group(0) @binding(0) var<storage, read_write> tail: Tail;
      @compute @workgroup_size(1) fn main() { tail.count = 1u; }
    `;
    const pipeline = {
      kind: "compute" as const,
      pipelineId: "tail.pipeline",
      layout: { bindGroups: [{ group: 0, entries: [{
        group: 0,
        binding: 0,
        resource: { kind: "buffer" as const, addressSpace: "storage" as const, access: "read_write" as const, recordName: "Tail", minimumBindingSize: 32 },
        visibility: ["compute" as const],
      }] }] },
      compute: { moduleId: "tail", entryPoint: "main", constants: {} },
    };
    const manifest = await reflectGpuInterface({
      interfaceId: "tail.interface",
      interfaceVersion: "1",
      modules: [{ moduleId: "tail", source }],
      pipelines: [pipeline],
      modelFacingRecordNames: ["Tail"],
      modelFacingBindings: [{ moduleId: "tail", group: 0, binding: 0, semantic: "tail.data" }],
      semantics: [{ semantic: "tail.data", source: { kind: "binding", moduleId: "tail", group: 0, binding: 0 } }],
    });
    expect(manifest.bindings[0]!.resource).toMatchObject({ minimumBindingSize: 32 });

    const stale = clone(manifest);
    const binding = stale.bindings[0]!.resource;
    if (binding.kind !== "buffer") throw new Error("Expected a buffer fixture.");
    (binding as Mutable<typeof binding>).minimumBindingSize = 16;
    expect(() => parseGpuInterfaceManifest(stale)).toThrow(/minimumBindingSize differs/u);
  });

  it("rejects non-record model-facing buffer roots so their element types cannot hash-collide", async () => {
    const source = `
      @group(0) @binding(0) var<storage, read_write> values: array<u32, 4>;
      @compute @workgroup_size(1) fn main() { values[0] = 1u; }
    `;
    const pipeline = {
      kind: "compute" as const,
      pipelineId: "array.pipeline",
      layout: { bindGroups: [{ group: 0, entries: [{
        group: 0,
        binding: 0,
        resource: { kind: "buffer" as const, addressSpace: "storage" as const, access: "read_write" as const, recordName: null, minimumBindingSize: 16 },
        visibility: ["compute" as const],
      }] }] },
      compute: { moduleId: "array", entryPoint: "main", constants: {} },
    };
    await expect(reflectGpuInterface({
      interfaceId: "array.interface",
      interfaceVersion: "1",
      modules: [{ moduleId: "array", source }],
      pipelines: [pipeline],
      modelFacingRecordNames: [],
      modelFacingBindings: [{ moduleId: "array", group: 0, binding: 0, semantic: "array.data" }],
      semantics: [{ semantic: "array.data", source: { kind: "binding", moduleId: "array", group: 0, binding: 0 } }],
    })).rejects.toThrow(/must use a named WGSL record root/u);
  });

  it("reflects selected entry points only and ignores unrelated multi-entry resources", async () => {
    const source = `
      struct Data { value: u32, }
      @group(0) @binding(0) var<storage, read_write> firstData: Data;
      @group(0) @binding(1) var<storage, read_write> secondData: Data;
      @compute @workgroup_size(1) fn first() { firstData.value = 1u; }
      @compute @workgroup_size(1) fn second() { secondData.value = 2u; }
    `;
    const pipeline = {
      kind: "compute" as const,
      pipelineId: "first.pipeline",
      layout: { bindGroups: [{ group: 0, entries: [{
        group: 0,
        binding: 0,
        resource: { kind: "buffer" as const, addressSpace: "storage" as const, access: "read_write" as const, recordName: "Data", minimumBindingSize: 4 },
        visibility: ["compute" as const],
      }] }] },
      compute: { moduleId: "multi", entryPoint: "first", constants: {} },
    };
    const result = await reflectGpuInterface({
      interfaceId: "multi.interface",
      interfaceVersion: "1",
      modules: [{ moduleId: "multi", source }],
      pipelines: [pipeline],
      modelFacingRecordNames: ["Data"],
      modelFacingBindings: [{ moduleId: "multi", group: 0, binding: 0, semantic: "first.data" }],
      semantics: [{ semantic: "first.data", source: { kind: "binding", moduleId: "multi", group: 0, binding: 0 } }],
    });
    expect(result.entryPoints.map((entry) => entry.name)).toEqual(["first"]);
    expect(result.bindings.map((binding) => binding.binding)).toEqual([0]);
  });

  it("regresses renderer/lighting canonical record drift across assembled modules", async () => {
    const base = `struct WavefrontSurfaceRecord { normal_roughness: vec4f, }`;
    const source = `${base}\n@compute @workgroup_size(1) fn main() {}`;
    const pipeline = {
      kind: "compute" as const,
      pipelineId: "shared.pipeline",
      layout: { bindGroups: [] },
      compute: { moduleId: "first", entryPoint: "main", constants: {} },
    };
    const result = await reflectGpuInterface({
      interfaceId: "shared.interface",
      interfaceVersion: "1",
      modules: [{ moduleId: "first", source }, { moduleId: "second", source: base }],
      pipelines: [pipeline],
      modelFacingRecordNames: ["WavefrontSurfaceRecord"],
      modelFacingBindings: [],
      semantics: [],
    });
    expect(result.records.filter((record) => record.name === "WavefrontSurfaceRecord")).toHaveLength(1);

    await expect(reflectGpuInterface({
      interfaceId: "shared.interface",
      interfaceVersion: "1",
      modules: [{ moduleId: "first", source }, { moduleId: "second", source: "struct WavefrontSurfaceRecord { normal_roughness: vec3f, }" }],
      pipelines: [pipeline],
      modelFacingRecordNames: ["WavefrontSurfaceRecord"],
      modelFacingBindings: [],
      semantics: [],
    })).rejects.toThrow(/different layouts/u);
  });

  it("regenerates and rejects caller-supplied or expected ABI drift", async () => {
    const assembled = {
      interfaceId: "model.interface",
      interfaceVersion: "1.0.0",
      modules: [{ moduleId: "compute", source: COMPUTE_WGSL }],
      pipelines: [computePipeline()],
      modelFacingRecordNames: ["ModelData"],
      modelFacingBindings: [{ moduleId: "compute", group: 0, binding: 0, semantic: "model.data" }],
      semantics: [{ semantic: "model.data", source: { kind: "binding" as const, moduleId: "compute", group: 0, binding: 0 } }],
    };
    expect((await validateAssembledGpuInterface({ assembled })).ok).toBe(true);
    const claim = clone(await reflectedInterface());
    (claim as Mutable<typeof claim>).interfaceAbiHash = "f".repeat(64) as typeof claim.interfaceAbiHash;
    const staleClaim = await validateAssembledGpuInterface({ assembled, claimedManifest: claim });
    expect(staleClaim.ok).toBe(false);
    if (!staleClaim.ok) expect(staleClaim.diagnostics[0]!.code).toBe("interface-abi-mismatch");
    const expected = clone(await reflectedInterface());
    (expected as Mutable<typeof expected>).modelAbiHash = "e".repeat(64) as typeof expected.modelAbiHash;
    const modelDrift = await validateAssembledGpuInterface({ assembled, expectedModelInterface: expected });
    expect(modelDrift.ok).toBe(false);
    if (!modelDrift.ok) expect(modelDrift.diagnostics[0]!.code).toBe("model-abi-mismatch");
  });
});

function renderPipeline(format: string): SerializableGpuRenderPipelineDescriptor {
  return {
    kind: "render",
    pipelineId: `render.${format}`,
    layout: { bindGroups: [] },
    vertex: { moduleId: "render", entryPoint: "vertexMain", constants: {} },
    fragment: null,
    vertexBuffers: [{
      arrayStride: 16,
      stepMode: "vertex",
      attributes: [{ format, offset: 0, shaderLocation: 0, semantic: "model.position" }],
    }],
    primitive: { topology: "triangle-list", stripIndexFormat: null, frontFace: "ccw", cullMode: "none", unclippedDepth: false },
    colorTargets: [],
    depthStencil: null,
    multisample: { count: 1, mask: 0xffff_ffff, alphaToCoverageEnabled: false },
  };
}

function vertexEntry(type: GpuTypeLayout): GpuEntryPointInterface {
  return {
    moduleId: "render",
    name: "vertexMain",
    stage: "vertex",
    inputs: [{ name: "position", locationKind: "location", location: 0, interpolation: null, type }],
    outputs: [],
    bindingKeys: [],
    overrideNames: [],
    workgroupSize: null,
    workgroupStorageSize: null,
  };
}

describe("pipeline/interface cross-validation", () => {
  it.each([
    ["float32", "f32"],
    ["float16x2", "f32"],
    ["uint8x2", "u32"],
    ["sint16x2", "i32"],
    ["unorm8x2", "f32"],
    ["snorm16x4", "f32"],
    ["unorm10-10-10-2", "f32"],
  ] as const)("accepts WebGPU vertex format %s by base type despite component-width differences", (format, scalar) => {
    const type: GpuTypeLayout = { kind: "vector", scalar, width: 3, alignment: 16, byteSize: 12 };
    const result = validatePipelineInterfaces({
      sourceBindings: [], entryPoints: [vertexEntry(type)], overrides: [], pipelines: [renderPipeline(format)],
    });
    expect(result.vertexInputs[0]).toMatchObject({ format, semantic: "model.position" });
  });

  it("rejects unsupported, out-of-bounds and base-type-incompatible vertex declarations", () => {
    const entry = vertexEntry({ kind: "vector", scalar: "f32", width: 3, alignment: 16, byteSize: 12 });
    expect(() => validatePipelineInterfaces({ sourceBindings: [], entryPoints: [entry], overrides: [], pipelines: [renderPipeline("invented")] })).toThrow(/unsupported vertex format/u);
    const bounds = renderPipeline("float32x4");
    (bounds.vertexBuffers[0]!.attributes[0] as Mutable<typeof bounds.vertexBuffers[number]["attributes"][number]>).offset = 4;
    expect(() => validatePipelineInterfaces({ sourceBindings: [], entryPoints: [entry], overrides: [], pipelines: [bounds] })).toThrow(/out-of-bounds/u);
    expect(() => validatePipelineInterfaces({
      sourceBindings: [],
      entryPoints: [vertexEntry({ kind: "scalar", scalar: "u32", alignment: 4, byteSize: 4 })],
      overrides: [], pipelines: [renderPipeline("float32")],
    })).toThrow(/incompatible/u);
  });

  it("requires exact binding visibility/resource layout and override values", async () => {
    const manifest = await reflectedInterface();
    const sourceBindings = manifest.bindings.map(({ moduleId, variableName, group, binding, resource }) => ({
      moduleId, variableName, group, binding, resource,
    }));
    expect(validatePipelineInterfaces({
      sourceBindings, entryPoints: manifest.entryPoints, overrides: manifest.overrides, pipelines: [computePipeline()],
    }).bindings).toHaveLength(1);

    const visibility = clone(computePipeline());
    (visibility.layout.bindGroups[0]!.entries[0] as Mutable<typeof visibility.layout.bindGroups[number]["entries"][number]>).visibility = ["vertex"];
    expect(() => validatePipelineInterfaces({ sourceBindings, entryPoints: manifest.entryPoints, overrides: manifest.overrides, pipelines: [visibility] })).toThrow(/visibility/u);

    const resource = clone(computePipeline());
    const binding = resource.layout.bindGroups[0]!.entries[0]!.resource;
    if (binding.kind !== "buffer") throw new Error("Fixture resource must be buffer.");
    (binding as Mutable<typeof binding>).minimumBindingSize = 128;
    expect(() => validatePipelineInterfaces({ sourceBindings, entryPoints: manifest.entryPoints, overrides: manifest.overrides, pipelines: [resource] })).toThrow(/differs from final WGSL/u);

    const badOverride = computePipeline({ WORKGROUP_X: -1 });
    expect(() => validatePipelineInterfaces({ sourceBindings, entryPoints: manifest.entryPoints, overrides: manifest.overrides, pipelines: [badOverride] })).toThrow(/incompatible with u32/u);
  });
});

describe("reflection normalization boundaries", () => {
  it("normalizes reflector types, records, bindings, entries, overrides and empty vertex inputs", () => {
    const reflection = new WgslReflect(COMPUTE_WGSL);
    const records = normalizeRecords(reflection);
    expect(records.find((record) => record.name === "ModelData")?.byteSize).toBe(112);
    expect(normalizeBindings("compute", reflection, [computePipeline()])).toMatchObject([{ group: 0, binding: 0 }]);
    const analysis = analyzeWgslSource(COMPUTE_WGSL, "compute");
    const entries = normalizeEntryPoints("compute", reflection, analysis.workgroupSizes, analysis.workgroupStorageSizes);
    expect(entries[0]).toMatchObject({ name: "main", stage: "compute" });
    expect(normalizeOverrides("compute", reflection)[0]).toMatchObject({ name: "WORKGROUP_X", id: 7, type: "u32" });
    expect(normalizeVertexInputs([computePipeline()], entries)).toEqual([]);
  });

  it("normalizes scalar/vector/matrix/array/record shapes and rejects unsupported types", () => {
    expect(normalizeType({ name: "vec3f" })).toEqual({ kind: "vector", scalar: "f32", width: 3, alignment: 16, byteSize: 12 });
    expect(normalizeType({ name: "mat2x3h" })).toMatchObject({ kind: "matrix", scalar: "f16", columns: 2, rows: 3, columnStride: 8 });
    expect(normalizeType({ name: "atomic", format: { name: "u32" } })).toEqual({ kind: "atomic", scalar: "u32", alignment: 4, byteSize: 4 });
    expect(normalizeType({ name: "array", isArray: true, format: { name: "u32" }, count: 4, stride: 4 })).toMatchObject({ kind: "array", count: 4, byteSize: 16 });
    expect(normalizeType({ name: "Record", isStruct: true, members: [], align: 16, size: 32 })).toMatchObject({ kind: "record", recordName: "Record", alignment: 16, byteSize: 32 });
    expect(() => normalizeType({ name: "texture_2d" })).toThrow(/Unsupported reflected WGSL type/u);
  });
});
