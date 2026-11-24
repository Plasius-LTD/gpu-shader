import { describe, expect, it } from "vitest";
import { createGpuRecordCodec } from "../src/codec/codec.js";
import { parseGpuInterfaceManifest, parseSerializableGpuPipelineDescriptors } from "../src/manifest-validation.js";
import { reflectGpuInterface } from "../src/node/reflect.js";
import { generateGpuInterfaceArtifacts } from "../src/node/generate-artifacts.js";
import { clone, computePipeline, reflectedInterface } from "./fixtures.js";
import { wgslIdentifier } from "../src/wgsl-identifier.js";

async function paddedInterface() {
  return reflectGpuInterface({
    interfaceId: "padding.interface", interfaceVersion: "1.0.0",
    modules: [{ moduleId: "padding", source: `
      struct _Portal { direction: vec3f, _pad0: u32, pad0: u32, }
      struct _Portals { _items: array<_Portal>, }
      @group(0) @binding(0) var<storage, read_write> _portals: _Portals;
      override _GROUP: u32 = 1u;
      @compute @workgroup_size(_GROUP)
      fn _main(@builtin(global_invocation_id) _id: vec3u) {
        _portals._items[_id.x]._pad0 = 1u;
      }
    ` }],
    pipelines: [{
      kind: "compute", pipelineId: "padding.compute",
      layout: { bindGroups: [{ group: 0, entries: [{ group: 0, binding: 0,
        resource: { kind: "buffer", addressSpace: "storage", access: "read_write",
          recordName: "_Portals", minimumBindingSize: 32 }, visibility: ["compute"] }] }] },
      compute: { moduleId: "padding", entryPoint: "_main", constants: { _GROUP: 1 } },
    }],
    modelFacingRecordNames: ["_Portal", "_Portals"], modelFacingBindings: [],
    semantics: [{ semantic: "portal.padding", source: {
      kind: "record-member", recordName: "_Portal", memberPath: ["_pad0"],
    } }],
  });
}

describe("source identifiers are not contract tokens", () => {
  it.each(["a", "_0", "_pad0", "a__b", "Pad0", "constructor", "prototype", "a".repeat(160)])(
    "preserves supported source name %s", (name) => {
      expect(wgslIdentifier(name, "source")).toBe(name);
    },
  );

  it.each([null, undefined, 7, {}, "", "a".repeat(161), "a\n", "é", "e\u0301", "\ud800"])(
    "rejects out-of-profile or unbounded names %# without normalization", (name) => {
      expect(() => wgslIdentifier(name, "source")).toThrow(/identifier/u);
    },
  );

  it("reflects padding, nested records, runtime tails, variables, entry points, IO and overrides", async () => {
    const manifest = await paddedInterface();
    expect(parseGpuInterfaceManifest(manifest)).toEqual(manifest);
    const portal = manifest.records.find((record) => record.name === "_Portal")!;
    expect(portal.members.map(({ name, offset }) => ({ name, offset }))).toEqual([
      { name: "direction", offset: 0 }, { name: "_pad0", offset: 12 }, { name: "pad0", offset: 16 },
    ]);
    expect(manifest.records.find((record) => record.name === "_Portals")!.runtimeArrayMember).toBe("_items");
    expect(manifest.bindings[0]!.variableName).toBe("_portals");
    expect(manifest.entryPoints[0]).toMatchObject({ name: "_main", overrideNames: ["_GROUP"] });
    const codec = createGpuRecordCodec(portal, manifest.records);
    const value = { direction: [1, 2, 3], _pad0: 42, pad0: 7 };
    const bytes = codec.encode(value);
    expect(bytes.byteLength).toBe(32);
    expect(codec.decode(bytes)).toEqual(value);
    const artifacts = generateGpuInterfaceArtifacts(manifest);
    expect(artifacts.typescriptTypes).toContain("interface _PortalGpuRecord");
    expect(artifacts.typescriptTypes).toContain('readonly "_pad0": number');
    expect(artifacts.byteConstants).toContain("PORTAL_PAD0_OFFSET = 12");
    expect(artifacts.byteConstants).toContain("PORTAL_PAD0_X70616430_OFFSET = 16");
    expect(JSON.parse(artifacts.jsonSchemas).$defs._Portal.required).toEqual(["direction", "_pad0", "pad0"]);
    expect(parseGpuInterfaceManifest(JSON.parse(artifacts.manifestJson))).toEqual(manifest);
  });

  it.each(["_", "__pad0", "__proto__", "9pad", "pad/x", "pad.x", "pad:x", "pad-x", "fn", "NULL", "class"])(
    "rejects invalid or reserved WGSL member %s", async (name) => {
      const manifest = clone(await reflectedInterface());
      Object.assign(manifest.records[0]!.members[0]!, { name });
      expect(() => parseGpuInterfaceManifest(manifest)).toThrow(/identifier/u);
    },
  );

  it("does not relax non-WGSL interface and semantic tokens", async () => {
    const manifest = clone(await reflectedInterface());
    Object.assign(manifest, { interfaceId: "_contract" });
    expect(() => parseGpuInterfaceManifest(manifest)).toThrow(/safe token/u);
    Object.assign(manifest, { interfaceId: "legal.contract" });
    Object.assign(manifest.modelAbi.semantics[0]!, { semantic: "_semantic" });
    expect(() => parseGpuInterfaceManifest(manifest)).toThrow(/safe token/u);
  });

  it("accepts source-name and numeric-ID override keys, but not malformed names", () => {
    for (const key of ["_GROUP", "7"]) {
      const pipeline = computePipeline({ [key]: 1 });
      Object.assign(pipeline.compute, { entryPoint: "_main" });
      expect(parseSerializableGpuPipelineDescriptors([pipeline], ["compute"])).toEqual([pipeline]);
    }
    for (const key of ["__GROUP", "7group", "a/b", "for"]) {
      expect(() => parseSerializableGpuPipelineDescriptors([computePipeline({ [key]: 1 })], ["compute"])).toThrow(/identifier/u);
    }
  });

  it("keeps source data named constructor or prototype as own fields without prototype mutation", async () => {
    const manifest = await paddedInterface();
    const record = clone(manifest.records.find((record) => record.name === "_Portal")!);
    Object.assign(record.members[1]!, { name: "constructor" });
    Object.assign(record.members[2]!, { name: "prototype" });
    const codec = createGpuRecordCodec(record);
    const value = { direction: [1, 2, 3], constructor: 4, prototype: 5 };
    const decoded = codec.decode(codec.encode(value));
    expect(decoded).toEqual(value);
    expect(Object.hasOwn(decoded, "constructor")).toBe(true);
    expect(Object.hasOwn(decoded, "prototype")).toBe(true);
    expect(Object.prototype).not.toHaveProperty("_pad0");
  });
});
