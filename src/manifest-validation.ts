import {
  GPU_INTERFACE_MANIFEST_VERSION,
  SHADER_QUALIFICATION_FIXTURE_VERSION,
  SHADER_STYLE_PROFILE_MANIFEST_VERSION,
  SHADER_VERSION_MANIFEST_VERSION,
  SUPPORTED_ADDITIVE_WEBGPU_MATRIX_POLICIES,
  SUPPORTED_STABLE_WEBGPU_MATRIX_POLICIES,
  type GpuBindingResourceLayout,
  type GpuInterfaceManifest,
  type ModelGpuCompatibilityDescriptor,
  type GpuRecordLayout,
  type GpuTypeLayout,
  type SerializableGpuPipelineDescriptor,
  type ShaderStyleProfileManifest,
  type ShaderQualificationModelCompatibilityFixture,
  type ShaderVersionManifest,
  type ShaderVersionManifestCore,
} from "./contracts.js";
import {
  canonicalizeGpuContract as canonicalizeForValidation,
  GPU_CONTRACT_SNAPSHOT_LIMITS,
  GpuContractSnapshotError,
  snapshotGpuContract,
  snapshotUint8Array,
} from "./canonical-json.js";
import { assertImmutableAssetVersion } from "./asset-version.js";
import { wgslIdentifier } from "./wgsl-identifier.js";
import { asSha256Hex } from "./hash.js";
import { validatePipelineDerivedRequirements } from "./requirements-validation.js";

type UnknownRecord = Record<string, unknown>;
const stages = ["vertex", "fragment", "compute"] as const;
const roles = ["material", "lighting", "outline", "shadow", "post-processing"] as const;

function detachedJson(value: unknown, path: string): unknown {
  try {
    return snapshotGpuContract(value);
  } catch (cause) {
    const detail = cause instanceof GpuContractSnapshotError ? ` ${cause.message}` : "";
    // eslint-disable-next-line preserve-caught-error -- caller/proxy failures must never escape this trust boundary
    throw new TypeError(`${path} must contain bounded detached JSON contract data.${detail}`);
  }
}

function object(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${path} must be an object.`);
  return value as UnknownRecord;
}

function exact(value: UnknownRecord, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${path}.${key} is not part of this contract version.`);
  for (const key of keys) if (!Object.hasOwn(value, key)) throw new TypeError(`${path}.${key} is required.`);
}

function text(value: unknown, path: string, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || [...value].some((character) => character.charCodeAt(0) <= 0x1f)) {
    throw new TypeError(`${path} must be a bounded non-empty string without control characters.`);
  }
  return value;
}

function token(value: unknown, path: string): string {
  const result = text(value, path, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(result) || result.includes("..")) throw new TypeError(`${path} must be a safe token.`);
  return result;
}

function nullableIdentifier(value: unknown, path: string): string | null {
  return value === null ? null : wgslIdentifier(value, path);
}

function identifierArray(value: unknown, path: string, maximum = 4096): string[] {
  const result = array(value, path, maximum).map((item, index) => wgslIdentifier(item, `${path}[${index}]`));
  unique(result, String, path);
  return result;
}

function immutableVersion(value: unknown, path: string): string {
  try {
    return assertImmutableAssetVersion(value);
  } catch {
    throw new TypeError(`${path} must be an immutable asset version: exact token required; mutable aliases, ranges, wildcards, and URLs are not allowed.`);
  }
}

function enumeration<T extends string | number>(value: unknown, values: readonly T[], path: string): T {
  if (!values.includes(value as T)) throw new TypeError(`${path} is invalid.`);
  return value as T;
}

function integer(value: unknown, path: string, minimum = 0, maximum = 0xffff_ffff): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${path} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value as number;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${path} must be finite.`);
  return value;
}

function array(value: unknown, path: string, maximum = 4096): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${path} must be a bounded array.`);
  return value;
}

function nullableInteger(value: unknown, path: string): number | null {
  return value === null ? null : integer(value, path);
}

function nullableToken(value: unknown, path: string): string | null {
  return value === null ? null : token(value, path);
}

function digest(value: unknown, path: string): string {
  try { return asSha256Hex(text(value, path, 64)); }
  catch { throw new TypeError(`${path} must be a lowercase SHA-256 digest.`); }
}

function uri(value: unknown, path: string): string {
  const result = text(value, path, 2048);
  let parsed: URL;
  try { parsed = new URL(result); }
  catch { throw new TypeError(`${path} must be an absolute immutable asset URI.`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) throw new TypeError(`${path} must be credential-free HTTPS without a fragment.`);
  const keys = [...parsed.searchParams.keys()].map((key) => key.toLowerCase());
  const forbidden = new Set(["sig", "se", "sp", "sv", "spr", "st", "skoid", "sktid", "skt", "ske", "sks", "skv"]);
  if (keys.some((key) => forbidden.has(key)) || new Set(keys).size !== keys.length) throw new TypeError(`${path} must not contain SAS credentials or duplicate query parameters.`);
  if (parsed.href !== result) throw new TypeError(`${path} must use its canonical URL serialization.`);
  return result;
}

function unique<T>(values: readonly T[], key: (value: T) => string, path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const identity = key(value);
    if (seen.has(identity)) throw new TypeError(`${path} contains duplicate ${identity}.`);
    seen.add(identity);
  }
}

function tokenArray(value: unknown, path: string, maximum = 4096): string[] {
  const result = array(value, path, maximum).map((item, index) => token(item, `${path}[${index}]`));
  unique(result, String, path);
  return result;
}

function typeLayout(value: unknown, path: string, depth = 0): GpuTypeLayout {
  if (depth > 24) throw new TypeError(`${path} exceeds the type nesting limit.`);
  const input = object(value, path);
  const kind = enumeration(input.kind, ["scalar", "atomic", "vector", "matrix", "array", "record"] as const, `${path}.kind`);
  integer(input.alignment, `${path}.alignment`, 1);
  if (kind === "array") {
    exact(input, ["kind", "element", "count", "stride", "alignment", "byteSize"], path);
    const element = typeLayout(input.element, `${path}.element`, depth + 1);
    const count = nullableInteger(input.count, `${path}.count`);
    const stride = integer(input.stride, `${path}.stride`, 1);
    const byteSize = nullableInteger(input.byteSize, `${path}.byteSize`);
    if (input.alignment !== element.alignment || stride % element.alignment !== 0
      || element.byteSize === null || stride < element.byteSize
      || (count === null ? byteSize !== null : byteSize !== count * stride)) {
      throw new TypeError(`${path} has inconsistent array layout algebra.`);
    }
  } else if (kind === "record") {
    exact(input, ["kind", "recordName", "alignment", "byteSize"], path);
    wgslIdentifier(input.recordName, `${path}.recordName`);
    nullableInteger(input.byteSize, `${path}.byteSize`);
  } else {
    integer(input.byteSize, `${path}.byteSize`, 1);
    if (kind === "scalar") {
      exact(input, ["kind", "scalar", "alignment", "byteSize"], path);
      enumeration(input.scalar, ["i32", "u32", "f32", "f16", "bool"] as const, `${path}.scalar`);
      const size = input.scalar === "f16" ? 2 : 4;
      if (input.alignment !== size || input.byteSize !== size) throw new TypeError(`${path} has inconsistent scalar layout.`);
    } else if (kind === "atomic") {
      exact(input, ["kind", "scalar", "alignment", "byteSize"], path);
      enumeration(input.scalar, ["i32", "u32"] as const, `${path}.scalar`);
      if (input.alignment !== 4 || input.byteSize !== 4) throw new TypeError(`${path} has inconsistent atomic layout.`);
    } else if (kind === "vector") {
      exact(input, ["kind", "scalar", "width", "alignment", "byteSize"], path);
      enumeration(input.scalar, ["i32", "u32", "f32", "f16", "bool"] as const, `${path}.scalar`);
      const width = enumeration(input.width, [2, 3, 4] as const, `${path}.width`);
      const scalarSize = input.scalar === "f16" ? 2 : 4;
      if (input.alignment !== (width === 2 ? 2 : 4) * scalarSize || input.byteSize !== width * scalarSize) throw new TypeError(`${path} has inconsistent vector layout.`);
    } else {
      exact(input, ["kind", "scalar", "columns", "rows", "columnStride", "alignment", "byteSize"], path);
      enumeration(input.scalar, ["f32", "f16"] as const, `${path}.scalar`);
      const columns = enumeration(input.columns, [2, 3, 4] as const, `${path}.columns`);
      const rows = enumeration(input.rows, [2, 3, 4] as const, `${path}.rows`);
      const stride = integer(input.columnStride, `${path}.columnStride`, 1);
      const scalarSize = input.scalar === "f16" ? 2 : 4;
      const alignment = (rows === 2 ? 2 : 4) * scalarSize;
      if (input.alignment !== alignment || stride !== Math.ceil((rows * scalarSize) / alignment) * alignment || input.byteSize !== columns * stride) throw new TypeError(`${path} has inconsistent matrix layout.`);
    }
  }
  return input as unknown as GpuTypeLayout;
}

function recordLayout(value: unknown, path: string): GpuRecordLayout {
  const input = object(value, path);
  exact(input, ["name", "alignment", "byteSize", "minimumByteSize", "runtimeArrayMember", "addressSpaces", "members"], path);
  wgslIdentifier(input.name, `${path}.name`);
  integer(input.alignment, `${path}.alignment`, 1);
  nullableInteger(input.byteSize, `${path}.byteSize`);
  integer(input.minimumByteSize, `${path}.minimumByteSize`);
  nullableIdentifier(input.runtimeArrayMember, `${path}.runtimeArrayMember`);
  const spaces = array(input.addressSpaces, `${path}.addressSpaces`, 5).map((space, index) =>
    enumeration(space, ["uniform", "storage", "function", "private", "workgroup"] as const, `${path}.addressSpaces[${index}]`));
  unique(spaces, String, `${path}.addressSpaces`);
  const members = array(input.members, `${path}.members`);
  let priorEnd = 0;
  const names: string[] = [];
  members.forEach((value, index) => {
    const memberPath = `${path}.members[${index}]`;
    const member = object(value, memberPath);
    exact(member, ["name", "offset", "alignment", "valueByteSize", "occupiedByteSize", "explicitAlign", "explicitSize", "type"], memberPath);
    names.push(wgslIdentifier(member.name, `${memberPath}.name`));
    const offset = integer(member.offset, `${memberPath}.offset`);
    const alignment = integer(member.alignment, `${memberPath}.alignment`, 1);
    const valueSize = nullableInteger(member.valueByteSize, `${memberPath}.valueByteSize`);
    const occupied = nullableInteger(member.occupiedByteSize, `${memberPath}.occupiedByteSize`);
    const explicitAlign = member.explicitAlign === null ? null : integer(member.explicitAlign, `${memberPath}.explicitAlign`, 1);
    const explicitSize = member.explicitSize === null ? null : integer(member.explicitSize, `${memberPath}.explicitSize`, 1);
    const type = typeLayout(member.type, `${memberPath}.type`);
    if (explicitAlign !== null && ((explicitAlign & (explicitAlign - 1)) !== 0 || explicitAlign < type.alignment)) {
      throw new TypeError(`${memberPath}.explicitAlign must be a power of two no smaller than the natural alignment.`);
    }
    if (explicitSize !== null && (type.byteSize === null || explicitSize < type.byteSize)) {
      throw new TypeError(`${memberPath}.explicitSize must not shrink a fixed-size WGSL type.`);
    }
    if (offset < priorEnd || offset % alignment !== 0 || alignment !== (explicitAlign ?? type.alignment)
      || valueSize !== type.byteSize || occupied !== (explicitSize ?? type.byteSize)
      || (occupied !== null && valueSize !== null && occupied < valueSize)) {
      throw new TypeError(`${memberPath} has inconsistent member layout algebra.`);
    }
    if (occupied === null && index !== members.length - 1) throw new TypeError(`${memberPath} is a non-final runtime array.`);
    if (occupied !== null) priorEnd = offset + occupied;
  });
  unique(names, String, `${path}.members`);
  if ((input.byteSize === null) !== (input.runtimeArrayMember !== null)) throw new TypeError(`${path} has inconsistent runtime array metadata.`);
  const maximumAlignment = Math.max(1, ...members.map((value) => Number((value as UnknownRecord).alignment)));
  if (input.alignment !== maximumAlignment) throw new TypeError(`${path}.alignment is inconsistent with its members.`);
  const tail = members.at(-1) as UnknownRecord | undefined;
  const expectedMinimum = input.runtimeArrayMember === null
    ? Math.ceil(priorEnd / Number(input.alignment)) * Number(input.alignment)
    : Number(tail?.offset ?? 0);
  if (input.minimumByteSize !== expectedMinimum || (input.byteSize !== null && input.byteSize !== expectedMinimum)
    || (input.runtimeArrayMember !== null && tail?.name !== input.runtimeArrayMember)) {
    throw new TypeError(`${path} has inconsistent fixed/runtime size metadata.`);
  }
  if (input.runtimeArrayMember !== null) {
    const tailType = tail?.type as GpuTypeLayout | undefined;
    if (!tailType || tailType.kind !== "array" || tailType.count !== null) throw new TypeError(`${path}.runtimeArrayMember must name a direct trailing runtime-sized array.`);
  }
  return input as unknown as GpuRecordLayout;
}

function bindingResource(value: unknown, path: string): GpuBindingResourceLayout {
  const input = object(value, path);
  const kind = enumeration(input.kind, ["buffer", "sampler", "texture", "storage-texture", "external-texture"] as const, `${path}.kind`);
  if (kind === "buffer") {
    exact(input, ["kind", "addressSpace", "access", "recordName", "minimumBindingSize"], path);
    enumeration(input.addressSpace, ["uniform", "storage"] as const, `${path}.addressSpace`);
    enumeration(input.access, ["read", "write", "read_write"] as const, `${path}.access`);
    if (input.addressSpace === "uniform" && input.access !== "read") throw new TypeError(`${path}.access must be read for uniform buffers.`);
    nullableIdentifier(input.recordName, `${path}.recordName`);
    integer(input.minimumBindingSize, `${path}.minimumBindingSize`);
  } else if (kind === "sampler") {
    exact(input, ["kind", "samplerType"], path);
    enumeration(input.samplerType, ["filtering", "non-filtering", "comparison"] as const, `${path}.samplerType`);
  } else if (kind === "texture") {
    exact(input, ["kind", "sampleType", "viewDimension", "multisampled"], path);
    enumeration(input.sampleType, ["float", "unfilterable-float", "depth", "sint", "uint"] as const, `${path}.sampleType`);
    enumeration(input.viewDimension, ["1d", "2d", "2d-array", "cube", "cube-array", "3d"] as const, `${path}.viewDimension`);
    if (typeof input.multisampled !== "boolean") throw new TypeError(`${path}.multisampled must be boolean.`);
  } else if (kind === "storage-texture") {
    exact(input, ["kind", "access", "format", "viewDimension"], path);
    enumeration(input.access, ["write-only", "read-only", "read-write"] as const, `${path}.access`);
    token(input.format, `${path}.format`);
    enumeration(input.viewDimension, ["1d", "2d", "2d-array", "3d"] as const, `${path}.viewDimension`);
  } else exact(input, ["kind"], path);
  return input as unknown as GpuBindingResourceLayout;
}

function visibility(value: unknown, path: string): (typeof stages)[number][] {
  const result = array(value, path, 3).map((item, index) => enumeration(item, stages, `${path}[${index}]`));
  unique(result, String, path);
  if (result.length === 0) throw new TypeError(`${path} must include at least one shader stage.`);
  return result;
}

function binding(value: unknown, path: string, coordinates = true): UnknownRecord {
  const input = object(value, path);
  exact(input, coordinates
    ? ["moduleId", "variableName", "group", "binding", "resource", "visibility"]
    : ["source", "resource", "semantic"], path);
  if (coordinates) {
    token(input.moduleId, `${path}.moduleId`); wgslIdentifier(input.variableName, `${path}.variableName`);
    integer(input.group, `${path}.group`); integer(input.binding, `${path}.binding`);
    visibility(input.visibility, `${path}.visibility`);
  } else {
    const source = object(input.source, `${path}.source`); exact(source, ["moduleId", "group", "binding"], `${path}.source`);
    token(source.moduleId, `${path}.source.moduleId`); integer(source.group, `${path}.source.group`); integer(source.binding, `${path}.source.binding`);
    nullableToken(input.semantic, `${path}.semantic`);
  }
  bindingResource(input.resource, `${path}.resource`);
  return input;
}

function entryIo(value: unknown, path: string): UnknownRecord {
  const input = object(value, path);
  exact(input, ["name", "locationKind", "location", "interpolation", "type"], path);
  wgslIdentifier(input.name, `${path}.name`);
  const kind = enumeration(input.locationKind, ["location", "builtin"] as const, `${path}.locationKind`);
  if (kind === "location") integer(input.location, `${path}.location`); else token(input.location, `${path}.location`);
  if (input.interpolation !== null) token(input.interpolation, `${path}.interpolation`);
  typeLayout(input.type, `${path}.type`);
  return input;
}

function vertexInput(value: unknown, path: string, model = false): UnknownRecord {
  const input = object(value, path);
  if (model) {
    exact(input, ["source", "format", "offset", "arrayStride", "stepMode", "semantic"], path);
    const source = object(input.source, `${path}.source`); exact(source, ["pipelineId", "shaderLocation"], `${path}.source`);
    token(source.pipelineId, `${path}.source.pipelineId`); integer(source.shaderLocation, `${path}.source.shaderLocation`);
    token(input.semantic, `${path}.semantic`);
  } else {
    exact(input, ["pipelineId", "moduleId", "entryPoint", "shaderLocation", "shaderType", "bufferSlot", "format", "offset", "arrayStride", "stepMode", "semantic"], path);
    token(input.pipelineId, `${path}.pipelineId`); token(input.moduleId, `${path}.moduleId`); wgslIdentifier(input.entryPoint, `${path}.entryPoint`);
    integer(input.shaderLocation, `${path}.shaderLocation`); typeLayout(input.shaderType, `${path}.shaderType`); integer(input.bufferSlot, `${path}.bufferSlot`);
    nullableToken(input.semantic, `${path}.semantic`);
  }
  token(input.format, `${path}.format`); integer(input.offset, `${path}.offset`); integer(input.arrayStride, `${path}.arrayStride`);
  enumeration(input.stepMode, ["vertex", "instance"] as const, `${path}.stepMode`);
  return input;
}

function semantic(value: unknown, path: string): UnknownRecord {
  const input = object(value, path); exact(input, ["semantic", "source"], path); token(input.semantic, `${path}.semantic`);
  const source = object(input.source, `${path}.source`);
  const kind = enumeration(source.kind, ["record-member", "vertex-attribute", "binding"] as const, `${path}.source.kind`);
  if (kind === "record-member") {
    exact(source, ["kind", "recordName", "memberPath"], `${path}.source`); wgslIdentifier(source.recordName, `${path}.source.recordName`);
    identifierArray(source.memberPath, `${path}.source.memberPath`, 24);
  } else if (kind === "vertex-attribute") {
    exact(source, ["kind", "pipelineId", "shaderLocation"], `${path}.source`); token(source.pipelineId, `${path}.source.pipelineId`); integer(source.shaderLocation, `${path}.source.shaderLocation`);
  } else {
    exact(source, ["kind", "moduleId", "group", "binding"], `${path}.source`); token(source.moduleId, `${path}.source.moduleId`);
    integer(source.group, `${path}.source.group`); integer(source.binding, `${path}.source.binding`);
  }
  return input;
}

function interfaceRef(value: unknown, path: string): UnknownRecord {
  const input = object(value, path); exact(input, ["interfaceId", "interfaceVersion", "manifestUri", "manifestSha256", "interfaceAbiHash", "modelAbiHash"], path);
  token(input.interfaceId, `${path}.interfaceId`); immutableVersion(input.interfaceVersion, `${path}.interfaceVersion`); uri(input.manifestUri, `${path}.manifestUri`);
  digest(input.manifestSha256, `${path}.manifestSha256`); digest(input.interfaceAbiHash, `${path}.interfaceAbiHash`); digest(input.modelAbiHash, `${path}.modelAbiHash`);
  return input;
}

function programmable(value: unknown, path: string, moduleIds: ReadonlySet<string>): UnknownRecord {
  const input = object(value, path); exact(input, ["moduleId", "entryPoint", "constants"], path);
  const moduleId = token(input.moduleId, `${path}.moduleId`); if (!moduleIds.has(moduleId)) throw new TypeError(`${path}.moduleId is not in modules.`);
  wgslIdentifier(input.entryPoint, `${path}.entryPoint`);
  const constants = object(input.constants, `${path}.constants`);
  for (const [name, value] of Object.entries(constants)) { if (!/^[0-9]+$/u.test(name)) wgslIdentifier(name, `${path}.constants key`); if (typeof value !== "boolean") finite(value, `${path}.constants.${name}`); }
  return input;
}

function pipeline(value: unknown, path: string, moduleIds: ReadonlySet<string>): SerializableGpuPipelineDescriptor {
  const input = object(value, path); const kind = enumeration(input.kind, ["compute", "render"] as const, `${path}.kind`);
  const common = kind === "compute" ? ["kind", "pipelineId", "layout", "compute"] : ["kind", "pipelineId", "layout", "vertex", "fragment", "vertexBuffers", "primitive", "colorTargets", "depthStencil", "multisample"];
  exact(input, common, path); token(input.pipelineId, `${path}.pipelineId`);
  const layout = object(input.layout, `${path}.layout`); exact(layout, ["bindGroups"], `${path}.layout`);
  const groups = array(layout.bindGroups, `${path}.layout.bindGroups`);
  const groupIds: number[] = [];
  groups.forEach((value, groupIndex) => {
    const groupPath = `${path}.layout.bindGroups[${groupIndex}]`; const group = object(value, groupPath); exact(group, ["group", "entries"], groupPath);
    const groupId = integer(group.group, `${groupPath}.group`); groupIds.push(groupId);
    const entries = array(group.entries, `${groupPath}.entries`); const bindingIds: number[] = [];
    entries.forEach((entryValue, entryIndex) => {
      const entryPath = `${groupPath}.entries[${entryIndex}]`; const entry = object(entryValue, entryPath);
      exact(entry, ["group", "binding", "resource", "visibility"], entryPath);
      if (integer(entry.group, `${entryPath}.group`) !== groupId) throw new TypeError(`${entryPath}.group differs from its parent.`);
      bindingIds.push(integer(entry.binding, `${entryPath}.binding`)); bindingResource(entry.resource, `${entryPath}.resource`); visibility(entry.visibility, `${entryPath}.visibility`);
    });
    unique(bindingIds, String, `${groupPath}.entries`);
  });
  unique(groupIds, String, `${path}.layout.bindGroups`);
  [...groupIds].sort((a, b) => a - b).forEach((group, index) => { if (group !== index) throw new TypeError(`${path}.layout.bindGroups must be contiguous from zero.`); });
  if (kind === "compute") programmable(input.compute, `${path}.compute`, moduleIds);
  else {
    programmable(input.vertex, `${path}.vertex`, moduleIds); if (input.fragment !== null) programmable(input.fragment, `${path}.fragment`, moduleIds);
    array(input.vertexBuffers, `${path}.vertexBuffers`, 16).forEach((value, bufferIndex) => {
      const bufferPath = `${path}.vertexBuffers[${bufferIndex}]`; const buffer = object(value, bufferPath); exact(buffer, ["arrayStride", "stepMode", "attributes"], bufferPath);
      integer(buffer.arrayStride, `${bufferPath}.arrayStride`, 0, 2048); enumeration(buffer.stepMode, ["vertex", "instance"] as const, `${bufferPath}.stepMode`);
      array(buffer.attributes, `${bufferPath}.attributes`, 16).forEach((value, attributeIndex) => {
        const attributePath = `${bufferPath}.attributes[${attributeIndex}]`; const attribute = object(value, attributePath); exact(attribute, ["format", "offset", "shaderLocation", "semantic"], attributePath);
        token(attribute.format, `${attributePath}.format`); integer(attribute.offset, `${attributePath}.offset`); integer(attribute.shaderLocation, `${attributePath}.shaderLocation`); nullableToken(attribute.semantic, `${attributePath}.semantic`);
      });
    });
    const primitive = object(input.primitive, `${path}.primitive`); exact(primitive, ["topology", "stripIndexFormat", "frontFace", "cullMode", "unclippedDepth"], `${path}.primitive`);
    const topology = enumeration(primitive.topology, ["point-list", "line-list", "line-strip", "triangle-list", "triangle-strip"] as const, `${path}.primitive.topology`);
    if (primitive.stripIndexFormat !== null) enumeration(primitive.stripIndexFormat, ["uint16", "uint32"] as const, `${path}.primitive.stripIndexFormat`);
    if (primitive.stripIndexFormat !== null && topology !== "line-strip" && topology !== "triangle-strip") throw new TypeError(`${path}.primitive.stripIndexFormat is only valid for strip topologies.`);
    enumeration(primitive.frontFace, ["ccw", "cw"] as const, `${path}.primitive.frontFace`); enumeration(primitive.cullMode, ["none", "front", "back"] as const, `${path}.primitive.cullMode`); if (typeof primitive.unclippedDepth !== "boolean") throw new TypeError(`${path}.primitive.unclippedDepth must be boolean.`);
    const compare = ["never", "less", "equal", "less-equal", "greater", "not-equal", "greater-equal", "always"] as const;
    const operations = ["keep", "zero", "replace", "invert", "increment-clamp", "decrement-clamp", "increment-wrap", "decrement-wrap"] as const;
    const factors = ["zero", "one", "src", "one-minus-src", "src-alpha", "one-minus-src-alpha", "dst", "one-minus-dst", "dst-alpha", "one-minus-dst-alpha", "src-alpha-saturated", "constant", "one-minus-constant"] as const;
    const parseBlend = (value: unknown, label: string): void => { const component = object(value, label); exact(component, ["operation", "srcFactor", "dstFactor"], label); enumeration(component.operation, ["add", "subtract", "reverse-subtract", "min", "max"] as const, `${label}.operation`); enumeration(component.srcFactor, factors, `${label}.srcFactor`); enumeration(component.dstFactor, factors, `${label}.dstFactor`); };
    const colorTargets = array(input.colorTargets, `${path}.colorTargets`, 8); if (input.fragment === null && colorTargets.length !== 0) throw new TypeError(`${path}.colorTargets must be empty when fragment is null.`); colorTargets.forEach((value, index) => { const label = `${path}.colorTargets[${index}]`; const target = object(value, label); exact(target, ["format", "blend", "writeMask"], label); token(target.format, `${label}.format`); integer(target.writeMask, `${label}.writeMask`, 0, 15); if (target.blend !== null) { const blend = object(target.blend, `${label}.blend`); exact(blend, ["color", "alpha"], `${label}.blend`); parseBlend(blend.color, `${label}.blend.color`); parseBlend(blend.alpha, `${label}.blend.alpha`); } });
    const parseStencil = (value: unknown, label: string): void => { const stencil = object(value, label); exact(stencil, ["compare", "failOp", "depthFailOp", "passOp"], label); enumeration(stencil.compare, compare, `${label}.compare`); enumeration(stencil.failOp, operations, `${label}.failOp`); enumeration(stencil.depthFailOp, operations, `${label}.depthFailOp`); enumeration(stencil.passOp, operations, `${label}.passOp`); };
    if (input.depthStencil !== null) { const depth = object(input.depthStencil, `${path}.depthStencil`); exact(depth, ["format", "depthWriteEnabled", "depthCompare", "stencilFront", "stencilBack", "stencilReadMask", "stencilWriteMask", "depthBias", "depthBiasSlopeScale", "depthBiasClamp"], `${path}.depthStencil`); token(depth.format, `${path}.depthStencil.format`); if (typeof depth.depthWriteEnabled !== "boolean") throw new TypeError(`${path}.depthStencil.depthWriteEnabled must be boolean.`); enumeration(depth.depthCompare, compare, `${path}.depthStencil.depthCompare`); parseStencil(depth.stencilFront, `${path}.depthStencil.stencilFront`); parseStencil(depth.stencilBack, `${path}.depthStencil.stencilBack`); integer(depth.stencilReadMask, `${path}.depthStencil.stencilReadMask`); integer(depth.stencilWriteMask, `${path}.depthStencil.stencilWriteMask`); integer(depth.depthBias, `${path}.depthStencil.depthBias`, -0x8000_0000, 0x7fff_ffff); finite(depth.depthBiasSlopeScale, `${path}.depthStencil.depthBiasSlopeScale`); finite(depth.depthBiasClamp, `${path}.depthStencil.depthBiasClamp`); }
    const multisample = object(input.multisample, `${path}.multisample`); exact(multisample, ["count", "mask", "alphaToCoverageEnabled"], `${path}.multisample`); enumeration(multisample.count, [1, 4] as const, `${path}.multisample.count`); integer(multisample.mask, `${path}.multisample.mask`); if (typeof multisample.alphaToCoverageEnabled !== "boolean") throw new TypeError(`${path}.multisample.alphaToCoverageEnabled must be boolean.`); if (multisample.alphaToCoverageEnabled && multisample.count === 1) throw new TypeError(`${path}.multisample.alphaToCoverageEnabled requires multisampling.`);
  }
  return input as unknown as SerializableGpuPipelineDescriptor;
}

export function parseSerializableGpuPipelineDescriptors(
  value: unknown,
  moduleIds: readonly string[],
  path = "pipelines",
): readonly SerializableGpuPipelineDescriptor[] {
  const parsed = array(detachedJson(value, path), path).map((item, index) => pipeline(item, `${path}[${index}]`, new Set(moduleIds)));
  unique(parsed, (item) => item.pipelineId, path);
  return freeze(parsed);
}

function compatibleModel(value: unknown, path: string): UnknownRecord {
  const input = object(value, path); exact(input, ["interfaceId", "interfaceVersion", "manifestSha256", "interfaceAbiHash", "modelAbiHash"], path);
  token(input.interfaceId, `${path}.interfaceId`); immutableVersion(input.interfaceVersion, `${path}.interfaceVersion`); digest(input.manifestSha256, `${path}.manifestSha256`); digest(input.interfaceAbiHash, `${path}.interfaceAbiHash`); digest(input.modelAbiHash, `${path}.modelAbiHash`); return input;
}

function validationEvidenceRef(value: unknown, path: string): UnknownRecord {
  const evidence = object(value, path);
  exact(evidence, ["evidenceId", "uri", "sha256", "matrixId", "matrixVersion", "matrixSha256", "attestationRef"], path);
  token(evidence.evidenceId, `${path}.evidenceId`);
  uri(evidence.uri, `${path}.uri`);
  digest(evidence.sha256, `${path}.sha256`);
  token(evidence.matrixId, `${path}.matrixId`);
  immutableVersion(evidence.matrixVersion, `${path}.matrixVersion`);
  digest(evidence.matrixSha256, `${path}.matrixSha256`);
  const attestation = object(evidence.attestationRef, `${path}.attestationRef`);
  exact(attestation, ["uri", "sha256"], `${path}.attestationRef`);
  uri(attestation.uri, `${path}.attestationRef.uri`);
  digest(attestation.sha256, `${path}.attestationRef.sha256`);
  if (evidence.uri === attestation.uri || evidence.sha256 === attestation.sha256) {
    throw new TypeError(`${path} evidence and attestation artifacts must have distinct URIs and digests.`);
  }
  return evidence;
}

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return Object.freeze(value);
}

function reflectedRecordBindingSize(record: GpuRecordLayout): number {
  if (record.byteSize !== null) return record.byteSize;
  if (record.runtimeArrayMember === null) throw new TypeError(`Record ${record.name} has inconsistent runtime-array metadata.`);
  const member = record.members.find((candidate) => candidate.name === record.runtimeArrayMember);
  if (!member || member.type.kind !== "array" || member.type.count !== null) {
    throw new TypeError(`Record ${record.name} has invalid trailing runtime-array metadata.`);
  }
  const unrounded = member.offset + member.type.stride;
  return Math.ceil(unrounded / record.alignment) * record.alignment;
}

/** Strictly parses untrusted reflected interface JSON and validates all nested references. */
export function parseGpuInterfaceManifest(value: unknown): GpuInterfaceManifest {
  const input = object(detachedJson(value, "GpuInterfaceManifest"), "GpuInterfaceManifest");
  exact(input, ["contractVersion", "interfaceId", "interfaceVersion", "modules", "records", "bindings", "entryPoints", "vertexInputs", "overrides", "modelAbi", "modelAbiHash", "interfaceAbiHash", "generatedBy"], "GpuInterfaceManifest");
  if (input.contractVersion !== GPU_INTERFACE_MANIFEST_VERSION) throw new TypeError("Unsupported GPU interface contract version.");
  token(input.interfaceId, "GpuInterfaceManifest.interfaceId"); immutableVersion(input.interfaceVersion, "GpuInterfaceManifest.interfaceVersion");
  const moduleValues = array(input.modules, "GpuInterfaceManifest.modules");
  if (moduleValues.length === 0) throw new TypeError("GpuInterfaceManifest.modules must not be empty.");
  const moduleIds = moduleValues.map((value, index) => { const path = `GpuInterfaceManifest.modules[${index}]`; const module = object(value, path); exact(module, ["moduleId", "sha256"], path); digest(module.sha256, `${path}.sha256`); return token(module.moduleId, `${path}.moduleId`); });
  unique(moduleIds, String, "GpuInterfaceManifest.modules"); const moduleSet = new Set(moduleIds);
  const recordValues = array(input.records, "GpuInterfaceManifest.records"); const parsedRecords = recordValues.map((item, index) => recordLayout(item, `GpuInterfaceManifest.records[${index}]`));
  unique(parsedRecords, (item) => item.name, "GpuInterfaceManifest.records"); const records = new Map(parsedRecords.map((item) => [item.name, item]));
  for (const record of parsedRecords) for (const member of record.members) {
    const visit = (type: GpuTypeLayout): void => { if (type.kind === "record") { const referenced = records.get(type.recordName); if (!referenced) throw new TypeError(`Record ${record.name} references missing ${type.recordName}.`); if (type.alignment !== referenced.alignment || type.byteSize !== referenced.byteSize) throw new TypeError(`Record reference ${record.name}.${member.name} has stale layout metadata.`); } if (type.kind === "array") visit(type.element); };
    visit(member.type);
  }
  const bindingValues = array(input.bindings, "GpuInterfaceManifest.bindings"); const bindingKeys: string[] = [];
  bindingValues.forEach((item, index) => { const path = `GpuInterfaceManifest.bindings[${index}]`; const parsed = binding(item, path); const moduleId = String(parsed.moduleId); if (!moduleSet.has(moduleId)) throw new TypeError(`${path}.moduleId is missing.`); bindingKeys.push(`${moduleId}:${parsed.group}:${parsed.binding}`); const resource = parsed.resource as GpuBindingResourceLayout; if (resource.kind === "buffer" && resource.recordName) { const record = records.get(resource.recordName); if (!record) throw new TypeError(`${path} references missing record.`); if (resource.minimumBindingSize !== reflectedRecordBindingSize(record)) throw new TypeError(`${path}.resource.minimumBindingSize differs from its reflected record.`); if (record.runtimeArrayMember !== null && resource.addressSpace !== "storage") throw new TypeError(`${path} exposes a runtime-sized array outside storage.`); } });
  unique(bindingKeys, String, "GpuInterfaceManifest.bindings"); const bindingSet = new Set(bindingKeys);
  const overrideValues = array(input.overrides, "GpuInterfaceManifest.overrides"); const overrideKeys: string[] = []; const overrideIds: string[] = [];
  overrideValues.forEach((item, index) => { const path = `GpuInterfaceManifest.overrides[${index}]`; const override = object(item, path); exact(override, ["moduleId", "name", "id", "type", "defaultValue"], path); const moduleId = token(override.moduleId, `${path}.moduleId`); if (!moduleSet.has(moduleId)) throw new TypeError(`${path}.moduleId is missing.`); const name = wgslIdentifier(override.name, `${path}.name`); overrideKeys.push(`${moduleId}:${name}`); if (override.id !== null) overrideIds.push(`${moduleId}:${integer(override.id, `${path}.id`)}`); enumeration(override.type, ["bool", "i32", "u32", "f32", "f16"] as const, `${path}.type`); if (override.defaultValue !== null && typeof override.defaultValue !== "boolean") finite(override.defaultValue, `${path}.defaultValue`); });
  unique(overrideKeys, String, "GpuInterfaceManifest.overrides"); unique(overrideIds, String, "GpuInterfaceManifest.overrides ids"); const overrideSet = new Set(overrideKeys);
  const entryValues = array(input.entryPoints, "GpuInterfaceManifest.entryPoints"); const entryKeys: string[] = [];
  if (entryValues.length === 0) throw new TypeError("GpuInterfaceManifest.entryPoints must not be empty.");
  entryValues.forEach((item, index) => { const path = `GpuInterfaceManifest.entryPoints[${index}]`; const entry = object(item, path); exact(entry, ["moduleId", "name", "stage", "inputs", "outputs", "bindingKeys", "overrideNames", "workgroupSize", "workgroupStorageSize"], path); const moduleId = token(entry.moduleId, `${path}.moduleId`); if (!moduleSet.has(moduleId)) throw new TypeError(`${path}.moduleId is missing.`); const stage = enumeration(entry.stage, stages, `${path}.stage`); entryKeys.push(`${moduleId}:${stage}:${wgslIdentifier(entry.name, `${path}.name`)}`); for (const ioKey of ["inputs", "outputs"] as const) { const ios = array(entry[ioKey], `${path}.${ioKey}`).map((value, ioIndex) => entryIo(value, `${path}.${ioKey}[${ioIndex}]`)); unique(ios, (io) => `${io.locationKind}:${io.location}`, `${path}.${ioKey}`); } const resources = tokenArray(entry.bindingKeys, `${path}.bindingKeys`); resources.forEach((key) => { if (!bindingSet.has(key)) throw new TypeError(`${path}.bindingKeys references missing ${key}.`); }); const names = identifierArray(entry.overrideNames, `${path}.overrideNames`); names.forEach((name) => { if (!overrideSet.has(`${moduleId}:${name}`)) throw new TypeError(`${path}.overrideNames references missing ${name}.`); }); if (stage === "compute") { const dimensions = array(entry.workgroupSize, `${path}.workgroupSize`, 3); if (dimensions.length !== 3) throw new TypeError(`${path}.workgroupSize must have three dimensions.`); dimensions.forEach((value, dimensionIndex) => { const dimensionPath = `${path}.workgroupSize[${dimensionIndex}]`; const dimension = object(value, dimensionPath); const kind = enumeration(dimension.kind, ["literal", "override"] as const, `${dimensionPath}.kind`); if (kind === "literal") { exact(dimension, ["kind", "value"], dimensionPath); integer(dimension.value, `${dimensionPath}.value`, 1); } else { exact(dimension, ["kind", "name"], dimensionPath); const name = wgslIdentifier(dimension.name, `${dimensionPath}.name`); if (!overrideSet.has(`${moduleId}:${name}`)) throw new TypeError(`${dimensionPath} references missing override.`); } }); integer(entry.workgroupStorageSize, `${path}.workgroupStorageSize`); } else if (entry.workgroupSize !== null || entry.workgroupStorageSize !== null) throw new TypeError(`${path} workgroup metadata is only valid for compute.`); });
  unique(entryKeys, String, "GpuInterfaceManifest.entryPoints"); const entrySet = new Set(entryKeys);
  const vertexValues = array(input.vertexInputs, "GpuInterfaceManifest.vertexInputs"); const vertexKeys: string[] = []; const parsedVertices: UnknownRecord[] = [];
  vertexValues.forEach((item, index) => { const path = `GpuInterfaceManifest.vertexInputs[${index}]`; const vertex = vertexInput(item, path); parsedVertices.push(vertex); if (!entrySet.has(`${vertex.moduleId}:vertex:${vertex.entryPoint}`)) throw new TypeError(`${path} references missing vertex entry point.`); vertexKeys.push(`${vertex.pipelineId}:${vertex.shaderLocation}`); }); unique(vertexKeys, String, "GpuInterfaceManifest.vertexInputs");
  const model = object(input.modelAbi, "GpuInterfaceManifest.modelAbi"); exact(model, ["recordNames", "bindings", "vertexInputs", "semantics"], "GpuInterfaceManifest.modelAbi");
  identifierArray(model.recordNames, "GpuInterfaceManifest.modelAbi.recordNames").forEach((name) => { if (!records.has(name)) throw new TypeError(`Model ABI references missing record ${name}.`); });
  const modelBindings = array(model.bindings, "GpuInterfaceManifest.modelAbi.bindings").map((item, index) => binding(item, `GpuInterfaceManifest.modelAbi.bindings[${index}]`, false));
  for (const [index, projected] of modelBindings.entries()) { const source = projected.source as UnknownRecord; const reflectedIndex = bindingKeys.indexOf(`${source.moduleId}:${source.group}:${source.binding}`); const reflected = reflectedIndex < 0 ? null : object(bindingValues[reflectedIndex], `GpuInterfaceManifest.bindings[${reflectedIndex}]`); if (!reflected || canonicalizeForValidation(reflected.resource) !== canonicalizeForValidation(projected.resource)) throw new TypeError(`GpuInterfaceManifest.modelAbi.bindings[${index}] differs from its reflected source.`); const resource = projected.resource as GpuBindingResourceLayout; if (resource.kind === "buffer" && resource.recordName === null) throw new TypeError(`GpuInterfaceManifest.modelAbi.bindings[${index}] must use a named WGSL record root.`); }
  const modelBindingSemantics = modelBindings.filter((item) => item.semantic !== null).map((item) => String(item.semantic)); unique(modelBindingSemantics, String, "GpuInterfaceManifest.modelAbi.bindings semantics");
  const modelVertices = array(model.vertexInputs, "GpuInterfaceManifest.modelAbi.vertexInputs"); const parsedModelVertices = modelVertices.map((item, index) => vertexInput(item, `GpuInterfaceManifest.modelAbi.vertexInputs[${index}]`, true)); const modelVertexSemantics = parsedModelVertices.map((item) => String(item.semantic)); unique(modelVertexSemantics, String, "GpuInterfaceManifest.modelAbi.vertexInputs");
  for (const [index, projected] of parsedModelVertices.entries()) { const source = projected.source as UnknownRecord; const reflected = parsedVertices.find((candidate) => candidate.pipelineId === source.pipelineId && candidate.shaderLocation === source.shaderLocation); if (!reflected || ["format", "offset", "arrayStride", "stepMode", "semantic"].some((key) => reflected[key] !== projected[key])) throw new TypeError(`GpuInterfaceManifest.modelAbi.vertexInputs[${index}] differs from its reflected source.`); }
  const semantics = array(model.semantics, "GpuInterfaceManifest.modelAbi.semantics").map((item, index) => semantic(item, `GpuInterfaceManifest.modelAbi.semantics[${index}]`)); unique(semantics, (item) => String(item.semantic), "GpuInterfaceManifest.modelAbi.semantics");
  for (const projection of semantics) {
    const source = projection.source as UnknownRecord; const semanticName = String(projection.semantic);
    if (source.kind === "record-member") {
      let current = records.get(String(source.recordName)); if (!current) throw new TypeError(`Semantic ${semanticName} references missing record.`);
      for (const [index, memberName] of (source.memberPath as string[]).entries()) { const member = current.members.find((candidate) => candidate.name === memberName); if (!member) throw new TypeError(`Semantic ${semanticName} references missing member ${memberName}.`); if (index < (source.memberPath as string[]).length - 1) { if (member.type.kind !== "record") throw new TypeError(`Semantic ${semanticName} traverses a non-record member.`); current = records.get(member.type.recordName); if (!current) throw new TypeError(`Semantic ${semanticName} references missing nested record.`); } }
    } else if (source.kind === "vertex-attribute") {
      const vertex = parsedVertices.find((candidate) => candidate.pipelineId === source.pipelineId && candidate.shaderLocation === source.shaderLocation);
      const modelVertex = parsedModelVertices.find((candidate) => candidate.semantic === semanticName);
      const modelVertexSource = modelVertex?.source as UnknownRecord | undefined;
      if (!vertex || vertex.semantic !== semanticName || modelVertexSemantics.filter((item) => item === semanticName).length !== 1
        || !modelVertexSource || modelVertexSource.pipelineId !== source.pipelineId || modelVertexSource.shaderLocation !== source.shaderLocation) throw new TypeError(`Semantic ${semanticName} does not resolve to exactly one matching model vertex stream.`);
    } else {
      const key = `${source.moduleId}:${source.group}:${source.binding}`; if (!bindingSet.has(key)) throw new TypeError(`Semantic ${semanticName} references missing binding ${key}.`);
      const modelBinding = modelBindings.find((candidate) => candidate.semantic === semanticName);
      if (modelBindingSemantics.filter((item) => item === semanticName).length !== 1 || !modelBinding
        || canonicalizeForValidation(modelBinding.source) !== canonicalizeForValidation({ moduleId: source.moduleId, group: source.group, binding: source.binding })) throw new TypeError(`Semantic ${semanticName} does not resolve to exactly one matching model binding.`);
    }
  }
  for (const semanticName of [...modelVertexSemantics, ...modelBindingSemantics]) if (semantics.filter((item) => item.semantic === semanticName).length !== 1) throw new TypeError(`Model semantic ${semanticName} requires exactly one projection.`);
  digest(input.modelAbiHash, "GpuInterfaceManifest.modelAbiHash"); digest(input.interfaceAbiHash, "GpuInterfaceManifest.interfaceAbiHash");
  const generated = object(input.generatedBy, "GpuInterfaceManifest.generatedBy"); exact(generated, ["packageVersion", "reflector", "reflectorVersion"], "GpuInterfaceManifest.generatedBy"); token(generated.packageVersion, "GpuInterfaceManifest.generatedBy.packageVersion"); if (generated.reflector !== "wgsl_reflect" || generated.reflectorVersion !== "1.5.0") throw new TypeError("Unsupported reflector provenance.");
  return freeze(input as unknown as GpuInterfaceManifest);
}

/** Strictly parses an immutable shader-version manifest. */
export function parseShaderVersionManifest(value: unknown): ShaderVersionManifest {
  const input = object(detachedJson(value, "ShaderVersionManifest"), "ShaderVersionManifest"); exact(input, ["contractVersion", "shaderId", "version", "modules", "gpuInterface", "pipelines", "renderRoles", "compatibleModelInterfaces", "requirements", "shaderAbiHash", "validationEvidence", "additionalValidationEvidence"], "ShaderVersionManifest");
  if (input.contractVersion !== SHADER_VERSION_MANIFEST_VERSION) throw new TypeError("Unsupported shader manifest contract version.");
  token(input.shaderId, "ShaderVersionManifest.shaderId"); immutableVersion(input.version, "ShaderVersionManifest.version");
  const moduleValues = array(input.modules, "ShaderVersionManifest.modules"); if (moduleValues.length === 0) throw new TypeError("ShaderVersionManifest.modules must not be empty."); const moduleIds = moduleValues.map((item, index) => { const path = `ShaderVersionManifest.modules[${index}]`; const module = object(item, path); exact(module, ["moduleId", "uri", "byteLength", "sha256", "contentType"], path); uri(module.uri, `${path}.uri`); integer(module.byteLength, `${path}.byteLength`, 1); digest(module.sha256, `${path}.sha256`); if (module.contentType !== "text/wgsl; charset=utf-8") throw new TypeError(`${path}.contentType is not canonical WGSL.`); return token(module.moduleId, `${path}.moduleId`); }); unique(moduleIds, String, "ShaderVersionManifest.modules"); const moduleSet = new Set(moduleIds);
  const shaderInterface = interfaceRef(input.gpuInterface, "ShaderVersionManifest.gpuInterface");
  const pipelines = array(input.pipelines, "ShaderVersionManifest.pipelines").map((item, index) => pipeline(item, `ShaderVersionManifest.pipelines[${index}]`, moduleSet)); if (pipelines.length === 0) throw new TypeError("ShaderVersionManifest.pipelines must not be empty."); unique(pipelines, (item) => item.pipelineId, "ShaderVersionManifest.pipelines"); const pipelineIds = new Set(pipelines.map((item) => item.pipelineId));
  const roleValues = array(input.renderRoles, "ShaderVersionManifest.renderRoles", 5); if (roleValues.length === 0) throw new TypeError("ShaderVersionManifest.renderRoles must not be empty."); const roleNames: string[] = []; const assigned = new Set<string>(); roleValues.forEach((item, index) => { const path = `ShaderVersionManifest.renderRoles[${index}]`; const role = object(item, path); exact(role, ["role", "pipelineIds"], path); roleNames.push(enumeration(role.role, roles, `${path}.role`)); const ids = tokenArray(role.pipelineIds, `${path}.pipelineIds`); if (ids.length === 0) throw new TypeError(`${path}.pipelineIds must not be empty.`); ids.forEach((id) => { if (!pipelineIds.has(id)) throw new TypeError(`${path} references missing pipeline ${id}.`); assigned.add(id); }); }); unique(roleNames, String, "ShaderVersionManifest.renderRoles"); if (assigned.size !== pipelineIds.size) throw new TypeError("Every pipeline must belong to at least one render role.");
  const compatible = array(input.compatibleModelInterfaces, "ShaderVersionManifest.compatibleModelInterfaces").map((item, index) => compatibleModel(item, `ShaderVersionManifest.compatibleModelInterfaces[${index}]`)); if (compatible.length === 0) throw new TypeError("ShaderVersionManifest.compatibleModelInterfaces must not be empty."); unique(compatible, (item) => `${item.interfaceId}:${item.interfaceVersion}:${item.manifestSha256}:${item.interfaceAbiHash}:${item.modelAbiHash}`, "ShaderVersionManifest.compatibleModelInterfaces"); if (compatible.some((item) => item.modelAbiHash !== shaderInterface.modelAbiHash)) throw new TypeError("ShaderVersionManifest compatible model ABI hashes must equal gpuInterface.modelAbiHash.");
  const requirements = object(input.requirements, "ShaderVersionManifest.requirements"); exact(requirements, ["semantics", "features", "limits", "formats"], "ShaderVersionManifest.requirements"); tokenArray(requirements.semantics, "ShaderVersionManifest.requirements.semantics"); tokenArray(requirements.features, "ShaderVersionManifest.requirements.features"); tokenArray(requirements.formats, "ShaderVersionManifest.requirements.formats"); const limits = array(requirements.limits, "ShaderVersionManifest.requirements.limits"); const limitNames: string[] = []; limits.forEach((item, index) => { const path = `ShaderVersionManifest.requirements.limits[${index}]`; const limit = object(item, path); exact(limit, ["name", "comparator", "value"], path); const name = token(limit.name, `${path}.name`); limitNames.push(name); enumeration(limit.comparator, ["at-least", "at-most"] as const, `${path}.comparator`); const value = finite(limit.value, `${path}.value`); if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${path}.value must be a non-negative safe integer.`); }); unique(limitNames, String, "ShaderVersionManifest.requirements.limits");
  validatePipelineDerivedRequirements({
    requirements: input.requirements as unknown as ShaderVersionManifest["requirements"],
    pipelines,
  });
  digest(input.shaderAbiHash, "ShaderVersionManifest.shaderAbiHash");
  const universalEvidence = validationEvidenceRef(input.validationEvidence, "ShaderVersionManifest.validationEvidence");
  if (!SUPPORTED_STABLE_WEBGPU_MATRIX_POLICIES.some((policy) =>
    universalEvidence.matrixId === policy.matrixId
    && universalEvidence.matrixVersion === policy.matrixVersion
    && universalEvidence.matrixSha256 === policy.matrixSha256)) {
    throw new TypeError("ShaderVersionManifest.validationEvidence is not bound to a supported universal stable-WebGPU matrix policy.");
  }
  const additionalEvidence = array(input.additionalValidationEvidence, "ShaderVersionManifest.additionalValidationEvidence");
  const scopedEvidence = additionalEvidence.map((item, index) => {
    const path = `ShaderVersionManifest.additionalValidationEvidence[${index}]`;
    const scoped = object(item, path);
    exact(scoped, ["scope", "evidence"], path);
    const scope = token(scoped.scope, `${path}.scope`);
    if (scope === "universal") throw new TypeError(`${path}.scope universal is reserved for validationEvidence.`);
    const evidence = validationEvidenceRef(scoped.evidence, `${path}.evidence`);
    if (evidence.matrixSha256 === universalEvidence.matrixSha256) {
      throw new TypeError(`${path}.evidence must use an additive matrix policy, not the universal matrix policy.`);
    }
    return { scope, evidence };
  });
  unique(scopedEvidence, (item) => item.scope, "ShaderVersionManifest.additionalValidationEvidence scopes");
  unique(scopedEvidence, (item) => String(item.evidence.matrixSha256), "ShaderVersionManifest.additionalValidationEvidence matrix policies");
  const evidenceIds = new Set([String(universalEvidence.evidenceId)]);
  const artifactUris = new Set([
    String(universalEvidence.uri),
    String((universalEvidence.attestationRef as UnknownRecord).uri),
  ]);
  const artifactDigests = new Set([
    String(universalEvidence.sha256),
    String((universalEvidence.attestationRef as UnknownRecord).sha256),
  ]);
  for (const [index, item] of scopedEvidence.entries()) {
    const path = `ShaderVersionManifest.additionalValidationEvidence[${index}].evidence`;
    if (evidenceIds.has(String(item.evidence.evidenceId))) throw new TypeError(`${path} reuses a universal or supplemental evidence ID.`);
    evidenceIds.add(String(item.evidence.evidenceId));
    const attestation = item.evidence.attestationRef as UnknownRecord;
    for (const candidate of [item.evidence.uri, attestation.uri]) {
      if (artifactUris.has(String(candidate))) throw new TypeError(`${path} reuses a universal or supplemental evidence/attestation URI.`);
      artifactUris.add(String(candidate));
    }
    for (const candidate of [item.evidence.sha256, attestation.sha256]) {
      if (artifactDigests.has(String(candidate))) throw new TypeError(`${path} reuses a universal or supplemental evidence/attestation digest.`);
      artifactDigests.add(String(candidate));
    }
  }
  for (const [index, item] of scopedEvidence.entries()) if (!SUPPORTED_ADDITIVE_WEBGPU_MATRIX_POLICIES.some((policy) =>
    item.scope === policy.scope
    && item.evidence.matrixId === policy.matrixId
    && item.evidence.matrixVersion === policy.matrixVersion
    && item.evidence.matrixSha256 === policy.matrixSha256)) {
    throw new TypeError(`ShaderVersionManifest.additionalValidationEvidence[${index}].evidence is not bound to a supported additive WebGPU matrix policy.`);
  }
  return freeze(input as unknown as ShaderVersionManifest);
}

/** Strictly parses the cycle-free shader manifest qualified before evidence attachment. */
export function parseShaderVersionManifestCore(value: unknown): ShaderVersionManifestCore {
  const input = object(detachedJson(value, "ShaderVersionManifestCore"), "ShaderVersionManifestCore");
  if ("validationEvidence" in input || "additionalValidationEvidence" in input) {
    throw new TypeError("ShaderVersionManifestCore must not contain validationEvidence or additionalValidationEvidence.");
  }
  const parsed = parseShaderVersionManifest({
    ...input,
    validationEvidence: {
      evidenceId: "pending",
      uri: "https://catalog.invalid/evidence/pending.json",
      sha256: "0".repeat(64),
      matrixId: SUPPORTED_STABLE_WEBGPU_MATRIX_POLICIES[0].matrixId,
      matrixVersion: SUPPORTED_STABLE_WEBGPU_MATRIX_POLICIES[0].matrixVersion,
      matrixSha256: SUPPORTED_STABLE_WEBGPU_MATRIX_POLICIES[0].matrixSha256,
      attestationRef: {
        uri: "https://catalog.invalid/evidence/pending.attestation-ref.json",
        sha256: "1".repeat(64),
      },
    },
    additionalValidationEvidence: [],
  });
  const { validationEvidence, additionalValidationEvidence, ...core } = parsed;
  void validationEvidence;
  void additionalValidationEvidence;
  return freeze(core);
}

/** Strictly parses a rendering-style profile with exact immutable shader references. */
export function parseShaderStyleProfileManifest(value: unknown): ShaderStyleProfileManifest {
  const input = object(detachedJson(value, "ShaderStyleProfileManifest"), "ShaderStyleProfileManifest"); exact(input, ["contractVersion", "profileId", "version", "style", "roles", "compatibleModelInterfaces", "requiredSemantics", "requiredValidationScopes"], "ShaderStyleProfileManifest");
  if (input.contractVersion !== SHADER_STYLE_PROFILE_MANIFEST_VERSION) throw new TypeError("Unsupported style-profile contract version.");
  token(input.profileId, "ShaderStyleProfileManifest.profileId"); immutableVersion(input.version, "ShaderStyleProfileManifest.version"); token(input.style, "ShaderStyleProfileManifest.style");
  const roleValues = array(input.roles, "ShaderStyleProfileManifest.roles", 5); if (roleValues.length === 0) throw new TypeError("ShaderStyleProfileManifest.roles must not be empty."); const roleNames: string[] = []; roleValues.forEach((item, index) => { const path = `ShaderStyleProfileManifest.roles[${index}]`; const role = object(item, path); exact(role, ["role", "shader"], path); roleNames.push(enumeration(role.role, roles, `${path}.role`)); const shader = object(role.shader, `${path}.shader`); exact(shader, ["shaderId", "version", "manifestUri", "manifestSha256"], `${path}.shader`); token(shader.shaderId, `${path}.shader.shaderId`); immutableVersion(shader.version, `${path}.shader.version`); uri(shader.manifestUri, `${path}.shader.manifestUri`); digest(shader.manifestSha256, `${path}.shader.manifestSha256`); }); unique(roleNames, String, "ShaderStyleProfileManifest.roles");
  const compatible = array(input.compatibleModelInterfaces, "ShaderStyleProfileManifest.compatibleModelInterfaces").map((item, index) => compatibleModel(item, `ShaderStyleProfileManifest.compatibleModelInterfaces[${index}]`)); if (compatible.length === 0) throw new TypeError("ShaderStyleProfileManifest.compatibleModelInterfaces must not be empty."); unique(compatible, (item) => `${item.interfaceId}:${item.interfaceVersion}:${item.manifestSha256}:${item.interfaceAbiHash}:${item.modelAbiHash}`, "ShaderStyleProfileManifest.compatibleModelInterfaces"); tokenArray(input.requiredSemantics, "ShaderStyleProfileManifest.requiredSemantics");
  const requiredValidationScopes = array(input.requiredValidationScopes, "ShaderStyleProfileManifest.requiredValidationScopes").map((item, index) => {
    const path = `ShaderStyleProfileManifest.requiredValidationScopes[${index}]`;
    const requirement = object(item, path);
    exact(requirement, ["scope", "matrixId", "matrixVersion", "matrixSha256"], path);
    const scope = token(requirement.scope, `${path}.scope`);
    if (scope === "universal") throw new TypeError(`${path}.scope must not use the reserved universal scope.`);
    token(requirement.matrixId, `${path}.matrixId`);
    immutableVersion(requirement.matrixVersion, `${path}.matrixVersion`);
    const matrixSha256 = digest(requirement.matrixSha256, `${path}.matrixSha256`);
    if (SUPPORTED_STABLE_WEBGPU_MATRIX_POLICIES.some((policy) => policy.matrixSha256 === matrixSha256)) {
      throw new TypeError(`${path} must require an additive matrix policy, not the universal matrix policy.`);
    }
    if (!SUPPORTED_ADDITIVE_WEBGPU_MATRIX_POLICIES.some((policy) =>
      scope === policy.scope
      && requirement.matrixId === policy.matrixId
      && requirement.matrixVersion === policy.matrixVersion
      && matrixSha256 === policy.matrixSha256)) {
      throw new TypeError(`${path} is not a supported additive WebGPU matrix policy.`);
    }
    return requirement;
  });
  unique(requiredValidationScopes, (item) => String(item.scope), "ShaderStyleProfileManifest.requiredValidationScopes scopes");
  unique(requiredValidationScopes, (item) => String(item.matrixSha256), "ShaderStyleProfileManifest.requiredValidationScopes matrix policies");
  return freeze(input as unknown as ShaderStyleProfileManifest);
}

/** Strictly parses the model-facing GPU compatibility fields published with a model version. */
export function parseModelGpuCompatibilityDescriptor(value: unknown): ModelGpuCompatibilityDescriptor {
  const input = object(detachedJson(value, "ModelGpuCompatibilityDescriptor"), "ModelGpuCompatibilityDescriptor");
  exact(input, ["modelId", "version", "gpuInterface", "modelAbiHash", "providedSemantics", "defaultStyleProfile"], "ModelGpuCompatibilityDescriptor");
  token(input.modelId, "ModelGpuCompatibilityDescriptor.modelId");
  immutableVersion(input.version, "ModelGpuCompatibilityDescriptor.version");
  const gpuInterface = interfaceRef(input.gpuInterface, "ModelGpuCompatibilityDescriptor.gpuInterface");
  const modelAbiHash = digest(input.modelAbiHash, "ModelGpuCompatibilityDescriptor.modelAbiHash");
  if (gpuInterface.modelAbiHash !== modelAbiHash) throw new TypeError("ModelGpuCompatibilityDescriptor.gpuInterface.modelAbiHash differs from modelAbiHash.");
  tokenArray(input.providedSemantics, "ModelGpuCompatibilityDescriptor.providedSemantics");
  if (input.defaultStyleProfile !== null) { const profile = object(input.defaultStyleProfile, "ModelGpuCompatibilityDescriptor.defaultStyleProfile"); exact(profile, ["profileId", "version", "manifestUri", "manifestSha256"], "ModelGpuCompatibilityDescriptor.defaultStyleProfile"); token(profile.profileId, "ModelGpuCompatibilityDescriptor.defaultStyleProfile.profileId"); immutableVersion(profile.version, "ModelGpuCompatibilityDescriptor.defaultStyleProfile.version"); uri(profile.manifestUri, "ModelGpuCompatibilityDescriptor.defaultStyleProfile.manifestUri"); digest(profile.manifestSha256, "ModelGpuCompatibilityDescriptor.defaultStyleProfile.manifestSha256"); }
  return freeze(input as unknown as ModelGpuCompatibilityDescriptor);
}

/** Strictly parses a qualification fixture that binds one immutable model descriptor. */
export function parseShaderQualificationModelCompatibilityFixture(value: unknown): ShaderQualificationModelCompatibilityFixture {
  const input = object(
    detachedJson(value, "ShaderQualificationModelCompatibilityFixture"),
    "ShaderQualificationModelCompatibilityFixture",
  );
  exact(input, ["contractVersion", "fixtureId", "model"], "ShaderQualificationModelCompatibilityFixture");
  if (input.contractVersion !== SHADER_QUALIFICATION_FIXTURE_VERSION) throw new TypeError("Unsupported model compatibility fixture version.");
  token(input.fixtureId, "ShaderQualificationModelCompatibilityFixture.fixtureId");
  parseModelGpuCompatibilityDescriptor(input.model);
  return freeze(input as unknown as ShaderQualificationModelCompatibilityFixture);
}

export function parseJsonBytes(bytes: Uint8Array, label: string): unknown {
  const safeLabel = typeof label === "string" && /^[A-Za-z0-9 ._-]{1,80}$/u.test(label)
    ? label
    : "GPU contract";
  let snapshot: Uint8Array;
  try {
    snapshot = snapshotUint8Array(bytes, GPU_CONTRACT_SNAPSHOT_LIMITS.maximumInputBytes);
  } catch {
    throw new TypeError(`${safeLabel} is not bounded UTF-8 JSON.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(snapshot)) as unknown;
  } catch {
    throw new TypeError(`${safeLabel} is not valid UTF-8 JSON.`);
  }
  try {
    return snapshotGpuContract(parsed);
  } catch {
    throw new TypeError(`${safeLabel} is not bounded detached JSON contract data.`);
  }
}
