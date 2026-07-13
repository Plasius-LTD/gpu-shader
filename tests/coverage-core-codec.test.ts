import { describe, expect, it } from "vitest";

import type { GpuRecordLayout } from "../src/contracts.js";
import {
  createGpuRecordCodec,
  decodeFloat16Bits,
  encodeFloat16Bits,
} from "../src/codec/codec.js";
import { runtimeArrayRecord, scalarRecord } from "./fixtures.js";

function singleMemberRecord(
  name: string,
  member: GpuRecordLayout["members"][number],
): GpuRecordLayout {
  return {
    name,
    alignment: member.alignment,
    byteSize: member.occupiedByteSize,
    minimumByteSize: member.occupiedByteSize ?? 0,
    runtimeArrayMember: null,
    addressSpaces: ["storage"],
    members: [member],
  };
}

describe("GPU record codec numeric boundaries", () => {
  it.each([
    [2 ** -26, 0x0000],
    [2 ** -25, 0x0000],
    [3 * 2 ** -25, 0x0002],
    [3 * 2 ** -26, 0x0001],
    [1.999_511_718_75, 0x4000],
    [-0, 0x8000],
  ])("rounds %d to the expected finite binary16 bits", (value, bits) => {
    expect(encodeFloat16Bits(value, "value")).toBe(bits);
  });

  it("decodes negative/subnormal binary16 and rejects infinities and NaNs", () => {
    expect(decodeFloat16Bits(0x8001, "value")).toBe(-(2 ** -24));
    expect(decodeFloat16Bits(0xbc00, "value")).toBe(-1);
    expect(() => decodeFloat16Bits(0x7c00, "value")).toThrow("non-finite f16");
    expect(() => decodeFloat16Bits(0x7e00, "value")).toThrow("non-finite f16");
  });

  it("uses two-byte scalar strides for f16 vectors and matrices", () => {
    const vector = singleMemberRecord("HalfVector", {
      name: "value",
      offset: 0,
      alignment: 8,
      valueByteSize: 8,
      occupiedByteSize: 8,
      explicitAlign: null,
      explicitSize: null,
      type: { kind: "vector", scalar: "f16", width: 4, alignment: 8, byteSize: 8 },
    });
    const matrix = singleMemberRecord("HalfMatrix", {
      name: "value",
      offset: 0,
      alignment: 4,
      valueByteSize: 8,
      occupiedByteSize: 8,
      explicitAlign: null,
      explicitSize: null,
      type: {
        kind: "matrix",
        scalar: "f16",
        columns: 2,
        rows: 2,
        columnStride: 4,
        alignment: 4,
        byteSize: 8,
      },
    });

    expect(createGpuRecordCodec(vector).decode(
      createGpuRecordCodec(vector).encode({ value: [1, 2, 3, 4] }),
    )).toEqual({ value: [1, 2, 3, 4] });
    expect(createGpuRecordCodec(matrix).decode(
      createGpuRecordCodec(matrix).encode({ value: [[1, 2], [3, 4]] }),
    )).toEqual({ value: [[1, 2], [3, 4]] });
  });
});

describe("GPU record codec fail-closed structural boundaries", () => {
  it.each([
    [null],
    [[]],
    ["record"],
  ])("rejects a non-record root value %#", (value) => {
    expect(() => createGpuRecordCodec(scalarRecord()).encode(value as never)).toThrow(
      "must be an object",
    );
  });

  it("rejects a non-array vector and a non-trailing runtime array", () => {
    expect(() => createGpuRecordCodec(scalarRecord()).encode({
      position: 1,
      tag: 0,
      weight: 1,
    } as never)).toThrow("must be an array");

    const record = runtimeArrayRecord();
    const nonTrailing = {
      ...record,
      members: [...record.members].reverse(),
    } satisfies GpuRecordLayout;
    expect(() => createGpuRecordCodec(nonTrailing)).toThrow("must be the trailing member");
  });

  it("rejects unavailable nested records during both encode and decode", () => {
    const record = singleMemberRecord("Outer", {
      name: "nested",
      offset: 0,
      alignment: 4,
      valueByteSize: 4,
      occupiedByteSize: 4,
      explicitAlign: null,
      explicitSize: null,
      type: { kind: "record", recordName: "Missing", alignment: 4, byteSize: 4 },
    });
    const codec = createGpuRecordCodec(record);

    expect(() => codec.encode({ nested: { value: 1 } })).toThrow(
      "Reflected record Missing is unavailable",
    );
    expect(() => codec.decode(new ArrayBuffer(4))).toThrow(
      "Reflected record Missing is unavailable",
    );
  });

  it("adds the root record when the supplied record registry omits it", () => {
    const record = scalarRecord();
    const codec = createGpuRecordCodec(record, []);
    const value = { position: [1, 2, 3], tag: 4, weight: 5 };

    expect(codec.decode(codec.encode(value))).toEqual(value);
  });

  it("rejects a fixed record with no byte size and an unbounded nested runtime array", () => {
    const fixedWithoutSize = {
      ...scalarRecord(),
      byteSize: null,
    } satisfies GpuRecordLayout;
    expect(() => createGpuRecordCodec(fixedWithoutSize).byteLength({
      position: [1, 2, 3],
      tag: 4,
      weight: 5,
    })).toThrow("missing a fixed byte size");

    const nestedRuntimeArray = singleMemberRecord("NestedRuntime", {
      name: "values",
      offset: 0,
      alignment: 4,
      valueByteSize: null,
      occupiedByteSize: null,
      explicitAlign: null,
      explicitSize: null,
      type: {
        kind: "array",
        element: { kind: "scalar", scalar: "u32", alignment: 4, byteSize: 4 },
        count: null,
        stride: 4,
        alignment: 4,
        byteSize: null,
      },
    });
    expect(() => createGpuRecordCodec({ ...nestedRuntimeArray, byteSize: 0 }).decode(new ArrayBuffer(0))).toThrow(
      "requires a bounded runtime-array length",
    );
  });

  it("bounds runtime array byte lengths before allocating a GPU buffer", () => {
    const codec = createGpuRecordCodec(runtimeArrayRecord());
    const values: unknown[] = [];
    values.length = 0x1000_0000;

    expect(() => codec.byteLength({ count: 0, values })).toThrow(
      "exceeds the bounded GPU buffer size",
    );
  });

  it("honours typed-array regions and rejects unsafe decode options", () => {
    const codec = createGpuRecordCodec(scalarRecord());
    const destination = new Uint8Array(new ArrayBuffer(64), 8, 48);
    const value = { position: [1, 2, 3], tag: 4, weight: 5 };
    expect(codec.encodeInto(value, destination, 8)).toBe(32);
    expect(codec.decode(destination, { byteOffset: 8, byteLength: 32 })).toEqual(value);

    expect(() => codec.decode(destination, { byteOffset: Number.NaN })).toThrow(
      "byteOffset must be a non-negative safe integer",
    );
    expect(() => codec.decode(destination, { byteLength: Number.NaN })).toThrow(
      "Source must provide at least",
    );
  });

  it("rejects bool during decode as well as encode", () => {
    const record = singleMemberRecord("BoolRecord", {
      name: "value",
      offset: 0,
      alignment: 4,
      valueByteSize: 4,
      occupiedByteSize: 4,
      explicitAlign: null,
      explicitSize: null,
      type: { kind: "scalar", scalar: "bool", alignment: 4, byteSize: 4 },
    });
    expect(() => createGpuRecordCodec(record).decode(new ArrayBuffer(4))).toThrow(
      "bool, which is not host-shareable",
    );
  });
});
