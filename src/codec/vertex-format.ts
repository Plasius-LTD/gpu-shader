import type { JsonValue } from "../contracts.js";
import { decodeFloat16Bits, encodeFloat16Bits } from "./codec.js";

interface VertexFormatInfo {
  readonly kind: "uint" | "sint" | "unorm" | "snorm" | "float";
  readonly bits: 8 | 16 | 32;
  readonly components: 1 | 2 | 3 | 4;
  readonly bgra?: boolean;
  readonly packed1010102?: boolean;
}

function info(format: string): VertexFormatInfo {
  if (format === "unorm10-10-10-2") return { kind: "unorm", bits: 32, components: 4, packed1010102: true };
  if (format === "unorm8x4-bgra") return { kind: "unorm", bits: 8, components: 4, bgra: true };
  const match = /^(uint|sint|unorm|snorm|float)(8|16|32)(?:x(2|3|4))?$/u.exec(format);
  if (!match) throw new TypeError(`Unsupported stable GPUVertexFormat ${format}.`);
  const kind = match[1] as VertexFormatInfo["kind"];
  const bits = Number(match[2]) as VertexFormatInfo["bits"];
  const components = Number(match[3] ?? 1) as VertexFormatInfo["components"];
  const valid = kind === "float"
    ? (bits === 16 ? components === 2 || components === 4 : bits === 32)
    : bits === 32 ? (kind === "uint" || kind === "sint")
      : components === 2 || components === 4;
  if (!valid) throw new TypeError(`Unsupported stable GPUVertexFormat ${format}.`);
  return { kind, bits, components };
}

function numbers(value: JsonValue, components: number, path: string): number[] {
  const values = components === 1 ? [value] : value;
  if (!Array.isArray(values) || values.length !== components || values.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new TypeError(`${path} must contain ${components} finite numeric component${components === 1 ? "" : "s"}.`);
  }
  return values as number[];
}

function integer(value: number, minimum: number, maximum: number, path: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new TypeError(`${path} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}

function roundTiesToEven(value: number): number {
  const lower = Math.floor(value); const fraction = value - lower;
  return fraction < 0.5 ? lower : fraction > 0.5 ? lower + 1 : lower % 2 === 0 ? lower : lower + 1;
}

function quantize(value: number, kind: "unorm" | "snorm", bits: number, path: string): number {
  if (kind === "unorm") {
    if (value < 0 || value > 1) throw new TypeError(`${path} must be between 0 and 1.`);
    return roundTiesToEven(value * (2 ** bits - 1));
  }
  if (value < -1 || value > 1) throw new TypeError(`${path} must be between -1 and 1.`);
  return value === -1 ? -(2 ** (bits - 1) - 1) : roundTiesToEven(value * (2 ** (bits - 1) - 1));
}

export function gpuVertexFormatByteSize(format: string): number {
  const formatInfo = info(format);
  return formatInfo.packed1010102 ? 4 : formatInfo.bits / 8 * formatInfo.components;
}

/** Encodes the shader-observed value into the exact little-endian vertex byte format. */
export function encodeGpuVertexFormat(format: string, value: JsonValue): Uint8Array {
  const formatInfo = info(format); const values = numbers(value, formatInfo.components, `vertex ${format}`);
  if (formatInfo.packed1010102) {
    const packed = quantize(values[0]!, "unorm", 10, "vertex[0]")
      | quantize(values[1]!, "unorm", 10, "vertex[1]") << 10
      | quantize(values[2]!, "unorm", 10, "vertex[2]") << 20
      | quantize(values[3]!, "unorm", 2, "vertex[3]") << 30;
    const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, packed >>> 0, true); return bytes;
  }
  const bytes = new Uint8Array(gpuVertexFormatByteSize(format)); const view = new DataView(bytes.buffer); const order = formatInfo.bgra ? [2, 1, 0, 3] : [...values.keys()];
  for (const [storageIndex, valueIndex] of order.entries()) {
    const component = values[valueIndex]!; const offset = storageIndex * formatInfo.bits / 8; const path = `vertex[${valueIndex}]`;
    if (formatInfo.kind === "float") {
      if (formatInfo.bits === 16) view.setUint16(offset, encodeFloat16Bits(component, path), true);
      else { const rounded = Math.fround(component); if (!Number.isFinite(rounded)) throw new TypeError(`${path} is outside finite f32 range.`); view.setFloat32(offset, rounded, true); }
    } else if (formatInfo.kind === "uint") {
      const maximum = formatInfo.bits === 32 ? 0xffff_ffff : 2 ** formatInfo.bits - 1; const encoded = integer(component, 0, maximum, path);
      if (formatInfo.bits === 8) view.setUint8(offset, encoded); else if (formatInfo.bits === 16) view.setUint16(offset, encoded, true); else view.setUint32(offset, encoded, true);
    } else if (formatInfo.kind === "sint") {
      const minimum = -(2 ** (formatInfo.bits - 1)); const maximum = 2 ** (formatInfo.bits - 1) - 1; const encoded = integer(component, minimum, maximum, path);
      if (formatInfo.bits === 8) view.setInt8(offset, encoded); else if (formatInfo.bits === 16) view.setInt16(offset, encoded, true); else view.setInt32(offset, encoded, true);
    } else {
      const encoded = quantize(component, formatInfo.kind, formatInfo.bits, path);
      if (formatInfo.kind === "unorm") { if (formatInfo.bits === 8) view.setUint8(offset, encoded); else view.setUint16(offset, encoded, true); }
      else { if (formatInfo.bits === 8) view.setInt8(offset, encoded); else view.setInt16(offset, encoded, true); }
    }
  }
  return bytes;
}

/** Decodes exact vertex bytes to the value observed by WGSL vertex inputs. */
export function decodeGpuVertexFormat(format: string, bytes: Uint8Array): JsonValue {
  const formatInfo = info(format); if (bytes.byteLength !== gpuVertexFormatByteSize(format)) throw new TypeError(`Vertex ${format} requires ${gpuVertexFormatByteSize(format)} bytes.`); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let values: number[];
  if (formatInfo.packed1010102) {
    const packed = view.getUint32(0, true); values = [packed & 0x3ff, packed >>> 10 & 0x3ff, packed >>> 20 & 0x3ff, packed >>> 30].map((item, index) => item / (index === 3 ? 3 : 1023));
  } else {
    const storage = Array.from({ length: formatInfo.components }, (_, index) => {
      const offset = index * formatInfo.bits / 8;
      if (formatInfo.kind === "float") return formatInfo.bits === 16 ? decodeFloat16Bits(view.getUint16(offset, true), `vertex[${index}]`) : view.getFloat32(offset, true);
      if (formatInfo.kind === "uint") return formatInfo.bits === 8 ? view.getUint8(offset) : formatInfo.bits === 16 ? view.getUint16(offset, true) : view.getUint32(offset, true);
      if (formatInfo.kind === "sint") return formatInfo.bits === 8 ? view.getInt8(offset) : formatInfo.bits === 16 ? view.getInt16(offset, true) : view.getInt32(offset, true);
      const raw = formatInfo.kind === "unorm" ? (formatInfo.bits === 8 ? view.getUint8(offset) : view.getUint16(offset, true)) : (formatInfo.bits === 8 ? view.getInt8(offset) : view.getInt16(offset, true));
      if (formatInfo.kind === "unorm") return raw / (2 ** formatInfo.bits - 1);
      return Math.max(raw / (2 ** (formatInfo.bits - 1) - 1), -1);
    });
    values = formatInfo.bgra ? [storage[2]!, storage[1]!, storage[0]!, storage[3]!] : storage;
  }
  return formatInfo.components === 1 ? values[0]! : values;
}
