import { describe, expect, it } from "vitest";

import type {
  GpuInterfaceManifest,
  GpuRecordLayout,
  ReflectGpuInterfaceInput,
  SerializableGpuRenderPipelineDescriptor,
} from "../src/contracts.js";
import { generateGpuInterfaceArtifacts } from "../src/node/generate-artifacts.js";
import { reflectGpuInterface } from "../src/node/reflect.js";
import { clone, reflectedInterface } from "./fixtures.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const member = (
  name: string,
  offset: number,
  type: GpuRecordLayout["members"][number]["type"],
): GpuRecordLayout["members"][number] => ({
  name,
  offset,
  alignment: type.alignment,
  valueByteSize: type.byteSize,
  occupiedByteSize: type.byteSize,
  explicitAlign: null,
  explicitSize: null,
  type,
});

describe("generated reflection artifacts edge coverage", () => {
  it("emits safe identifiers, disambiguated constants, and every schema/type family", async () => {
    const manifest = clone(await reflectedInterface());
    const nested: GpuRecordLayout = {
      name: "nested/record~name",
      alignment: 4,
      byteSize: 4,
      minimumByteSize: 4,
      runtimeArrayMember: null,
      addressSpaces: ["storage"],
      members: [member("value", 0, { kind: "scalar", scalar: "f32", alignment: 4, byteSize: 4 })],
    };
    const unusual: GpuRecordLayout = {
      name: "9---record",
      alignment: 16,
      byteSize: 144,
      minimumByteSize: 144,
      runtimeArrayMember: null,
      addressSpaces: ["storage"],
      members: [
        member("a-b", 0, { kind: "scalar", scalar: "bool", alignment: 4, byteSize: 4 }),
        member("a_b", 4, { kind: "atomic", scalar: "u32", alignment: 4, byteSize: 4 }),
        member("signed", 8, { kind: "scalar", scalar: "i32", alignment: 4, byteSize: 4 }),
        member("half", 12, { kind: "scalar", scalar: "f16", alignment: 2, byteSize: 2 }),
        member("unsigned", 16, { kind: "scalar", scalar: "u32", alignment: 4, byteSize: 4 }),
        member("vector", 32, { kind: "vector", scalar: "f32", width: 4, alignment: 16, byteSize: 16 }),
        member("matrix", 48, { kind: "matrix", scalar: "f32", columns: 2, rows: 2, columnStride: 8, alignment: 8, byteSize: 16 }),
        member("fixed", 64, { kind: "array", element: { kind: "scalar", scalar: "u32", alignment: 4, byteSize: 4 }, count: 2, stride: 4, alignment: 4, byteSize: 8 }),
        member("variable", 80, { kind: "array", element: { kind: "scalar", scalar: "f32", alignment: 4, byteSize: 4 }, count: null, stride: 4, alignment: 4, byteSize: null }),
        member("nested", 96, { kind: "record", recordName: nested.name, alignment: 4, byteSize: 4 }),
      ],
    };
    // Artifact generation intentionally accepts an already reflected manifest. Duplicate
    // names below only exercise deterministic collision suffixes; admission parsing rejects
    // such a manifest before it can be published.
    const duplicate = { ...unusual, name: "---" };
    (manifest as Mutable<GpuInterfaceManifest>).records = [...manifest.records, nested, unusual, duplicate, duplicate, duplicate];
    (manifest.modelAbi as Mutable<typeof manifest.modelAbi>).recordNames = [unusual.name, duplicate.name];
    (manifest.modelAbi as Mutable<typeof manifest.modelAbi>).bindings = [];
    (manifest.modelAbi as Mutable<typeof manifest.modelAbi>).semantics = [{
      semantic: "nested.value",
      source: { kind: "record-member", recordName: unusual.name, memberPath: ["nested", "value"] },
    }];

    const generated = generateGpuInterfaceArtifacts(manifest);
    expect(generated.typescriptTypes).toContain("Gpu_392d2d2d7265636f7264GpuRecord");
    expect(generated.typescriptTypes).toContain("readonly [number, number, number, number]");
    expect(generated.typescriptTypes).toContain("readonly [readonly [number, number], readonly [number, number]]");
    expect(generated.typescriptTypes).toContain("readonly number[]");
    expect(generated.byteConstants).toMatch(/_X[0-9a-f]+_2_ALIGNMENT/u);
    expect(generated.byteConstants).toContain("GPU_9_RECORD_ALIGNMENT");
    const schema = JSON.parse(generated.jsonSchemas) as { $defs: Record<string, { properties: Record<string, unknown> }> };
    const properties = schema.$defs[unusual.name]!.properties;
    expect(properties).toMatchObject({
      "a-b": { type: "boolean" },
      signed: { type: "integer", minimum: -2147483648 },
      half: { type: "number", minimum: -65504 },
      unsigned: { type: "integer", minimum: 0 },
      fixed: { type: "array", minItems: 2, maxItems: 2 },
      variable: { type: "array" },
      nested: { $ref: "#/$defs/nested~1record~0name" },
    });
  });

  it("fails closed when a model projection references a missing reflected record", async () => {
    const manifest = clone(await reflectedInterface());
    (manifest.modelAbi as Mutable<typeof manifest.modelAbi>).recordNames = ["Absent"];
    expect(() => generateGpuInterfaceArtifacts(manifest)).toThrow(/missing record Absent/u);
  });
});

function storageReflectionInput(overrides: Partial<ReflectGpuInterfaceInput> = {}): ReflectGpuInterfaceInput {
  const source = `
    struct Data { value: f32, }
    @group(0) @binding(0) var<storage, read_write> data: Data;
    @compute @workgroup_size(1) fn main() { data.value = data.value + 1.0; }
  `;
  return {
    interfaceId: "selector.interface",
    interfaceVersion: "1",
    modules: [{ moduleId: "module", source }],
    pipelines: [{
      kind: "compute",
      pipelineId: "compute",
      layout: { bindGroups: [{ group: 0, entries: [{
        group: 0,
        binding: 0,
        resource: { kind: "buffer", addressSpace: "storage", access: "read_write", recordName: "Data", minimumBindingSize: 4 },
        visibility: ["compute"],
      }] }] },
      compute: { moduleId: "module", entryPoint: "main", constants: {} },
    }],
    modelFacingRecordNames: ["Data"],
    modelFacingBindings: [{ moduleId: "module", group: 0, binding: 0, semantic: "model.data" }],
    semantics: [{ semantic: "model.data", source: { kind: "binding", moduleId: "module", group: 0, binding: 0 } }],
    ...overrides,
  };
}

describe("model selector validation edge coverage", () => {
  it("rejects missing records, bindings, duplicate selectors, and unprojected binding semantics", async () => {
    await expect(reflectGpuInterface(storageReflectionInput({ modelFacingRecordNames: ["Absent"] }))).rejects.toThrow(/was not found/u);
    await expect(reflectGpuInterface(storageReflectionInput({
      modelFacingBindings: [{ moduleId: "module", group: 0, binding: 9, semantic: null }],
      semantics: [],
    }))).rejects.toThrow(/was not reflected/u);
    const selector = { moduleId: "module", group: 0, binding: 0, semantic: "model.data" } as const;
    await expect(reflectGpuInterface(storageReflectionInput({ modelFacingBindings: [selector, selector] }))).rejects.toThrow(/selectors must be unique/u);
    await expect(reflectGpuInterface(storageReflectionInput({ semantics: [] }))).rejects.toThrow(/has no semantic projection/u);
  });

  it.each([
    [{ semantic: "value", source: { kind: "record-member", recordName: "Absent", memberPath: ["value"] } }, /missing record/u],
    [{ semantic: "value", source: { kind: "record-member", recordName: "Data", memberPath: ["absent"] } }, /missing member/u],
    [{ semantic: "value", source: { kind: "record-member", recordName: "Data", memberPath: ["value", "nested"] } }, /traverses a non-record/u],
    [{ semantic: "value", source: { kind: "binding", moduleId: "module", group: 0, binding: 9 } }, /exactly one matching/u],
  ] as const)("rejects an invalid semantic selector %#", async (semantic, expected) => {
    await expect(reflectGpuInterface(storageReflectionInput({
      modelFacingBindings: [{ moduleId: "module", group: 0, binding: 0, semantic: null }],
      semantics: [semantic],
    }))).rejects.toThrow(expected);
  });

  it("rejects the same semantic with inconsistent vertex byte interpretations", async () => {
    const source = `
      struct VertexInput { @location(0) position: vec4f, }
      @vertex fn vertexMain(input: VertexInput) -> @builtin(position) vec4f { return input.position; }
    `;
    const render = (pipelineId: string, stride: number): SerializableGpuRenderPipelineDescriptor => ({
      kind: "render",
      pipelineId,
      layout: { bindGroups: [] },
      vertex: { moduleId: "vertex", entryPoint: "vertexMain", constants: {} },
      fragment: null,
      vertexBuffers: [{ arrayStride: stride, stepMode: "vertex", attributes: [{ format: "float32x4", offset: 0, shaderLocation: 0, semantic: "model.position" }] }],
      primitive: { topology: "triangle-list", stripIndexFormat: null, frontFace: "ccw", cullMode: "none", unclippedDepth: false },
      colorTargets: [],
      depthStencil: null,
      multisample: { count: 1, mask: 0xffff_ffff, alphaToCoverageEnabled: false },
    });
    await expect(reflectGpuInterface({
      interfaceId: "vertex.interface",
      interfaceVersion: "1",
      modules: [{ moduleId: "vertex", source }],
      pipelines: [render("first", 16), render("second", 32)],
      modelFacingRecordNames: [],
      modelFacingBindings: [],
      semantics: [],
    })).rejects.toThrow(/inconsistent model byte interpretations/u);
  });
});
