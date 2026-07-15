import type { JsonValue } from "./contracts.js";

/** Finite resource policy applied while copying one JSON contract graph. */
export interface GpuContractSnapshotLimits {
  readonly maximumDepth: number;
  readonly maximumNodes: number;
  readonly maximumProperties: number;
  readonly maximumElements: number;
  readonly maximumArrayLength: number;
  readonly maximumStringBytes: number;
  readonly maximumAggregateStringBytes: number;
  readonly maximumAggregateBytes: number;
  readonly maximumInputBytes: number;
}

/** Browser/runtime bounds for manifests, references, and compatibility data. */
export const GPU_CONTRACT_SNAPSHOT_LIMITS: GpuContractSnapshotLimits = Object.freeze({
  maximumDepth: 64,
  maximumNodes: 262_144,
  maximumProperties: 131_072,
  maximumElements: 131_072,
  maximumArrayLength: 100_000,
  maximumStringBytes: 1024 * 1024,
  maximumAggregateStringBytes: 8 * 1024 * 1024,
  maximumAggregateBytes: 16 * 1024 * 1024,
  maximumInputBytes: 16 * 1024 * 1024,
});

/** Larger, still fail-closed bounds for complete qualification products. */
export const QUALIFICATION_GPU_CONTRACT_SNAPSHOT_LIMITS: GpuContractSnapshotLimits = Object.freeze({
  maximumDepth: 96,
  maximumNodes: 4_000_000,
  maximumProperties: 2_000_000,
  maximumElements: 2_000_000,
  maximumArrayLength: 250_000,
  maximumStringBytes: 4 * 1024 * 1024,
  maximumAggregateStringBytes: 128 * 1024 * 1024,
  maximumAggregateBytes: 256 * 1024 * 1024,
  maximumInputBytes: 256 * 1024 * 1024,
});

type SnapshotFailure =
  | "aggregate-bytes"
  | "aggregate-string-bytes"
  | "array-length"
  | "cycle"
  | "depth"
  | "elements"
  | "inspection"
  | "nodes"
  | "non-finite"
  | "properties"
  | "shape"
  | "string-bytes"
  | "unicode"
  | "value";

const FAILURE_MESSAGES: Readonly<Record<SnapshotFailure, string>> = Object.freeze({
  "aggregate-bytes": "GPU contract snapshot exceeds the aggregate byte limit.",
  "aggregate-string-bytes": "GPU contract snapshot exceeds the aggregate string byte limit.",
  "array-length": "GPU contract snapshot exceeds the single-array element limit.",
  cycle: "GPU contract snapshot contains a circular reference.",
  depth: "GPU contract snapshot exceeds the nesting-depth limit.",
  elements: "GPU contract snapshot exceeds the total element limit.",
  inspection: "GPU contract snapshot rejected unsafe object inspection.",
  nodes: "GPU contract snapshot exceeds the total node limit.",
  "non-finite": "GPU contract snapshot contains a non-finite number.",
  properties: "GPU contract snapshot exceeds the total property limit.",
  shape: "GPU contract snapshot requires plain JSON objects with own enumerable data properties and dense arrays.",
  "string-bytes": "GPU contract snapshot exceeds the individual string byte limit.",
  unicode: "GPU contract snapshot contains an invalid Unicode scalar string or unpaired UTF-16 surrogate.",
  value: "GPU contract snapshot contains undefined or another value that JSON cannot represent.",
});

/** Constant, cause-free failure emitted by the own-data snapshot boundary. */
export class GpuContractSnapshotError extends TypeError {
  readonly code: SnapshotFailure;

  constructor(code: SnapshotFailure) {
    super(FAILURE_MESSAGES[code]);
    this.name = "GpuContractSnapshotError";
    this.code = code;
  }
}

const TYPED_ARRAY_PROTOTYPE = Reflect.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BYTE_LENGTH = Reflect.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)?.get as ((this: ArrayBufferView) => number) | undefined;
const TYPED_ARRAY_TAG = Reflect.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  Symbol.toStringTag,
)?.get as ((this: ArrayBufferView) => string | undefined) | undefined;
const UINT8_ARRAY_SET = Uint8Array.prototype.set;

/**
 * Brand-checks and copies bytes using TypedArray intrinsics only. This accepts
 * Buffer, subclasses, and cross-realm Uint8Arrays without consulting caller
 * properties, constructors, iterators, or Proxy `get` traps.
 */
export function snapshotUint8Array(value: unknown, maximumBytes: number): Uint8Array {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new TypeError("GPU contract byte limit must be a non-negative safe integer.");
  }
  let byteLength: number;
  let tag: string | undefined;
  try {
    if (!TYPED_ARRAY_BYTE_LENGTH || !TYPED_ARRAY_TAG) throw new TypeError();
    byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH, value, []);
    tag = Reflect.apply(TYPED_ARRAY_TAG, value, []);
  } catch {
    throw new TypeError("GPU contract bytes must be a bounded detached Uint8Array.");
  }
  if (tag !== "Uint8Array" || !Number.isSafeInteger(byteLength) || byteLength > maximumBytes) {
    throw new TypeError("GPU contract bytes must be a bounded detached Uint8Array.");
  }
  const output = new Uint8Array(byteLength);
  try {
    Reflect.apply(UINT8_ARRAY_SET, output, [value]);
  } catch {
    throw new TypeError("GPU contract bytes must be a bounded detached Uint8Array.");
  }
  return output;
}

function fail(reason: SnapshotFailure): never {
  throw new GpuContractSnapshotError(reason);
}

function inspected<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    return fail("inspection");
  }
}

function assertLimit(value: number, maximum: number, reason: SnapshotFailure): void {
  if (!Number.isSafeInteger(value) || value > maximum) fail(reason);
}

function utf8ByteLength(value: string, maximum: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail("unicode");
      bytes += 4;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) fail("unicode");
    else bytes += 3;
    if (bytes > maximum) fail("string-bytes");
  }
  return bytes;
}

function quotedJsonByteLength(value: string, maximum: number): { readonly raw: number; readonly quoted: number } {
  let raw = 0;
  let quoted = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      raw += 1;
      if (code <= 0x1f) quoted += code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
      else quoted += code === 0x22 || code === 0x5c ? 2 : 1;
    } else if (code <= 0x7ff) {
      raw += 2;
      quoted += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail("unicode");
      raw += 4;
      quoted += 4;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) fail("unicode");
    else {
      raw += 3;
      quoted += 3;
    }
    if (raw > maximum) fail("string-bytes");
  }
  return { raw, quoted };
}

function assertLimits(limits: GpuContractSnapshotLimits): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("GPU contract snapshot limits must be positive safe integers.");
  }
}

/**
 * Copies caller data without property reads. Only reflective own-property
 * inspection is used; proxy reflection traps may run, but their failures are
 * replaced with constant diagnostics and are never retained as a cause.
 */
export function snapshotGpuContract(
  value: unknown,
  limits: GpuContractSnapshotLimits = GPU_CONTRACT_SNAPSHOT_LIMITS,
): JsonValue {
  assertLimits(limits);
  const ancestors = new Set<object>();
  let nodes = 0;
  let properties = 0;
  let elements = 0;
  let aggregateStringBytes = 0;
  let aggregateBytes = 0;

  const addAggregate = (bytes: number): void => {
    aggregateBytes += bytes;
    assertLimit(aggregateBytes, limits.maximumAggregateBytes, "aggregate-bytes");
  };
  const addString = (text: string): number => {
    const measured = quotedJsonByteLength(text, limits.maximumStringBytes);
    aggregateStringBytes += measured.raw;
    assertLimit(aggregateStringBytes, limits.maximumAggregateStringBytes, "aggregate-string-bytes");
    return measured.quoted;
  };

  const visit = (current: unknown, depth: number): JsonValue => {
    if (depth > limits.maximumDepth) fail("depth");
    nodes += 1;
    assertLimit(nodes, limits.maximumNodes, "nodes");

    if (current === null) {
      addAggregate(4);
      return null;
    }
    if (typeof current === "string") {
      addAggregate(addString(current));
      return current;
    }
    if (typeof current === "boolean") {
      addAggregate(current ? 4 : 5);
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail("non-finite");
      const normalized = Object.is(current, -0) ? 0 : current;
      addAggregate(JSON.stringify(normalized).length);
      return normalized;
    }
    if (typeof current !== "object") fail("value");
    if (ancestors.has(current)) fail("cycle");

    const isArray = inspected(() => Array.isArray(current));
    const prototype = inspected(() => Reflect.getPrototypeOf(current));
    if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail("shape");
    ancestors.add(current);
    try {
      if (isArray) {
        const lengthDescriptor = inspected(() => Reflect.getOwnPropertyDescriptor(current, "length"));
        if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value") || lengthDescriptor.enumerable
          || typeof lengthDescriptor.value !== "number" || !Number.isSafeInteger(lengthDescriptor.value)
          || lengthDescriptor.value < 0) fail("shape");
        const length = lengthDescriptor.value;
        assertLimit(length, limits.maximumArrayLength, "array-length");
        elements += length;
        assertLimit(elements, limits.maximumElements, "elements");
        const ownKeys = inspected(() => Reflect.ownKeys(current));
        if (ownKeys.some((key) => typeof key !== "string")) fail("shape");
        if (ownKeys.length !== length + 1) fail("shape");
        const keySet = new Set(ownKeys as string[]);
        if (!keySet.delete("length")) fail("shape");
        const output = new Array<JsonValue>(length);
        addAggregate(2 + Math.max(0, length - 1));
        for (let index = 0; index < length; index += 1) {
          const key = String(index);
          if (!keySet.delete(key)) fail("shape");
          const descriptor = inspected(() => Reflect.getOwnPropertyDescriptor(current, key));
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail("shape");
          Object.defineProperty(output, key, {
            configurable: true,
            enumerable: true,
            value: visit(descriptor.value, depth + 1),
            writable: true,
          });
        }
        if (keySet.size !== 0) fail("shape");
        return output;
      }

      const ownKeys = inspected(() => Reflect.ownKeys(current));
      if (ownKeys.some((key) => typeof key !== "string")) fail("shape");
      properties += ownKeys.length;
      assertLimit(properties, limits.maximumProperties, "properties");
      addAggregate(2 + Math.max(0, ownKeys.length - 1) + ownKeys.length);
      const output: Record<string, JsonValue> = {};
      for (const key of ownKeys as string[]) {
        addAggregate(addString(key));
        const descriptor = inspected(() => Reflect.getOwnPropertyDescriptor(current, key));
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail("shape");
        Object.defineProperty(output, key, {
          configurable: true,
          enumerable: true,
          value: visit(descriptor.value, depth + 1),
          writable: true,
        });
      }
      return output;
    } finally {
      ancestors.delete(current);
    }
  };

  return visit(value, 0);
}

function serializeSnapshot(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializeSnapshot).join(",")}]`;
  const input = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${serializeSnapshot(input[key]!)}`).join(",")}}`;
}

/**
 * Canonicalizes contract data using JSON Canonicalization Scheme ordering.
 * Caller objects first pass through the bounded own-data snapshot boundary.
 */
export function canonicalizeGpuContract(value: unknown): string {
  return serializeSnapshot(snapshotGpuContract(value));
}

/** Canonicalizes a bounded qualification product using its larger named policy. */
export function canonicalizeQualificationGpuContract(value: unknown): string {
  return serializeSnapshot(snapshotGpuContract(value, QUALIFICATION_GPU_CONTRACT_SNAPSHOT_LIMITS));
}

/** Parses and verifies exact bounded JCS JSON while preserving its JSON-only type. */
export function parseCanonicalJson(value: string): JsonValue {
  if (typeof value !== "string") throw new TypeError("Canonical GPU contract JSON must be a string.");
  try {
    utf8ByteLength(value, GPU_CONTRACT_SNAPSHOT_LIMITS.maximumInputBytes);
  } catch {
    throw new TypeError("Canonical GPU contract JSON is invalid or exceeds its input bound.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new TypeError("Canonical GPU contract JSON is invalid or exceeds its input bound.");
  }
  const snapshot = snapshotGpuContract(parsed);
  if (serializeSnapshot(snapshot) !== value) throw new TypeError("JSON input is valid but not in canonical form.");
  return snapshot;
}
