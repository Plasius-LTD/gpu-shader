import { describe, expect, it } from "vitest";

import { canonicalizeGpuContract, parseCanonicalJson } from "../src/canonical-json.js";
import { createGpuRecordCodec } from "../src/codec/codec.js";
import type {
  GpuBindingLayout,
  GpuRecordLayout,
  GpuRecordMemberLayout,
  GpuSemanticSource,
} from "../src/contracts.js";
import {
  asSha256Hex,
  computeGpuAbiHash,
  computeShaderManifestCoreSha256,
  computeSha256,
} from "../src/hash.js";
import {
  clone,
  reflectedInterface,
  runtimeArrayRecord,
  scalarRecord,
  shaderAssets,
} from "./fixtures.js";

describe("canonical JSON and domain-separated hashes", () => {
  it("orders UTF-16 object keys and normalizes negative zero", () => {
    const left = { z: -0, a: { y: 2, x: 1 }, list: [true, null, "x"] };
    const right = { list: [true, null, "x"], a: { x: 1, y: 2 }, z: 0 };
    expect(canonicalizeGpuContract(left)).toBe('{"a":{"x":1,"y":2},"list":[true,null,"x"],"z":0}');
    expect(canonicalizeGpuContract(right)).toBe(canonicalizeGpuContract(left));
    expect(parseCanonicalJson(canonicalizeGpuContract(left))).toEqual(right);
  });

  it.each([
    [undefined, "JSON cannot represent"],
    [1n, "JSON cannot represent"],
    [Number.NaN, "non-finite"],
    [Number.POSITIVE_INFINITY, "non-finite"],
    [new Date(), "plain JSON objects"],
  ])("rejects unsupported contract value %#", (value, message) => {
    expect(() => canonicalizeGpuContract(value)).toThrow(message);
  });

  it("rejects undefined members and actual cycles but permits shared subobjects", () => {
    expect(() => canonicalizeGpuContract({ value: undefined })).toThrow("undefined");
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => canonicalizeGpuContract(cycle)).toThrow("circular reference");
    const shared = { x: 1 };
    expect(canonicalizeGpuContract({ first: shared, second: shared })).toBe(
      '{"first":{"x":1},"second":{"x":1}}',
    );
  });

  it("computes the standard SHA-256 vector and enforces lowercase shape", async () => {
    expect(await computeSha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(asSha256Hex("a".repeat(64))).toBe("a".repeat(64));
    expect(() => asSha256Hex("A".repeat(64))).toThrow("lowercase");
    expect(() => asSha256Hex("a".repeat(63))).toThrow("64-character");
  });

  it("keeps interface/model/shader hash domains distinct and input-order independent", async () => {
    const manifest = await reflectedInterface();
    const reordered = {
      ...manifest,
      records: [...manifest.records].reverse(),
      bindings: [...manifest.bindings].reverse(),
      entryPoints: [...manifest.entryPoints].reverse(),
    };
    const model = await computeGpuAbiHash({ kind: "model", interface: manifest });
    const modelReordered = await computeGpuAbiHash({ kind: "model", interface: reordered });
    const full = await computeGpuAbiHash({ kind: "interface", interface: manifest });
    const shader = await computeGpuAbiHash({
      kind: "shader",
      interface: manifest,
      pipelines: [],
      requirements: { semantics: [], features: [], limits: [], formats: [] },
    });
    expect(modelReordered).toBe(model);
    expect(new Set([model, full, shader]).size).toBe(3);
  });

  it("model hashing includes transitive records but excludes shader coordinates", async () => {
    const manifest = await reflectedInterface();
    const changedNested = clone(manifest);
    const nested = changedNested.records.find((record) => record.name === "Nested")!;
    (nested.members[1]! as Mutable<GpuRecordMemberLayout>).offset = 8;
    expect(await computeGpuAbiHash({ kind: "model", interface: changedNested })).not.toBe(
      await computeGpuAbiHash({ kind: "model", interface: manifest }),
    );

    const shaderCoordinates = clone(manifest);
    const mutableBinding = shaderCoordinates.bindings[0]! as Mutable<GpuBindingLayout>;
    mutableBinding.moduleId = "renamed-module";
    mutableBinding.group = 3;
    mutableBinding.binding = 9;
    mutableBinding.visibility = ["vertex"];
    const bindingSemantic = shaderCoordinates.modelAbi.semantics.find(
      (semantic) => semantic.source.kind === "binding",
    )!;
    if (bindingSemantic.source.kind === "binding") {
      const mutableSource = bindingSemantic.source as Mutable<Extract<GpuSemanticSource, { kind: "binding" }>>;
      mutableSource.moduleId = "renamed-module";
      mutableSource.group = 3;
      mutableSource.binding = 9;
    }
    expect(await computeGpuAbiHash({ kind: "model", interface: shaderCoordinates })).toBe(
      await computeGpuAbiHash({ kind: "model", interface: manifest }),
    );
  });

  it("breaks the evidence digest cycle by hashing only the shader manifest core", async () => {
    const { shaderManifest } = await shaderAssets();
    const first = await computeShaderManifestCoreSha256(shaderManifest);
    const changedEvidence = {
      ...shaderManifest,
      validationEvidence: {
        ...shaderManifest.validationEvidence,
        sha256: "f".repeat(64) as typeof shaderManifest.validationEvidence.sha256,
      },
    };
    expect(await computeShaderManifestCoreSha256(changedEvidence)).toBe(first);
    const changedSupplementalEvidence = {
      ...changedEvidence,
      additionalValidationEvidence: [{ scope: "xr", evidence: changedEvidence.validationEvidence }],
    };
    expect(await computeShaderManifestCoreSha256(changedSupplementalEvidence)).toBe(first);
    const changedCore = {
      ...changedSupplementalEvidence,
      requirements: {
        ...changedEvidence.requirements,
        features: [...changedEvidence.requirements.features, "timestamp-query"],
      },
    };
    expect(await computeShaderManifestCoreSha256(changedCore)).not.toBe(first);
  });
});

describe("reflected GPU record codecs", () => {
  it("encodes little-endian scalar/vector values and zeroes every padding byte", () => {
    const record = scalarRecord();
    const codec = createGpuRecordCodec(record);
    const value = { position: [1, 2, 3], tag: 0x1122_3344, weight: 4 } as const;
    const destination = new Uint8Array(48).fill(0xff);
    expect(codec.encodeInto(value, destination.subarray(8, 40))).toBe(32);
    const bytes = destination.subarray(8, 40);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getFloat32(0, true)).toBe(1);
    expect(view.getFloat32(4, true)).toBe(2);
    expect(view.getFloat32(8, true)).toBe(3);
    expect(view.getUint32(12, true)).toBe(0x1122_3344);
    expect(view.getFloat32(16, true)).toBe(4);
    expect([...bytes.slice(20)]).toEqual(new Array(12).fill(0));
    expect(codec.decode(bytes)).toEqual(value);
    expect(destination.slice(0, 8)).toEqual(new Uint8Array(8).fill(0xff));
    expect(destination.slice(40)).toEqual(new Uint8Array(8).fill(0xff));
  });

  it("supports nested records, fixed arrays, matrices and atomics", () => {
    const nested: GpuRecordLayout = {
      name: "Nested",
      alignment: 8,
      byteSize: 8,
      minimumByteSize: 8,
      runtimeArrayMember: null,
      addressSpaces: ["storage"],
      members: [{
        name: "pair",
        offset: 0,
        alignment: 8,
        valueByteSize: 8,
        occupiedByteSize: 8,
        explicitAlign: null,
        explicitSize: null,
        type: { kind: "vector", scalar: "i32", width: 2, alignment: 8, byteSize: 8 },
      }],
    };
    const outer: GpuRecordLayout = {
      name: "Outer",
      alignment: 16,
      byteSize: 80,
      minimumByteSize: 80,
      runtimeArrayMember: null,
      addressSpaces: ["storage"],
      members: [
        {
          name: "matrix",
          offset: 0,
          alignment: 16,
          valueByteSize: 48,
          occupiedByteSize: 48,
          explicitAlign: null,
          explicitSize: null,
          type: { kind: "matrix", scalar: "f32", columns: 3, rows: 3, columnStride: 16, alignment: 16, byteSize: 48 },
        },
        {
          name: "nested",
          offset: 48,
          alignment: 8,
          valueByteSize: 16,
          occupiedByteSize: 16,
          explicitAlign: null,
          explicitSize: null,
          type: {
            kind: "array",
            element: { kind: "record", recordName: "Nested", alignment: 8, byteSize: 8 },
            count: 2,
            stride: 8,
            alignment: 8,
            byteSize: 16,
          },
        },
        {
          name: "counter",
          offset: 64,
          alignment: 4,
          valueByteSize: 4,
          occupiedByteSize: 4,
          explicitAlign: null,
          explicitSize: null,
          type: { kind: "atomic", scalar: "u32", alignment: 4, byteSize: 4 },
        },
      ],
    };
    const codec = createGpuRecordCodec(outer, [outer, nested]);
    const value = {
      matrix: [[1, 2, 3], [4, 5, 6], [7, 8, 9]],
      nested: [{ pair: [-1, 2] }, { pair: [3, -4] }],
      counter: 9,
    };
    expect(codec.decode(codec.encode(value))).toEqual(value);
    const view = new DataView(codec.encode(value));
    expect(view.getFloat32(12, true)).toBe(0);
    expect(view.getFloat32(28, true)).toBe(0);
    expect(view.getFloat32(44, true)).toBe(0);
  });

  it("derives runtime-array byte lengths from reflected stride and bounds decode", () => {
    const record = runtimeArrayRecord();
    const codec = createGpuRecordCodec(record);
    const value = { count: 2, values: [[1, 2, 3], [4, 5, 6]] };
    expect(codec.minimumByteLength).toBe(16);
    expect(codec.byteLength(value)).toBe(48);
    const encoded = codec.encode(value);
    expect(encoded.byteLength).toBe(48);
    expect(new Uint8Array(encoded).slice(4, 16)).toEqual(new Uint8Array(12));
    expect(new Uint8Array(encoded).slice(28, 32)).toEqual(new Uint8Array(4));
    expect(codec.decode(encoded)).toEqual(value);
    expect(() => codec.decode(encoded, { byteLength: 47 })).toThrow("stride-aligned");
  });

  it("rejects non-finite/f32-overflow/inexact integers and malformed record values", () => {
    const codec = createGpuRecordCodec(scalarRecord());
    const valid = { position: [1, 2, 3], tag: 1, weight: 1 };
    expect(() => codec.encode({ ...valid, weight: Number.NaN })).toThrow("finite number");
    expect(() => codec.encode({ ...valid, weight: Number.MAX_VALUE })).toThrow("finite f32 range");
    expect(() => codec.encode({ ...valid, tag: 1.5 })).toThrow("integer");
    expect(() => codec.encode({ ...valid, tag: -1 })).toThrow("integer");
    expect(() => codec.encode({ ...valid, position: [1, 2] })).toThrow("exactly 3");
    expect(() => codec.encode({ ...valid, surprise: 1 })).toThrow("not a reflected WGSL member");
    expect(() => codec.encode({ position: [1, 2, 3], tag: 1 })).toThrow("weight is required");
  });

  it("round-trips IEEE binary16 and rejects finite values outside its range", () => {
    const record: GpuRecordLayout = {
      name: "HalfRecord",
      alignment: 2,
      byteSize: 2,
      minimumByteSize: 2,
      runtimeArrayMember: null,
      addressSpaces: ["storage"],
      members: [{
        name: "value",
        offset: 0,
        alignment: 2,
        valueByteSize: 2,
        occupiedByteSize: 2,
        explicitAlign: null,
        explicitSize: null,
        type: { kind: "scalar", scalar: "f16", alignment: 2, byteSize: 2 },
      }],
    };
    const codec = createGpuRecordCodec(record);
    const encoded = codec.encode({ value: 1.5 });
    expect(new DataView(encoded).getUint16(0, true)).toBe(0x3e00);
    expect(codec.decode(encoded)).toEqual({ value: 1.5 });
    expect(codec.decode(codec.encode({ value: 65_504 }))).toEqual({ value: 65_504 });
    expect(() => codec.encode({ value: 65_520 })).toThrow(/finite f16 range|outside/u);
  });

  it("rejects unsafe buffer regions, SharedArrayBuffer, bool and stale runtime declarations", () => {
    const codec = createGpuRecordCodec(scalarRecord());
    const value = { position: [1, 2, 3], tag: 1, weight: 1 };
    expect(() => codec.encodeInto(value, new ArrayBuffer(31))).toThrow("needs 32 bytes");
    expect(() => codec.encodeInto(value, new ArrayBuffer(32), -1)).toThrow("byteOffset");
    expect(() => codec.decode(new ArrayBuffer(32), { byteOffset: 1, byteLength: 32 })).toThrow("exceeds");
    expect(() => codec.decode(new ArrayBuffer(31))).toThrow("at least 32");
    expect(() => codec.decode(new ArrayBuffer(33))).toThrow("exactly 32");
    if (typeof SharedArrayBuffer !== "undefined") {
      expect(() => codec.decode(new Uint8Array(new SharedArrayBuffer(32)))).toThrow("SharedArrayBuffer");
    }

    const base = scalarRecord();
    const boolRecord: GpuRecordLayout = {
      ...base,
      members: base.members.map((member, index) => index === 1 ? {
        ...member,
        type: { kind: "scalar", scalar: "bool", alignment: 4, byteSize: 4 },
      } : member),
    };
    expect(() => createGpuRecordCodec(boolRecord).encode(value)).toThrow("not host-shareable");

    const stale = { ...runtimeArrayRecord(), runtimeArrayMember: "count" };
    expect(() => createGpuRecordCodec(stale)).toThrow("invalid runtimeArrayMember");
  });
});

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
