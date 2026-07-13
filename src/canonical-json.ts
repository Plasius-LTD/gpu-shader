import type { JsonValue } from "./contracts.js";

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertUnicodeScalarString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(`${path} contains an unpaired UTF-16 surrogate.`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError(`${path} contains an unpaired UTF-16 surrogate.`);
  }
}

/**
 * Canonicalizes contract data using the JSON Canonicalization Scheme ordering
 * rules. Unsupported JavaScript values are rejected rather than silently lost.
 */
export function canonicalizeGpuContract(value: unknown): string {
  const ancestors = new Set<object>();

  const visit = (current: unknown, path: string): string => {
    if (current === null) return "null";
    if (typeof current === "string" || typeof current === "boolean") {
      if (typeof current === "string") assertUnicodeScalarString(current, path);
      return JSON.stringify(current);
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new TypeError(`${path} contains a non-finite number.`);
      }
      return Object.is(current, -0) ? "0" : JSON.stringify(current);
    }
    if (typeof current !== "object") {
      throw new TypeError(`${path} contains a value that JSON cannot represent.`);
    }
    if (ancestors.has(current)) {
      throw new TypeError(`${path} contains a circular reference.`);
    }

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        return `[${current.map((item, index) => visit(item, `${path}[${index}]`)).join(",")}]`;
      }
      if (!isPlainObject(current)) {
        throw new TypeError(`${path} must contain only plain JSON objects.`);
      }
      const keys = Object.keys(current).sort();
      const properties = keys.map((key) => {
        assertUnicodeScalarString(key, `${path} key`);
        const member = current[key];
        if (member === undefined) {
          throw new TypeError(`${path}.${key} is undefined.`);
        }
        return `${JSON.stringify(key)}:${visit(member, `${path}.${key}`)}`;
      });
      return `{${properties.join(",")}}`;
    } finally {
      ancestors.delete(current);
    }
  };

  return visit(value, "$root");
}

/** Parses and verifies exact JCS canonical JSON while preserving its JSON-only type. */
export function parseCanonicalJson(value: string): JsonValue {
  const parsed = JSON.parse(value) as JsonValue;
  if (canonicalizeGpuContract(parsed) !== value) throw new TypeError("JSON input is valid but not in canonical form.");
  return parsed;
}
