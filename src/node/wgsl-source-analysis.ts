import { Function as WgslFunction, Override, Struct, Var, WgslParser } from "wgsl_reflect/wgsl_reflect.module.js";
import { canonicalizeGpuContract } from "../canonical-json.js";
import type {
  GpuAddressSpace,
  GpuBindingAccess,
  GpuBindingResourceLayout,
  GpuOverrideLayout,
  GpuRecordLayout,
  GpuRecordMemberLayout,
  GpuTypeLayout,
  GpuWorkgroupDimension,
} from "../contracts.js";

type AstNode = any;

const scalarSizes = new Map<string, number>([
  ["bool", 4],
  ["f16", 2],
  ["f32", 4],
  ["i32", 4],
  ["u32", 4],
]);
const MAX_LAYOUT_BYTES = 0xffff_ffff;

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function roundUp(alignment: number, value: number): number {
  const result = Math.ceil(value / alignment) * alignment;
  if (!Number.isSafeInteger(result) || result > MAX_LAYOUT_BYTES) throw new TypeError("WGSL layout exceeds the 32-bit host-shareable size bound.");
  return result;
}

/**
 * WebGPU validates a runtime-sized buffer binding as though its trailing array
 * contained one element. This is intentionally larger than a record's fixed
 * prefix (`minimumByteSize`) and is the value required by GPUBindGroupLayout.
 */
function minimumBufferBindingSize(
  layout: GpuTypeLayout,
  records: ReadonlyMap<string, GpuRecordLayout>,
): number {
  if (layout.byteSize !== null) return layout.byteSize;
  if (layout.kind === "array") return layout.stride;
  if (layout.kind !== "record") {
    throw new TypeError("Only records and arrays may be runtime-sized buffer roots.");
  }
  const record = records.get(layout.recordName);
  if (!record || record.runtimeArrayMember === null) {
    throw new TypeError(`Runtime-sized record ${layout.recordName} has no trailing runtime array.`);
  }
  const member = record.members.find((candidate) => candidate.name === record.runtimeArrayMember);
  if (!member || member.type.kind !== "array" || member.type.count !== null) {
    throw new TypeError(`Runtime-sized record ${layout.recordName} has invalid trailing-array metadata.`);
  }
  return roundUp(record.alignment, member.offset + member.type.stride);
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && value <= MAX_LAYOUT_BYTES && Number.isSafeInteger(value) && Number.isInteger(Math.log2(value));
}

function attributeValue(node: AstNode, name: string): unknown {
  return node?.attributes?.find((attribute: AstNode) => attribute.name === name)?.value;
}

function integerAttribute(node: AstNode, name: string): number | null {
  const value = attributeValue(node, name);
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_LAYOUT_BYTES) throw new TypeError(`@${name} exceeds the 32-bit layout bound.`);
  return parsed;
}

function normalizeTypeName(type: AstNode): { name: string; scalar?: string } {
  const raw = String(type?.name ?? "");
  const shorthand = /^(vec[234]|mat[234]x[234])([fhiu])$/u.exec(raw);
  if (!shorthand) return { name: raw, scalar: String(type?.format?.name ?? "") || undefined };
  return {
    name: shorthand[1]!,
    scalar: ({ f: "f32", h: "f16", i: "i32", u: "u32" } as const)[shorthand[2] as "f" | "h" | "i" | "u"],
  };
}

function typeLayout(type: AstNode, records: ReadonlyMap<string, GpuRecordLayout>): GpuTypeLayout {
  const normalized = normalizeTypeName(type);
  const scalarSize = scalarSizes.get(normalized.name);
  if (scalarSize !== undefined) {
    return {
      kind: "scalar",
      scalar: normalized.name as "bool" | "f16" | "f32" | "i32" | "u32",
      alignment: scalarSize,
      byteSize: scalarSize,
    };
  }
  if (normalized.name === "atomic") {
    const scalar = normalized.scalar;
    if (scalar !== "i32" && scalar !== "u32") throw new TypeError(`Unsupported atomic scalar ${scalar ?? "<missing>"}.`);
    return { kind: "atomic", scalar, alignment: 4, byteSize: 4 };
  }
  const vector = /^vec([234])$/u.exec(normalized.name);
  if (vector) {
    const scalar = normalized.scalar;
    const size = scalar ? scalarSizes.get(scalar) : undefined;
    if (!size) throw new TypeError(`Unsupported vector scalar ${scalar ?? "<missing>"}.`);
    const width = Number(vector[1]) as 2 | 3 | 4;
    return {
      kind: "vector",
      scalar: scalar as "bool" | "f16" | "f32" | "i32" | "u32",
      width,
      alignment: (width === 2 ? 2 : 4) * size,
      byteSize: width * size,
    };
  }
  const matrix = /^mat([234])x([234])$/u.exec(normalized.name);
  if (matrix) {
    const scalar = normalized.scalar;
    if (scalar !== "f16" && scalar !== "f32") throw new TypeError(`Unsupported matrix scalar ${scalar ?? "<missing>"}.`);
    const size = scalarSizes.get(scalar)!;
    const columns = Number(matrix[1]) as 2 | 3 | 4;
    const rows = Number(matrix[2]) as 2 | 3 | 4;
    const alignment = (rows === 2 ? 2 : 4) * size;
    const columnStride = roundUp(alignment, rows * size);
    return { kind: "matrix", scalar, columns, rows, columnStride, alignment, byteSize: columns * columnStride };
  }
  if (normalized.name === "array") {
    const element = typeLayout(type.format, records);
    if (element.byteSize === null) throw new TypeError("A runtime-sized array cannot be nested in another array.");
    const count = Number(type.count) === 0 ? null : Number(type.count);
    if (count !== null && (!Number.isSafeInteger(count) || count <= 0)) throw new TypeError("WGSL array count must be a positive integer.");
    const stride = roundUp(element.alignment, element.byteSize);
    return {
      kind: "array",
      element,
      count,
      stride,
      alignment: element.alignment,
      byteSize: count === null ? null : (() => {
        const size = count * stride;
        if (!Number.isSafeInteger(size) || size > MAX_LAYOUT_BYTES) throw new TypeError("WGSL array exceeds the 32-bit host-shareable size bound.");
        return size;
      })(),
    };
  }
  const record = records.get(normalized.name);
  if (record) {
    return { kind: "record", recordName: record.name, alignment: record.alignment, byteSize: record.byteSize };
  }
  throw new TypeError(`Unsupported WGSL type ${normalized.name || "<missing>"}.`);
}

function referencedRecordNames(type: AstNode, result = new Set<string>()): Set<string> {
  if (Array.isArray(type?.members) && typeof type.name === "string") result.add(type.name);
  if (type?.format && typeof type.format === "object") referencedRecordNames(type.format, result);
  return result;
}

function literalDefault(value: AstNode, type: GpuOverrideLayout["type"]): boolean | number | null {
  if (value === null || value === undefined) return null;
  const data = value?.value?.data;
  if (typeof data === "boolean" || typeof data === "number") return data;
  if (ArrayBuffer.isView(data) && !(data instanceof DataView)) {
    const values = data as unknown as ArrayLike<number>;
    if (values.length === 1) return type === "bool" ? Boolean(values[0]) : Number(values[0]);
  }
  throw new TypeError("Override defaults must be scalar constant literals.");
}

function workgroupDimension(value: unknown): GpuWorkgroupDimension {
  const token = String(value);
  if (/^[1-9]\d*$/u.test(token)) return { kind: "literal", value: Number(token) };
  if (/^[A-Za-z_]\w*$/u.test(token)) return { kind: "override", name: token };
  throw new TypeError(`Unsupported @workgroup_size expression ${token}.`);
}

function textureDimension(name: string): "1d" | "2d" | "2d-array" | "cube" | "cube-array" | "3d" {
  if (name.endsWith("_1d")) return "1d";
  if (name.endsWith("_2d_array")) return "2d-array";
  if (name.endsWith("_cube_array")) return "cube-array";
  if (name.endsWith("_cube")) return "cube";
  if (name.endsWith("_3d")) return "3d";
  if (name.endsWith("_2d")) return "2d";
  throw new TypeError(`Unsupported texture type ${name}.`);
}

export interface SourceBinding {
  readonly moduleId: string;
  readonly variableName: string;
  readonly group: number;
  readonly binding: number;
  readonly resource: GpuBindingResourceLayout;
}

function bindingResource(node: AstNode, records: ReadonlyMap<string, GpuRecordLayout>): GpuBindingResourceLayout {
  const typeName = String(node.type?.name ?? "");
  if (node.storage === "uniform" || node.storage === "storage") {
    const layout = typeLayout(node.type, records);
    const access: GpuBindingAccess = node.storage === "uniform"
      ? "read"
      : node.access === "read_write" ? "read_write" : node.access === "write" ? "write" : "read";
    return {
      kind: "buffer",
      addressSpace: node.storage,
      access,
      recordName: layout.kind === "record" ? layout.recordName : null,
      minimumBindingSize: minimumBufferBindingSize(layout, records),
    };
  }
  if (typeName === "sampler" || typeName === "sampler_comparison") {
    return { kind: "sampler", samplerType: typeName === "sampler_comparison" ? "comparison" : "filtering" };
  }
  if (typeName === "texture_external") return { kind: "external-texture" };
  if (typeName.startsWith("texture_storage_")) {
    const access = node.type.access === "read" ? "read-only" : node.type.access === "read_write" ? "read-write" : "write-only";
    const dimension = textureDimension(typeName);
    if (dimension === "cube" || dimension === "cube-array") throw new TypeError("Storage textures cannot use cube dimensions.");
    return {
      kind: "storage-texture",
      access,
      format: String(node.type.format),
      viewDimension: dimension,
    };
  }
  if (typeName.startsWith("texture_")) {
    const depth = typeName.startsWith("texture_depth_");
    const scalar = String(node.type.format?.name ?? "f32");
    const sampleType = depth ? "depth" : scalar === "i32" ? "sint" : scalar === "u32" ? "uint" : "float";
    return {
      kind: "texture",
      sampleType,
      viewDimension: textureDimension(typeName.replace("texture_multisampled_", "texture_").replace("texture_depth_multisampled_", "texture_depth_")),
      multisampled: typeName.includes("multisampled"),
    };
  }
  throw new TypeError(`@group/@binding variable ${node.name} has unsupported resource type ${typeName}.`);
}

function collectRecordAddressSpaces(nodes: readonly AstNode[], structNames: ReadonlySet<string>): ReadonlyMap<string, Set<GpuAddressSpace>> {
  const direct = new Map<string, Set<GpuAddressSpace>>();
  for (const name of structNames) direct.set(name, new Set());
  const addType = (type: AstNode, space: GpuAddressSpace): void => {
    for (const name of referencedRecordNames(type)) direct.get(name)?.add(space);
  };
  const walkFunction = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const node = value as AstNode;
    if (node instanceof Var && node.type) addType(node.type, "function");
    for (const child of Object.values(node)) {
      if (child instanceof Set || ArrayBuffer.isView(child)) continue;
      if (Array.isArray(child)) child.forEach(walkFunction);
    }
  };
  for (const node of nodes) {
    if (node instanceof Var) {
      const space = (node.storage || "private") as GpuAddressSpace;
      addType(node.type, space);
    } else if (node instanceof WgslFunction) {
      node.args.forEach((arg: AstNode) => addType(arg.type, "function"));
      node.body.forEach(walkFunction);
    }
  }
  return direct;
}

function transitiveAddressSpaces(
  recordNodes: ReadonlyMap<string, AstNode>,
  direct: ReadonlyMap<string, Set<GpuAddressSpace>>,
): ReadonlyMap<string, readonly GpuAddressSpace[]> {
  const accumulated = new Map<string, Set<GpuAddressSpace>>(
    [...recordNodes.keys()].map((name) => [name, new Set(direct.get(name))]),
  );
  const visit = (name: string, inherited: ReadonlySet<GpuAddressSpace>, stack: Set<string>): void => {
    if (stack.has(name)) throw new TypeError(`WGSL record cycle includes ${name}.`);
    const target = accumulated.get(name)!;
    for (const space of inherited) target.add(space);
    const next = new Set(stack).add(name);
    const node = recordNodes.get(name);
    for (const member of node?.members ?? []) {
      for (const nested of referencedRecordNames(member.type)) {
        if (nested !== name) visit(nested, target, next);
      }
    }
  };
  for (const [name, spaces] of direct) if (spaces.size > 0) visit(name, spaces, new Set());
  return new Map([...accumulated].map(([name, values]) => [name, [...values].sort(compareString)]));
}

export interface WgslSourceAnalysis {
  readonly ast: readonly AstNode[];
  readonly records: readonly GpuRecordLayout[];
  readonly bindings: readonly SourceBinding[];
  readonly overrides: readonly GpuOverrideLayout[];
  readonly workgroupSizes: ReadonlyMap<string, readonly [GpuWorkgroupDimension, GpuWorkgroupDimension, GpuWorkgroupDimension]>;
  /** WebGPU workgroup-storage bytes statically used by each compute entry point. */
  readonly workgroupStorageSizes: ReadonlyMap<string, number>;
}

function workgroupOverrideArrayCount(
  source: string,
  overrideNames: ReadonlySet<string>,
): string | null {
  const tokens: string[] = [...(source.match(/[A-Za-z_]\w*|[{}<>,:;=()]/gu) ?? [])];
  const namedTypes = new Map<string, readonly string[]>();
  const workgroupTypes: string[][] = [];
  const find = (start: number, token: string): number => {
    const index = tokens.indexOf(token, start);
    return index < 0 ? tokens.length : index;
  };
  const matching = (start: number, open: string, close: string): number => {
    let depth = 0;
    for (let index = start; index < tokens.length; index += 1) {
      if (tokens[index] === open) depth += 1;
      else if (tokens[index] === close && --depth === 0) return index;
    }
    return tokens.length;
  };

  for (let index = 0; index < tokens.length;) {
    if (tokens[index] === "alias") {
      const name = tokens[index + 1];
      const equals = find(index + 2, "=");
      const end = find(equals + 1, ";");
      if (name) namedTypes.set(name, tokens.slice(equals + 1, end));
      index = end + 1;
      continue;
    }
    if (tokens[index] === "struct") {
      const name = tokens[index + 1];
      const open = find(index + 2, "{");
      const close = matching(open, "{", "}");
      const memberTypes: string[] = [];
      for (let cursor = open + 1; cursor < close;) {
        const colon = tokens.indexOf(":", cursor);
        if (colon < 0 || colon >= close) break;
        let angleDepth = 0;
        let parenthesisDepth = 0;
        let end = colon + 1;
        for (; end < close; end += 1) {
          if (tokens[end] === "<") angleDepth += 1;
          else if (tokens[end] === ">") angleDepth -= 1;
          else if (tokens[end] === "(") parenthesisDepth += 1;
          else if (tokens[end] === ")") parenthesisDepth -= 1;
          else if (tokens[end] === "," && angleDepth === 0 && parenthesisDepth === 0) break;
        }
        memberTypes.push(...tokens.slice(colon + 1, end));
        cursor = end + 1;
      }
      if (name) namedTypes.set(name, memberTypes);
      index = close + 1;
      continue;
    }
    if (tokens[index] === "fn") {
      const open = find(index + 1, "{");
      index = matching(open, "{", "}") + 1;
      continue;
    }
    if (tokens[index] !== "var") {
      index += 1;
      continue;
    }
    let cursor = index + 1;
    let workgroup = false;
    if (tokens[cursor] === "<") {
      const close = matching(cursor, "<", ">");
      workgroup = tokens.slice(cursor + 1, close).includes("workgroup");
      cursor = close + 1;
    }
    const colon = find(cursor, ":");
    const end = find(colon + 1, ";");
    if (workgroup) workgroupTypes.push(tokens.slice(colon + 1, end));
    index = end + 1;
  }

  const inspect = (typeTokens: readonly string[], active = new Set<string>()): string | null => {
    for (let index = 0; index < typeTokens.length; index += 1) {
      if (typeTokens[index] === "array" && typeTokens[index + 1] === "<") {
        const close = (() => {
          let depth = 0;
          for (let cursor = index + 1; cursor < typeTokens.length; cursor += 1) {
            if (typeTokens[cursor] === "<") depth += 1;
            else if (typeTokens[cursor] === ">" && --depth === 0) return cursor;
          }
          return typeTokens.length;
        })();
        let depth = 0;
        let comma = -1;
        for (let cursor = index + 1; cursor < close; cursor += 1) {
          if (typeTokens[cursor] === "<") depth += 1;
          else if (typeTokens[cursor] === ">") depth -= 1;
          else if (typeTokens[cursor] === "," && depth === 1) comma = cursor;
        }
        if (comma >= 0) {
          const override = typeTokens.slice(comma + 1, close).find((token) => overrideNames.has(token));
          if (override) return override;
        }
      }
      const name = typeTokens[index]!;
      const referenced = namedTypes.get(name);
      if (referenced && !active.has(name)) {
        const nested = inspect(referenced, new Set(active).add(name));
        if (nested) return nested;
      }
    }
    return null;
  };
  for (const typeTokens of workgroupTypes) {
    const override = inspect(typeTokens);
    if (override) return override;
  }
  return null;
}

function staticallyReferencedWorkgroupVariables(
  entryPoint: AstNode,
  variableNames: ReadonlySet<string>,
): ReadonlySet<string> {
  const result = new Set<string>();
  const visitedValues = new WeakSet<object>();
  const visitedFunctions = new Set<AstNode>();
  const walkValue = (value: unknown): void => {
    if (!value || typeof value !== "object" || ArrayBuffer.isView(value)) return;
    if (visitedValues.has(value)) return;
    visitedValues.add(value);
    if (Array.isArray(value)) {
      value.forEach(walkValue);
      return;
    }
    if (value instanceof Set) return;
    const node = value as AstNode;
    if (typeof node.name === "string" && variableNames.has(node.name)) result.add(node.name);
    Object.values(node).forEach(walkValue);
  };
  const walkFunction = (fn: AstNode): void => {
    if (visitedFunctions.has(fn)) return;
    visitedFunctions.add(fn);
    walkValue(fn.body);
    for (const called of fn.calls ?? []) if (called instanceof WgslFunction) walkFunction(called);
  };
  walkFunction(entryPoint);
  return result;
}

function recordLayoutProjection(record: GpuRecordLayout): unknown {
  return {
    name: record.name,
    alignment: record.alignment,
    byteSize: record.byteSize,
    minimumByteSize: record.minimumByteSize,
    runtimeArrayMember: record.runtimeArrayMember,
    members: record.members,
  };
}

/** Detects disagreement between the independent AST layout and reflector metadata. */
export function assertReflectedRecordLayouts(
  sourceRecords: readonly GpuRecordLayout[],
  reflectedRecords: readonly GpuRecordLayout[],
): void {
  if (sourceRecords.length !== reflectedRecords.length) throw new TypeError("Independent and reflected WGSL record inventories differ.");
  const reflected = new Map(reflectedRecords.map((record) => [record.name, record]));
  for (const source of sourceRecords) {
    const candidate = reflected.get(source.name);
    if (!candidate || canonicalizeGpuContract(recordLayoutProjection(source)) !== canonicalizeGpuContract(recordLayoutProjection(candidate))) {
      throw new TypeError(`Independent and reflected layout metadata disagree for record ${source.name}.`);
    }
  }
}

/** Derives host-shareable layout independently from wgsl_reflect's layout metadata. */
export function analyzeWgslSource(source: string, moduleId: string): WgslSourceAnalysis {
  const ast = WgslParser.Parse(source) as AstNode[];
  const tokenSource = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
  const topLevelNames = new Set<string>();
  for (const node of ast) {
    if (typeof node?.name !== "string") continue;
    if (topLevelNames.has(node.name)) throw new TypeError(`WGSL module ${moduleId} declares ${node.name} more than once.`);
    topLevelNames.add(node.name);
  }
  const recordNodes = new Map<string, AstNode>();
  for (const node of ast) if (node instanceof Struct) recordNodes.set(String(node.name), node);
  const directSpaces = collectRecordAddressSpaces(ast, new Set(recordNodes.keys()));
  const spaces = transitiveAddressSpaces(recordNodes, directSpaces);

  const layouts = new Map<string, GpuRecordLayout>();
  const pending = new Set(recordNodes.keys());
  while (pending.size > 0) {
    let progressed = false;
    for (const name of [...pending]) {
      const node = recordNodes.get(name)!;
      const dependencies = new Set<string>();
      for (const member of node.members) for (const nested of referencedRecordNames(member.type)) if (nested !== name) dependencies.add(nested);
      if ([...dependencies].some((dependency) => !layouts.has(dependency))) continue;
      let cursor = 0;
      let alignment = 1;
      let runtimeArrayMember: string | null = null;
      const members: GpuRecordMemberLayout[] = node.members.map((member: AstNode, index: number) => {
        const type = typeLayout(member.type, layouts);
        const explicitAlign = integerAttribute(member, "align");
        const explicitSize = integerAttribute(member, "size");
        if (explicitAlign !== null && (!isPowerOfTwo(explicitAlign) || explicitAlign < type.alignment)) {
          throw new TypeError(`${name}.${member.name} has invalid @align(${explicitAlign}).`);
        }
        if (type.byteSize === null && (index !== node.members.length - 1 || type.kind !== "array")) throw new TypeError(`${name} has an indirect or non-final runtime-sized array.`);
        if (type.byteSize === null && explicitSize !== null) throw new TypeError(`${name}.${member.name} cannot size a runtime-sized array.`);
        if (explicitSize !== null && (type.byteSize === null || explicitSize < type.byteSize)) {
          throw new TypeError(`${name}.${member.name} has invalid @size(${explicitSize}).`);
        }
        const memberAlignment = explicitAlign ?? type.alignment;
        const offset = roundUp(memberAlignment, cursor);
        const occupiedByteSize = type.byteSize === null ? null : explicitSize ?? type.byteSize;
        alignment = Math.max(alignment, memberAlignment);
        if (occupiedByteSize === null) runtimeArrayMember = String(member.name);
        else cursor = offset + occupiedByteSize;
        return {
          name: String(member.name), offset, alignment: memberAlignment,
          valueByteSize: type.byteSize, occupiedByteSize, explicitAlign, explicitSize, type,
        };
      });
      const minimumByteSize = runtimeArrayMember ? members.at(-1)!.offset : roundUp(alignment, cursor);
      layouts.set(name, {
        name, alignment,
        byteSize: runtimeArrayMember ? null : minimumByteSize,
        minimumByteSize,
        runtimeArrayMember,
        addressSpaces: spaces.get(name) ?? [],
        members,
      });
      pending.delete(name);
      progressed = true;
    }
    if (!progressed) throw new TypeError(`WGSL record dependency cycle or unresolved record: ${[...pending].join(", ")}.`);
  }

  const contains = (layout: GpuTypeLayout, kind: "bool" | "atomic", seen = new Set<string>()): boolean => {
    if (kind === "bool" && layout.kind === "scalar" && layout.scalar === "bool") return true;
    if (kind === "atomic" && layout.kind === "atomic") return true;
    if (layout.kind === "array") return contains(layout.element, kind, seen);
    if (layout.kind === "record" && !seen.has(layout.recordName)) {
      seen.add(layout.recordName);
      return layouts.get(layout.recordName)?.members.some((member) => contains(member.type, kind, seen)) ?? false;
    }
    return false;
  };
  const validateUniformRecord = (record: GpuRecordLayout, seen = new Set<string>()): void => {
    if (seen.has(record.name)) return;
    seen.add(record.name);
    for (const [index, member] of record.members.entries()) {
      const requiredAlignment = member.type.kind === "array" || member.type.kind === "record"
        ? roundUp(16, member.type.alignment) : member.type.alignment;
      if (member.offset % requiredAlignment !== 0) throw new TypeError(`${record.name}.${member.name} violates uniform required alignment.`);
      if (member.type.kind === "array" && member.type.stride % 16 !== 0) throw new TypeError(`${record.name}.${member.name} violates uniform array stride.`);
      if (member.type.kind === "record") {
        const nested = layouts.get(member.type.recordName)!;
        validateUniformRecord(nested, seen);
        const next = record.members[index + 1];
        if (next && nested.byteSize !== null && next.offset - member.offset < roundUp(16, nested.byteSize)) {
          throw new TypeError(`${record.name}.${member.name} violates uniform nested-record spacing.`);
        }
      }
    }
  };
  for (const record of layouts.values()) {
    const host = record.addressSpaces.some((space) => space === "uniform" || space === "storage");
    if (host && record.members.some((member) => contains(member.type, "bool"))) throw new TypeError(`${record.name} uses bool in a host-shareable address space.`);
    if (record.runtimeArrayMember !== null && (record.addressSpaces.length === 0 || record.addressSpaces.some((space) => space !== "storage"))) {
      throw new TypeError(`${record.name} runtime arrays are only valid in storage-buffer records.`);
    }
    if (record.addressSpaces.includes("uniform")) {
      if (record.members.some((member) => contains(member.type, "atomic"))) throw new TypeError(`${record.name} uses atomic data in uniform address space.`);
      validateUniformRecord(record);
    }
    if (record.addressSpaces.some((space) => space === "function" || space === "private")
      && record.members.some((member) => contains(member.type, "atomic"))) {
      throw new TypeError(`${record.name} uses atomic data outside storage/workgroup address space.`);
    }
  }
  const usesF16 = [...layouts.values()].some((record) => record.members.some((member) => {
    const visit = (layout: GpuTypeLayout): boolean => layout.kind === "scalar" && layout.scalar === "f16"
      || layout.kind === "vector" && layout.scalar === "f16"
      || layout.kind === "matrix" && layout.scalar === "f16"
      || layout.kind === "array" && visit(layout.element)
      || layout.kind === "record" && (layouts.get(layout.recordName)?.members.some((nested) => visit(nested.type)) ?? false);
    return visit(member.type);
  })) || /\b(?:f16|vec[234]h|mat[234]x[234]h)\b/u.test(tokenSource);
  if (usesF16 && !/\benable\s+f16\s*;/u.test(tokenSource)) {
    throw new TypeError(`WGSL module ${moduleId} uses f16 without enable f16;.`);
  }

  const bindings: SourceBinding[] = [];
  const bindingSlots = new Set<string>();
  for (const node of ast.filter((candidate) => candidate instanceof Var)) {
    const group = integerAttribute(node, "group");
    const binding = integerAttribute(node, "binding");
    if (group === null && binding === null) continue;
    if (group === null || binding === null) throw new TypeError(`WGSL resource ${node.name} must declare both @group and @binding.`);
    if (node.storage === "uniform" && node.access) throw new TypeError(`Uniform resource ${node.name} cannot declare access mode ${node.access}.`);
    if (node.storage === "storage" && node.access !== "read" && node.access !== "read_write") throw new TypeError(`Storage resource ${node.name} must declare read or read_write access.`);
    const key = `${group}:${binding}`;
    if (bindingSlots.has(key)) throw new TypeError(`WGSL module ${moduleId} declares duplicate binding ${key}.`);
    bindingSlots.add(key);
    const resource = bindingResource(node, layouts);
    if (resource.kind === "buffer" && resource.recordName) {
      const record = layouts.get(resource.recordName)!;
      if (resource.addressSpace === "storage" && resource.access !== "read_write" && record.members.some((member) => contains(member.type, "atomic"))) {
        throw new TypeError(`Atomic storage resource ${node.name} must use read_write access.`);
      }
    }
    bindings.push({ moduleId, variableName: String(node.name), group, binding, resource });
  }

  const reflection = new Set<string>();
  const overrides: GpuOverrideLayout[] = [];
  for (const node of ast) {
    if (!(node instanceof Override)) continue;
    const typeNode = node.type ?? node.value?.type;
    const type = normalizeTypeName(typeNode).name as GpuOverrideLayout["type"];
    if (!["bool", "f16", "f32", "i32", "u32"].includes(type)) continue;
    const id = integerAttribute(node, "id");
    if (id !== null && reflection.has(String(id))) throw new TypeError(`WGSL module ${moduleId} repeats override @id(${id}).`);
    if (id !== null) reflection.add(String(id));
    overrides.push({ moduleId, name: node.name, id, type, defaultValue: literalDefault(node.value, type) });
  }

  const overrideNames = new Set(overrides.map((override) => override.name));
  const workgroupOverride = workgroupOverrideArrayCount(tokenSource, overrideNames);
  if (workgroupOverride) {
    throw new TypeError(
      `WGSL module ${moduleId} uses override-sized workgroup array ${workgroupOverride}; workgroup storage must have an exact reflected byte size.`,
    );
  }
  const workgroupSizes = new Map<string, readonly [GpuWorkgroupDimension, GpuWorkgroupDimension, GpuWorkgroupDimension]>();
  for (const node of ast.filter((candidate) => candidate instanceof WgslFunction)) {
    const raw = attributeValue(node, "workgroup_size");
    if (raw === undefined) continue;
    const values = Array.isArray(raw) ? [...raw] : [raw];
    while (values.length < 3) values.push("1");
    if (values.length !== 3) throw new TypeError(`Entry point ${node.name} has invalid @workgroup_size.`);
    const dimensions = values.map(workgroupDimension) as [GpuWorkgroupDimension, GpuWorkgroupDimension, GpuWorkgroupDimension];
    for (const dimension of dimensions) {
      if (dimension.kind === "override" && !overrideNames.has(dimension.name)) {
        throw new TypeError(`Entry point ${node.name} references unknown workgroup override ${dimension.name}.`);
      }
    }
    workgroupSizes.set(String(node.name), dimensions);
  }

  const workgroupVariables = new Map<string, number>();
  for (const node of ast.filter((candidate) => candidate instanceof Var && candidate.storage === "workgroup")) {
    const layout = typeLayout(node.type, layouts);
    if (layout.byteSize === null) {
      throw new TypeError(`Workgroup variable ${node.name} must have a fixed reflected byte size.`);
    }
    workgroupVariables.set(String(node.name), roundUp(16, layout.byteSize));
  }
  const workgroupStorageSizes = new Map<string, number>();
  const functions = new Map(
    ast.filter((candidate) => candidate instanceof WgslFunction)
      .map((fn) => [String(fn.name), fn] as const),
  );
  for (const entryPointName of workgroupSizes.keys()) {
    const entryPoint = functions.get(entryPointName);
    if (!entryPoint) throw new TypeError(`Workgroup entry point ${entryPointName} is missing from the parsed module.`);
    const referenced = staticallyReferencedWorkgroupVariables(entryPoint, new Set(workgroupVariables.keys()));
    let total = 0;
    for (const name of referenced) {
      total += workgroupVariables.get(name)!;
      if (!Number.isSafeInteger(total) || total > MAX_LAYOUT_BYTES) {
        throw new TypeError(`Entry point ${entryPointName} workgroup storage exceeds the 32-bit manifest bound.`);
      }
    }
    workgroupStorageSizes.set(entryPointName, total);
  }

  return {
    ast,
    records: [...layouts.values()].sort((left, right) => compareString(left.name, right.name)),
    bindings: bindings.sort((left, right) => left.group - right.group || left.binding - right.binding),
    overrides: overrides.sort((left, right) => compareString(left.name, right.name)),
    workgroupSizes,
    workgroupStorageSizes,
  };
}
