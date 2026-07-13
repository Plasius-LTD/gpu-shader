import type {
  GpuArrayLayout,
  GpuRecordCodec,
  GpuRecordLayout,
  GpuRecordValue,
  GpuScalarKind,
  GpuTypeLayout,
} from "../contracts.js";

interface BufferRegion {
  readonly buffer: ArrayBuffer;
  readonly byteOffset: number;
  readonly byteLength: number;
}

function bufferRegion(value: ArrayBuffer | ArrayBufferView): BufferRegion {
  if (value instanceof ArrayBuffer) {
    return { buffer: value, byteOffset: 0, byteLength: value.byteLength };
  }
  if (!(value.buffer instanceof ArrayBuffer)) {
    throw new TypeError("SharedArrayBuffer-backed views are not supported by the codec.");
  }
  return { buffer: value.buffer, byteOffset: value.byteOffset, byteLength: value.byteLength };
}

function integer(value: unknown, minimum: number, maximum: number, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${path} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function numeric(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be a finite number.`);
  }
  return value;
}

function scalarByteSize(scalar: GpuScalarKind): number {
  if (scalar === "f16") return 2;
  return 4;
}

function roundTiesToEven(value: number): number {
  const lower = Math.floor(value);
  const fraction = value - lower;
  if (fraction < 0.5) return lower;
  if (fraction > 0.5) return lower + 1;
  return lower % 2 === 0 ? lower : lower + 1;
}

/** Converts a finite JavaScript number to IEEE 754 binary16 using round-to-nearest, ties-to-even. */
export function encodeFloat16Bits(value: unknown, path: string): number {
  const input = numeric(value, path);
  const negative = input < 0 || Object.is(input, -0);
  const magnitude = Math.abs(input);
  if (magnitude > 65_504) throw new TypeError(`${path} is outside the finite f16 range.`);
  const sign = negative ? 0x8000 : 0;
  if (magnitude === 0) return sign;

  if (magnitude < 2 ** -14) {
    const significand = roundTiesToEven(magnitude / 2 ** -24);
    return sign | significand;
  }

  let exponent = Math.floor(Math.log2(magnitude));
  let significand = roundTiesToEven(magnitude / 2 ** (exponent - 10));
  if (significand === 2048) {
    exponent += 1;
    significand = 1024;
  }
  if (exponent > 15) throw new TypeError(`${path} is outside the finite f16 range.`);
  return sign | ((exponent + 15) << 10) | (significand - 1024);
}

export function decodeFloat16Bits(bits: number, path: string): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >>> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0x1f) throw new TypeError(`${path} contains a non-finite f16 value.`);
  if (exponent === 0) return sign * fraction * 2 ** -24;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

function writeScalar(view: DataView, offset: number, scalar: GpuScalarKind, value: unknown, path: string): void {
  switch (scalar) {
    case "u32":
      view.setUint32(offset, integer(value, 0, 0xffff_ffff, path), true);
      return;
    case "i32":
      view.setInt32(offset, integer(value, -0x8000_0000, 0x7fff_ffff, path), true);
      return;
    case "f32":
      {
        const rounded = Math.fround(numeric(value, path));
        if (!Number.isFinite(rounded)) throw new TypeError(`${path} is outside the finite f32 range.`);
        view.setFloat32(offset, rounded, true);
      }
      return;
    case "f16":
      view.setUint16(offset, encodeFloat16Bits(value, path), true);
      return;
    case "bool":
      throw new TypeError(`${path} uses bool, which is not host-shareable.`);
  }
}

function readScalar(view: DataView, offset: number, scalar: GpuScalarKind, path: string): number {
  switch (scalar) {
    case "u32":
      return view.getUint32(offset, true);
    case "i32":
      return view.getInt32(offset, true);
    case "f32":
      return view.getFloat32(offset, true);
    case "f16":
      return decodeFloat16Bits(view.getUint16(offset, true), path);
    case "bool":
      throw new TypeError(`${path} uses bool, which is not host-shareable.`);
  }
}

function arrayValue(value: unknown, expected: number | null, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be an array.`);
  }
  if (expected !== null && value.length !== expected) {
    throw new RangeError(`${path} must contain exactly ${expected} values.`);
  }
  return value;
}

function assertRecordValue(
  value: unknown,
  record: GpuRecordLayout,
  path: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  const expected = new Set(record.members.map((member) => member.name));
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new TypeError(`${path}.${key} is not a reflected WGSL member.`);
  }
  for (const member of record.members) {
    if (!Object.prototype.hasOwnProperty.call(value, member.name)) {
      throw new TypeError(`${path}.${member.name} is required.`);
    }
  }
}

function runtimeMember(record: GpuRecordLayout): { name: string; offset: number; type: GpuArrayLayout } | null {
  if (record.runtimeArrayMember === null) return null;
  const member = record.members.find((candidate) => candidate.name === record.runtimeArrayMember);
  if (!member || member.type.kind !== "array" || member.type.count !== null) {
    throw new TypeError(`${record.name} has an invalid runtimeArrayMember declaration.`);
  }
  if (record.members.at(-1) !== member) {
    throw new TypeError(`${record.name}.${member.name} must be the trailing member.`);
  }
  return { name: member.name, offset: member.offset, type: member.type };
}

/** Creates a strict, little-endian codec directly from reflected record layouts. */
export function createGpuRecordCodec<T = GpuRecordValue>(
  record: GpuRecordLayout,
  records: readonly GpuRecordLayout[] = [record],
): GpuRecordCodec<T> {
  const byName = new Map(records.map((candidate) => [candidate.name, candidate]));
  if (!byName.has(record.name)) byName.set(record.name, record);
  const runtime = runtimeMember(record);

  const resolveRecord = (name: string): GpuRecordLayout => {
    const resolved = byName.get(name);
    if (!resolved) throw new TypeError(`Reflected record ${name} is unavailable to the codec.`);
    return resolved;
  };

  const writeType = (
    view: DataView,
    offset: number,
    type: GpuTypeLayout,
    value: unknown,
    path: string,
  ): void => {
    switch (type.kind) {
      case "scalar":
        writeScalar(view, offset, type.scalar, value, path);
        return;
      case "atomic":
        writeScalar(view, offset, type.scalar, value, path);
        return;
      case "vector": {
        const values = arrayValue(value, type.width, path);
        const width = scalarByteSize(type.scalar);
        values.forEach((item, index) => writeScalar(view, offset + index * width, type.scalar, item, `${path}[${index}]`));
        return;
      }
      case "matrix": {
        const columns = arrayValue(value, type.columns, path);
        columns.forEach((column, columnIndex) => {
          const values = arrayValue(column, type.rows, `${path}[${columnIndex}]`);
          values.forEach((item, rowIndex) =>
            writeScalar(
              view,
              offset + columnIndex * type.columnStride + rowIndex * scalarByteSize(type.scalar),
              type.scalar,
              item,
              `${path}[${columnIndex}][${rowIndex}]`,
            ),
          );
        });
        return;
      }
      case "array": {
        const values = arrayValue(value, type.count, path);
        values.forEach((item, index) =>
          writeType(view, offset + index * type.stride, type.element, item, `${path}[${index}]`),
        );
        return;
      }
      case "record":
        writeRecord(view, offset, resolveRecord(type.recordName), value, path);
    }
  };

  const writeRecord = (
    view: DataView,
    offset: number,
    target: GpuRecordLayout,
    value: unknown,
    path: string,
  ): void => {
    assertRecordValue(value, target, path);
    for (const member of target.members) {
      writeType(view, offset + member.offset, member.type, value[member.name], `${path}.${member.name}`);
    }
  };

  const readType = (
    view: DataView,
    offset: number,
    type: GpuTypeLayout,
    path: string,
    runtimeCount?: number,
  ): unknown => {
    switch (type.kind) {
      case "scalar":
        return readScalar(view, offset, type.scalar, path);
      case "atomic":
        return readScalar(view, offset, type.scalar, path);
      case "vector":
        return Array.from({ length: type.width }, (_, index) =>
          readScalar(view, offset + index * scalarByteSize(type.scalar), type.scalar, `${path}[${index}]`),
        );
      case "matrix":
        return Array.from({ length: type.columns }, (_, column) =>
          Array.from({ length: type.rows }, (_, row) =>
            readScalar(
              view,
              offset + column * type.columnStride + row * scalarByteSize(type.scalar),
              type.scalar,
              `${path}[${column}][${row}]`,
            ),
          ),
        );
      case "array": {
        const count = type.count ?? runtimeCount;
        if (count === undefined) throw new TypeError(`${path} requires a bounded runtime-array length.`);
        return Array.from({ length: count }, (_, index) =>
          readType(view, offset + index * type.stride, type.element, `${path}[${index}]`),
        );
      }
      case "record":
        return readRecord(view, offset, resolveRecord(type.recordName), path);
    }
  };

  const readRecord = (
    view: DataView,
    offset: number,
    target: GpuRecordLayout,
    path: string,
    rootRuntimeCount?: number,
  ): GpuRecordValue => {
    const result: Record<string, unknown> = {};
    for (const member of target.members) {
      const count = member.name === target.runtimeArrayMember ? rootRuntimeCount : undefined;
      result[member.name] = readType(view, offset + member.offset, member.type, `${path}.${member.name}`, count);
    }
    return result;
  };

  const byteLength = (value: T): number => {
    assertRecordValue(value, record, record.name);
    if (!runtime) {
      if (record.byteSize === null) throw new TypeError(`${record.name} is missing a fixed byte size.`);
      return record.byteSize;
    }
    const values = arrayValue(value[runtime.name], null, `${record.name}.${runtime.name}`);
    const tail = values.length * runtime.type.stride;
    const total = runtime.offset + tail;
    if (!Number.isSafeInteger(tail) || !Number.isSafeInteger(total) || total > 0xffff_ffff) {
      throw new RangeError(`${record.name}.${runtime.name} exceeds the bounded GPU buffer size.`);
    }
    return total;
  };

  const encodeInto = (
    value: T,
    destination: ArrayBuffer | ArrayBufferView,
    byteOffset = 0,
  ): number => {
    if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
      throw new RangeError("byteOffset must be a non-negative safe integer.");
    }
    const length = byteLength(value);
    const region = bufferRegion(destination);
    if (byteOffset + length > region.byteLength) {
      throw new RangeError(`Destination needs ${length} bytes from byteOffset ${byteOffset}.`);
    }
    const absoluteOffset = region.byteOffset + byteOffset;
    new Uint8Array(region.buffer, absoluteOffset, length).fill(0);
    writeRecord(new DataView(region.buffer), absoluteOffset, record, value, record.name);
    return length;
  };

  return {
    record,
    minimumByteLength: record.minimumByteSize,
    byteLength,
    encode(value: T): ArrayBuffer {
      const output = new ArrayBuffer(byteLength(value));
      encodeInto(value, output);
      return output;
    },
    encodeInto,
    decode(source, options = {}): T {
      const region = bufferRegion(source);
      const relativeOffset = options.byteOffset ?? 0;
      if (!Number.isSafeInteger(relativeOffset) || relativeOffset < 0) {
        throw new RangeError("byteOffset must be a non-negative safe integer.");
      }
      const available = options.byteLength ?? region.byteLength - relativeOffset;
      if (!Number.isSafeInteger(available) || available < record.minimumByteSize) {
        throw new RangeError(`Source must provide at least ${record.minimumByteSize} bytes.`);
      }
      if (relativeOffset + available > region.byteLength) {
        throw new RangeError("Requested source region exceeds the supplied buffer.");
      }
      let count: number | undefined;
      if (runtime) {
        const tailLength = available - runtime.offset;
        if (tailLength < 0 || tailLength % runtime.type.stride !== 0) {
          throw new RangeError(`${record.name}.${runtime.name} byte length is not stride-aligned.`);
        }
        count = tailLength / runtime.type.stride;
        if (!Number.isSafeInteger(count) || count > 0xffff_ffff) throw new RangeError(`${record.name}.${runtime.name} runtime count is unsafe.`);
      } else if (record.byteSize !== available) {
        throw new RangeError(`${record.name} requires exactly ${record.byteSize} bytes.`);
      }
      const absoluteOffset = region.byteOffset + relativeOffset;
      return readRecord(new DataView(region.buffer), absoluteOffset, record, record.name, count) as T;
    },
  };
}
