import { describe, expect, it } from "vitest";
import {
  decodeGpuVertexFormat,
  encodeGpuVertexFormat,
  gpuVertexFormatByteSize,
} from "../src/codec/vertex-format.js";
import type { JsonValue } from "../src/contracts.js";

const cases: readonly [string, JsonValue, number][] = [
  ["uint8x2", [0, 255], 2],
  ["uint8x4", [0, 1, 254, 255], 4],
  ["sint8x2", [-128, 127], 2],
  ["sint8x4", [-128, -1, 0, 127], 4],
  ["unorm8x2", [0, 1], 2],
  ["unorm8x4", [0, 0.25, 0.5, 1], 4],
  ["unorm8x4-bgra", [0, 0.25, 0.5, 1], 4],
  ["snorm8x2", [-1, 1], 2],
  ["snorm8x4", [-1, -0.5, 0.5, 1], 4],
  ["uint16x2", [0, 65_535], 4],
  ["uint16x4", [0, 1, 65_534, 65_535], 8],
  ["sint16x2", [-32_768, 32_767], 4],
  ["sint16x4", [-32_768, -1, 0, 32_767], 8],
  ["unorm16x2", [0, 1], 4],
  ["unorm16x4", [0, 0.25, 0.5, 1], 8],
  ["snorm16x2", [-1, 1], 4],
  ["snorm16x4", [-1, -0.5, 0.5, 1], 8],
  ["float16x2", [-1.5, 2.25], 4],
  ["float16x4", [-1.5, 0, 2.25, 65_504], 8],
  ["float32", 1.25, 4],
  ["float32x2", [-1.25, 2.5], 8],
  ["float32x3", [-1.25, 0, 2.5], 12],
  ["float32x4", [-1.25, 0, 2.5, 4], 16],
  ["uint32", 4_294_967_295, 4],
  ["uint32x2", [0, 4_294_967_295], 8],
  ["uint32x3", [0, 1, 4_294_967_295], 12],
  ["uint32x4", [0, 1, 2, 4_294_967_295], 16],
  ["sint32", -2_147_483_648, 4],
  ["sint32x2", [-2_147_483_648, 2_147_483_647], 8],
  ["sint32x3", [-2_147_483_648, 0, 2_147_483_647], 12],
  ["sint32x4", [-2_147_483_648, -1, 0, 2_147_483_647], 16],
  ["unorm10-10-10-2", [0, 0.25, 0.5, 1], 4],
];

describe("stable GPUVertexFormat codec", () => {
  it.each(cases)("roundtrips exact bytes for %s", (format, value, size) => {
    const bytes = encodeGpuVertexFormat(format, value);
    expect(bytes).toHaveLength(size);
    expect(gpuVertexFormatByteSize(format)).toBe(size);
    expect(encodeGpuVertexFormat(format, decodeGpuVertexFormat(format, bytes))).toEqual(bytes);
  });

  it("uses little-endian storage and BGRA component order", () => {
    expect([...encodeGpuVertexFormat("uint16x2", [0x1234, 0xabcd])]).toEqual([
      0x34, 0x12, 0xcd, 0xab,
    ]);
    expect([...encodeGpuVertexFormat("unorm8x4-bgra", [0, 0.25, 0.5, 1])]).toEqual([
      128, 64, 0, 255,
    ]);
  });

  it.each([
    ["float16", 1],
    ["uint8", 1],
    ["sint16x3", [1, 2, 3]],
    ["depth24plus", 1],
    ["float64", 1],
  ] as const)("rejects unsupported format %s", (format, value) => {
    expect(() => encodeGpuVertexFormat(format, value as JsonValue)).toThrow(
      /Unsupported stable GPUVertexFormat/u,
    );
  });

  it.each([
    ["uint8x2", [0, 256]],
    ["uint8x2", [0.5, 1]],
    ["sint8x2", [-129, 0]],
    ["unorm8x2", [-0.1, 1]],
    ["unorm16x2", [0, 1.1]],
    ["snorm8x2", [-1.1, 0]],
    ["snorm16x2", [0, 1.1]],
    ["float32", Number.MAX_VALUE],
    ["float32x2", [0]],
    ["float32x2", [0, Number.NaN]],
    ["uint32", [1]],
  ] as const)("rejects an invalid %s value", (format, value) => {
    expect(() => encodeGpuVertexFormat(format, value as JsonValue)).toThrow();
  });

  it("rejects a byte range with the wrong exact size", () => {
    expect(() => decodeGpuVertexFormat("float32x4", new Uint8Array(12))).toThrow(
      /requires 16 bytes/u,
    );
  });
});
