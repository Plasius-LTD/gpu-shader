import {
  SHADER_QUALIFICATION_BUNDLE_VERSION,
  SHADER_QUALIFICATION_FIXTURE_VERSION,
  type ShaderCompileUnitManifest,
  type ShaderQualificationBundleManifest,
  type ShaderQualificationFixtureManifest,
  type ShaderResult,
} from "../contracts.js";
import { asSha256Hex } from "../hash.js";
import { validateCompileUnitInventory } from "./inventory.js";

type UnknownRecord = Record<string, unknown>;
type TextureDimension = "1d" | "2d" | "3d";
type TextureFormatAspect = "color" | "depth" | "stencil" | "depth-stencil";

interface BufferResourceInfo {
  readonly kind: "buffer";
  readonly byteLength: number;
  readonly usage: readonly string[];
  readonly hasInitialData: boolean;
}

interface TextureResourceInfo {
  readonly kind: "texture";
  readonly usage: readonly string[];
  readonly hasInitialData: boolean;
  readonly dimension: TextureDimension;
  readonly size: readonly [number, number, number];
  readonly mipLevelCount: number;
  readonly sampleCount: number;
  readonly format: string;
}

interface SamplerResourceInfo {
  readonly kind: "sampler";
  readonly usage: readonly string[];
  readonly hasInitialData: false;
  readonly descriptor: UnknownRecord;
}

type FixtureResourceInfo = BufferResourceInfo | TextureResourceInfo | SamplerResourceInfo;

const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u;
const BUFFER_USAGE = new Set(["map-read", "map-write", "copy-src", "copy-dst", "index", "vertex", "uniform", "storage", "indirect", "query-resolve"]);
const TEXTURE_USAGE = new Set(["copy-src", "copy-dst", "texture-binding", "storage-binding", "render-attachment"]);
const UNCOMPRESSED_COLOR_BYTES = new Map<string, number>([
  ["r8unorm", 1], ["r8snorm", 1], ["r8uint", 1], ["r8sint", 1],
  ["r16unorm", 2], ["r16snorm", 2], ["r16uint", 2], ["r16sint", 2], ["r16float", 2],
  ["rg8unorm", 2], ["rg8snorm", 2], ["rg8uint", 2], ["rg8sint", 2],
  ["r32uint", 4], ["r32sint", 4], ["r32float", 4],
  ["rg16unorm", 4], ["rg16snorm", 4], ["rg16uint", 4], ["rg16sint", 4], ["rg16float", 4],
  ["rgba8unorm", 4], ["rgba8unorm-srgb", 4], ["rgba8snorm", 4], ["rgba8uint", 4], ["rgba8sint", 4],
  ["bgra8unorm", 4], ["bgra8unorm-srgb", 4], ["rgb9e5ufloat", 4], ["rgb10a2uint", 4], ["rgb10a2unorm", 4], ["rg11b10ufloat", 4],
  ["rg32uint", 8], ["rg32sint", 8], ["rg32float", 8],
  ["rgba16unorm", 8], ["rgba16snorm", 8], ["rgba16uint", 8], ["rgba16sint", 8], ["rgba16float", 8],
  ["rgba32uint", 16], ["rgba32sint", 16], ["rgba32float", 16],
]);
const COMPRESSED_COLOR_FORMATS = new Set([
  "bc1-rgba-unorm", "bc1-rgba-unorm-srgb", "bc2-rgba-unorm", "bc2-rgba-unorm-srgb", "bc3-rgba-unorm", "bc3-rgba-unorm-srgb",
  "bc4-r-unorm", "bc4-r-snorm", "bc5-rg-unorm", "bc5-rg-snorm", "bc6h-rgb-ufloat", "bc6h-rgb-float", "bc7-rgba-unorm", "bc7-rgba-unorm-srgb",
  "etc2-rgb8unorm", "etc2-rgb8unorm-srgb", "etc2-rgb8a1unorm", "etc2-rgb8a1unorm-srgb", "etc2-rgba8unorm", "etc2-rgba8unorm-srgb",
  "eac-r11unorm", "eac-r11snorm", "eac-rg11unorm", "eac-rg11snorm",
  ...["4x4", "5x4", "5x5", "6x5", "6x6", "8x5", "8x6", "8x8", "10x5", "10x6", "10x8", "10x10", "12x10", "12x12"]
    .flatMap((block) => [`astc-${block}-unorm`, `astc-${block}-unorm-srgb`]),
]);
const DEPTH_STENCIL_FORMATS = new Map<string, TextureFormatAspect>([
  ["stencil8", "stencil"],
  ["depth16unorm", "depth"],
  ["depth24plus", "depth"],
  ["depth24plus-stencil8", "depth-stencil"],
  ["depth32float", "depth"],
  ["depth32float-stencil8", "depth-stencil"],
]);

function object(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${path} must be an object.`);
  return value as UnknownRecord;
}

function exact(value: UnknownRecord, keys: readonly string[], path: string): void {
  const expected = new Set(keys);
  if (!Object.keys(value).every((key) => expected.has(key)) || !keys.every((key) => key in value)) throw new TypeError(`${path} has unknown or missing fields.`);
}

function token(value: unknown, path: string): string {
  if (typeof value !== "string" || !TOKEN.test(value) || value.includes("..")) throw new TypeError(`${path} must be a safe token.`);
  return value;
}

function path(value: unknown, label: string, extensions: readonly string[]): string {
  if (typeof value !== "string" || !SAFE_PATH.test(value) || !extensions.some((extension) => value.endsWith(extension))) {
    throw new TypeError(`${label} must be a safe data-only bundle path (${extensions.join(", ")}).`);
  }
  return value;
}

function sha(value: unknown, label: string): string {
  try { return asSha256Hex(String(value)); }
  catch (cause) { throw new TypeError(`${label} must be a lowercase SHA-256 digest.`, { cause }); }
}

function integer(value: unknown, label: string, minimum = 0, maximum = 0xffff_ffff): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new TypeError(`${label} is outside its integer bound.`);
  return Number(value);
}

function boundedArray(value: unknown, label: string, maximum = 4096): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${label} must be a bounded array.`);
  return value;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${label} contains duplicates.`);
}

function orderedUniqueTokens(value: unknown, label: string): string[] {
  const result = boundedArray(value, label).map((item, index) => token(item, `${label}[${index}]`));
  unique(result, label);
  if (result.some((item, index) => index > 0 && result[index - 1]! >= item)) throw new TypeError(`${label} must use fixed code-unit order.`);
  return result;
}

function tuple(value: unknown, label: string, length: number, minimum = 0): number[] {
  const result = boundedArray(value, label, length);
  if (result.length !== length) throw new TypeError(`${label} must contain ${length} elements.`);
  return result.map((item, index) => integer(item, `${label}[${index}]`, minimum));
}

function finiteTuple(value: unknown, label: string, length: number): number[] {
  const result = boundedArray(value, label, length);
  if (result.length !== length || result.some((item) => typeof item !== "number" || !Number.isFinite(item))) throw new TypeError(`${label} must contain ${length} finite numbers.`);
  return result as number[];
}

function checkedProduct(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result)) throw new TypeError(`${label} exceeds the safe integer bound.`);
  return result;
}

function checkedSum(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new TypeError(`${label} exceeds the safe integer bound.`);
  return result;
}

function textureFormatAspect(format: string, label: string): TextureFormatAspect {
  if (UNCOMPRESSED_COLOR_BYTES.has(format) || COMPRESSED_COLOR_FORMATS.has(format)) return "color";
  const aspect = DEPTH_STENCIL_FORMATS.get(format);
  if (!aspect) throw new TypeError(`${label} is not a qualification-fixture-v1 WebGPU texture format.`);
  return aspect;
}

function mipExtent(texture: TextureResourceInfo, mipLevel: number): readonly [number, number, number] {
  const divisor = 2 ** mipLevel;
  const width = Math.max(1, Math.floor(texture.size[0] / divisor));
  const height = texture.dimension === "1d" ? 1 : Math.max(1, Math.floor(texture.size[1] / divisor));
  const depthOrArrayLayers = texture.dimension === "3d"
    ? Math.max(1, Math.floor(texture.size[2] / divisor))
    : texture.dimension === "2d" ? texture.size[2] : 1;
  return [width, height, depthOrArrayLayers];
}

function linearTextureDataBounds(
  extent: readonly [number, number, number],
  bytesPerTexel: number,
  bytesPerRow: number,
  rowsPerImage: number,
  label: string,
): { readonly minimum: number; readonly maximum: number } {
  const rowBytes = checkedProduct(extent[0], bytesPerTexel, `${label} row byte length`);
  if (bytesPerRow < rowBytes || bytesPerRow % bytesPerTexel !== 0) throw new TypeError(`${label}.bytesPerRow is incompatible with the copied texel row.`);
  if (rowsPerImage < extent[1]) throw new TypeError(`${label}.rowsPerImage is smaller than the copied image height.`);
  const imageStride = checkedProduct(bytesPerRow, rowsPerImage, `${label} image stride`);
  const priorImages = checkedProduct(imageStride, extent[2] - 1, `${label} prior-image byte length`);
  const priorRows = checkedProduct(bytesPerRow, extent[1] - 1, `${label} prior-row byte length`);
  const minimum = checkedSum(priorImages, checkedSum(priorRows, rowBytes, `${label} final-image byte length`), `${label} required byte length`);
  const maximum = checkedProduct(imageStride, extent[2], `${label} padded byte capacity`);
  return { minimum, maximum };
}

function textureView(value: unknown, label: string, texture: TextureResourceInfo): void {
  const view = object(value, label);
  exact(view, ["format", "dimension", "aspect", "baseMipLevel", "mipLevelCount", "baseArrayLayer", "arrayLayerCount"], label);
  const dimension = view.dimension === null ? null : String(view.dimension);
  if (dimension !== null && !["1d", "2d", "2d-array", "cube", "cube-array", "3d"].includes(dimension)) throw new TypeError(`${label}.dimension is invalid.`);
  const aspect = String(view.aspect);
  if (!["all", "depth-only", "stencil-only"].includes(aspect)) throw new TypeError(`${label}.aspect is invalid.`);

  const resourceAspect = textureFormatAspect(texture.format, `${label} resource format`);
  const aspectIsPresent = aspect === "all"
    || aspect === "depth-only" && (resourceAspect === "depth" || resourceAspect === "depth-stencil")
    || aspect === "stencil-only" && (resourceAspect === "stencil" || resourceAspect === "depth-stencil");
  if (!aspectIsPresent) throw new TypeError(`${label}.aspect is not present in texture format ${texture.format}.`);
  const resolvedFormat = aspect === "all" ? texture.format
    : aspect === "stencil-only" ? "stencil8"
      : texture.format === "depth24plus-stencil8" ? "depth24plus"
        : texture.format === "depth32float-stencil8" ? "depth32float" : texture.format;
  if (view.format !== null && token(view.format, `${label}.format`) !== resolvedFormat) {
    throw new TypeError(`${label}.format differs from the texture aspect format ${resolvedFormat}.`);
  }

  const baseMipLevel = integer(view.baseMipLevel, `${label}.baseMipLevel`);
  if (baseMipLevel >= texture.mipLevelCount) throw new TypeError(`${label}.baseMipLevel is out of bounds.`);
  const mipLevelCount = view.mipLevelCount === null
    ? texture.mipLevelCount - baseMipLevel
    : integer(view.mipLevelCount, `${label}.mipLevelCount`, 1);
  if (mipLevelCount > texture.mipLevelCount - baseMipLevel) throw new TypeError(`${label}.mipLevelCount is out of bounds.`);

  const textureArrayLayers = texture.dimension === "2d" ? texture.size[2] : 1;
  const baseArrayLayer = integer(view.baseArrayLayer, `${label}.baseArrayLayer`);
  if (baseArrayLayer >= textureArrayLayers) throw new TypeError(`${label}.baseArrayLayer is out of bounds.`);
  const resolvedDimension = dimension ?? (texture.dimension === "2d" && textureArrayLayers > 1 ? "2d-array" : texture.dimension);
  const defaultArrayLayerCount = resolvedDimension === "cube" ? 6
    : resolvedDimension === "2d-array" || resolvedDimension === "cube-array" ? textureArrayLayers - baseArrayLayer : 1;
  const arrayLayerCount = view.arrayLayerCount === null
    ? defaultArrayLayerCount
    : integer(view.arrayLayerCount, `${label}.arrayLayerCount`, 1);
  if (arrayLayerCount > textureArrayLayers - baseArrayLayer) throw new TypeError(`${label}.arrayLayerCount is out of bounds.`);

  if (resolvedDimension === "1d" && texture.dimension !== "1d"
    || resolvedDimension === "3d" && texture.dimension !== "3d"
    || ["2d", "2d-array", "cube", "cube-array"].includes(resolvedDimension) && texture.dimension !== "2d") {
    throw new TypeError(`${label}.dimension is incompatible with the texture dimension.`);
  }
  if (["1d", "2d", "3d"].includes(resolvedDimension) && arrayLayerCount !== 1) throw new TypeError(`${label}.arrayLayerCount must be one for ${resolvedDimension} views.`);
  if (resolvedDimension === "cube" && arrayLayerCount !== 6 || resolvedDimension === "cube-array" && arrayLayerCount % 6 !== 0) throw new TypeError(`${label}.arrayLayerCount is invalid for a cube view.`);
  if ((resolvedDimension === "cube" || resolvedDimension === "cube-array") && texture.size[0] !== texture.size[1]) throw new TypeError(`${label} cube views require square texture layers.`);
  if (texture.sampleCount > 1 && (resolvedDimension !== "2d" || mipLevelCount !== 1 || arrayLayerCount !== 1)) throw new TypeError(`${label} multisampled texture views must select one 2d subresource.`);
}

function dataRef(value: unknown, label: string): void {
  const ref = object(value, label); exact(ref, ["path", "sha256"], label); path(ref.path, `${label}.path`, [".bin"]); sha(ref.sha256, `${label}.sha256`);
}

function jsonValue(value: unknown, label: string, depth = 0): void {
  if (depth > 32) throw new TypeError(`${label} exceeds the structured-value nesting bound.`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite.`); return; }
  if (Array.isArray(value)) { if (value.length > 65_536) throw new TypeError(`${label} exceeds the structured-value item bound.`); value.forEach((item, index) => jsonValue(item, `${label}[${index}]`, depth + 1)); return; }
  const input = object(value, label); if (Object.keys(input).length > 4096) throw new TypeError(`${label} has too many members.`); for (const [key, item] of Object.entries(input)) { token(key, `${label} key`); jsonValue(item, `${label}.${key}`, depth + 1); }
}

/** Strictly validates the bounded, declarative (never executable) fixture DSL. */
export function validateQualificationFixture(
  value: unknown,
  unit?: ShaderCompileUnitManifest,
): ShaderResult<ShaderQualificationFixtureManifest> {
  try {
    const fixture = object(value, "fixture"); exact(fixture, ["contractVersion", "fixtureId", "resources", "bindGroups", "commands", "layoutProbes", "readbacks", "bounds"], "fixture");
    if (fixture.contractVersion !== SHADER_QUALIFICATION_FIXTURE_VERSION) throw new TypeError("Unsupported qualification fixture version.");
    token(fixture.fixtureId, "fixture.fixtureId");
    const bounds = object(fixture.bounds, "fixture.bounds"); exact(bounds, ["maxBufferBytes", "maxTextureTexels", "maxCommands", "timeoutMs"], "fixture.bounds");
    const maxBufferBytes = integer(bounds.maxBufferBytes, "fixture.bounds.maxBufferBytes", 1, 67_108_864);
    const maxTextureTexels = integer(bounds.maxTextureTexels, "fixture.bounds.maxTextureTexels", 1, 16_777_216);
    const maxCommands = integer(bounds.maxCommands, "fixture.bounds.maxCommands", 1, 1000);
    integer(bounds.timeoutMs, "fixture.bounds.timeoutMs", 1, 300_000);
    const resources = new Map<string, FixtureResourceInfo>();
    let bufferBytes = 0; let textureTexels = 0;
    const resourceValues = boundedArray(fixture.resources, "fixture.resources", 256); if (resourceValues.length === 0) throw new TypeError("Fixture requires resources.");
    for (const [index, value] of resourceValues.entries()) {
      const label = `fixture.resources[${index}]`; const resource = object(value, label); const kind = String(resource.kind);
      if (kind === "buffer") {
        exact(resource, ["kind", "resourceId", "byteLength", "usage", "initialData"], label);
        const id = token(resource.resourceId, `${label}.resourceId`); if (resources.has(id)) throw new TypeError(`Duplicate resource ${id}.`);
        const byteLength = integer(resource.byteLength, `${label}.byteLength`, 1, maxBufferBytes); bufferBytes += byteLength;
        const usage = boundedArray(resource.usage, `${label}.usage`, BUFFER_USAGE.size).map(String); unique(usage, `${label}.usage`); if (usage.length === 0 || usage.some((item) => !BUFFER_USAGE.has(item))) throw new TypeError(`${label}.usage is invalid.`);
        if (resource.initialData !== null) dataRef(resource.initialData, `${label}.initialData`);
        resources.set(id, { kind: "buffer", byteLength, usage, hasInitialData: resource.initialData !== null });
      } else if (kind === "texture") {
        exact(resource, ["kind", "resourceId", "dimension", "size", "mipLevelCount", "sampleCount", "format", "usage", "initialData"], label);
        const id = token(resource.resourceId, `${label}.resourceId`); if (resources.has(id)) throw new TypeError(`Duplicate resource ${id}.`);
        const dimensionValue = String(resource.dimension); if (!["1d", "2d", "3d"].includes(dimensionValue)) throw new TypeError(`${label}.dimension is invalid.`); const dimension = dimensionValue as TextureDimension;
        const parsedSize = tuple(resource.size, `${label}.size`, 3, 1); const size = parsedSize as [number, number, number];
        if (dimension === "1d" && (size[1] !== 1 || size[2] !== 1)) throw new TypeError(`${label}.size is inconsistent with dimension.`);
        const mipLevelCount = integer(resource.mipLevelCount, `${label}.mipLevelCount`, 1, 32);
        const maximumMipDimension = dimension === "1d" ? size[0] : dimension === "2d" ? Math.max(size[0], size[1]) : Math.max(...size);
        const maximumMipLevels = Math.floor(Math.log2(maximumMipDimension)) + 1;
        if (mipLevelCount > maximumMipLevels) throw new TypeError(`${label}.mipLevelCount exceeds its spatial size.`);
        const sampleCount = integer(resource.sampleCount, `${label}.sampleCount`, 1, 4); if (sampleCount !== 1 && sampleCount !== 4) throw new TypeError(`${label}.sampleCount is unsupported.`);
        if (sampleCount > 1 && (dimension !== "2d" || size[2] !== 1 || mipLevelCount !== 1)) throw new TypeError(`${label} multisampling requires one single-mip 2d layer.`);
        const resourceTexels = checkedProduct(checkedProduct(checkedProduct(size[0], size[1], `${label} texel count`), size[2], `${label} texel count`), sampleCount, `${label} sampled texel count`);
        textureTexels = checkedSum(textureTexels, resourceTexels, "fixture texture texel count");
        const format = token(resource.format, `${label}.format`); textureFormatAspect(format, `${label}.format`);
        const usage = boundedArray(resource.usage, `${label}.usage`, TEXTURE_USAGE.size).map(String); unique(usage, `${label}.usage`); if (usage.length === 0 || usage.some((item) => !TEXTURE_USAGE.has(item))) throw new TypeError(`${label}.usage is invalid.`);
        const textureInfo: TextureResourceInfo = { kind: "texture", usage, hasInitialData: resource.initialData !== null, dimension, size, mipLevelCount, sampleCount, format };
        if (resource.initialData !== null) {
          const initialLabel = `${label}.initialData`;
          const initial = object(resource.initialData, initialLabel); exact(initial, ["path", "sha256", "bytesPerRow", "rowsPerImage", "mipLevel", "origin", "aspect"], initialLabel);
          path(initial.path, `${initialLabel}.path`, [".bin"]); sha(initial.sha256, `${initialLabel}.sha256`);
          if (sampleCount !== 1) throw new TypeError(`${label} multisampled textures cannot have initialData.`);
          if (!usage.includes("copy-dst")) throw new TypeError(`${initialLabel} requires copy-dst texture usage.`);
          const bytesPerTexel = UNCOMPRESSED_COLOR_BYTES.get(format); if (!bytesPerTexel) throw new TypeError(`${initialLabel} supports only uncompressed color formats in fixture v1.`);
          const mipLevel = integer(initial.mipLevel, `${initialLabel}.mipLevel`); if (mipLevel !== 0) throw new TypeError(`${initialLabel}.mipLevel must be zero in fixture v1.`);
          const origin = tuple(initial.origin, `${initialLabel}.origin`, 3); if (origin.some((axis) => axis !== 0)) throw new TypeError(`${initialLabel}.origin must be zero in fixture v1.`);
          if (initial.aspect !== "all") throw new TypeError(`${initialLabel}.aspect must be all for an uncompressed color upload.`);
          const bytesPerRow = integer(initial.bytesPerRow, `${initialLabel}.bytesPerRow`, 1);
          const rowsPerImage = integer(initial.rowsPerImage, `${initialLabel}.rowsPerImage`, 1);
          linearTextureDataBounds(mipExtent(textureInfo, 0), bytesPerTexel, bytesPerRow, rowsPerImage, initialLabel);
        }
        resources.set(id, textureInfo);
      } else if (kind === "sampler") {
        exact(resource, ["kind", "resourceId", "descriptor"], label); const id = token(resource.resourceId, `${label}.resourceId`); if (resources.has(id)) throw new TypeError(`Duplicate resource ${id}.`);
        const descriptor = object(resource.descriptor, `${label}.descriptor`); const samplerKeys = new Set(["addressModeU", "addressModeV", "addressModeW", "magFilter", "minFilter", "mipmapFilter", "lodMinClamp", "lodMaxClamp", "compare", "maxAnisotropy"]); for (const key of Object.keys(descriptor)) if (!samplerKeys.has(key)) throw new TypeError(`${label}.descriptor.${key} is unsupported.`); for (const key of ["addressModeU", "addressModeV", "addressModeW"]) if (descriptor[key] !== undefined && !["clamp-to-edge", "repeat", "mirror-repeat"].includes(String(descriptor[key]))) throw new TypeError(`${label}.descriptor.${key} is invalid.`); for (const key of ["magFilter", "minFilter", "mipmapFilter"]) if (descriptor[key] !== undefined && !["nearest", "linear"].includes(String(descriptor[key]))) throw new TypeError(`${label}.descriptor.${key} is invalid.`); if (descriptor.compare !== undefined && !["never", "less", "equal", "less-equal", "greater", "not-equal", "greater-equal", "always"].includes(String(descriptor.compare))) throw new TypeError(`${label}.descriptor.compare is invalid.`); const lodMin = descriptor.lodMinClamp === undefined ? 0 : Number(descriptor.lodMinClamp); const lodMax = descriptor.lodMaxClamp === undefined ? 32 : Number(descriptor.lodMaxClamp); if (!Number.isFinite(lodMin) || !Number.isFinite(lodMax) || lodMin < 0 || lodMax < lodMin || lodMax > 32) throw new TypeError(`${label}.descriptor LOD clamps are invalid.`); if (descriptor.maxAnisotropy !== undefined) integer(descriptor.maxAnisotropy, `${label}.descriptor.maxAnisotropy`, 1, 16);
        resources.set(id, { kind: "sampler", usage: [], hasInitialData: false, descriptor });
      } else throw new TypeError(`${label}.kind is unsupported.`);
    }
    if (bufferBytes > maxBufferBytes || textureTexels > maxTextureTexels) throw new TypeError("Fixture resources exceed declared bounds.");
    const bindGroups = new Map<string, { group: number; entries: readonly UnknownRecord[] }>();
    for (const [index, value] of boundedArray(fixture.bindGroups, "fixture.bindGroups", 32).entries()) {
      const label = `fixture.bindGroups[${index}]`; const group = object(value, label); exact(group, ["bindGroupId", "group", "entries"], label); const id = token(group.bindGroupId, `${label}.bindGroupId`); if (bindGroups.has(id)) throw new TypeError(`Duplicate bind group ${id}.`); const groupIndex = integer(group.group, `${label}.group`); const parsedEntries: UnknownRecord[] = [];
      const bindingIds: string[] = []; for (const [entryIndex, value] of boundedArray(group.entries, `${label}.entries`, 64).entries()) { const entryLabel = `${label}.entries[${entryIndex}]`; const entry = object(value, entryLabel); parsedEntries.push(entry); exact(entry, ["binding", "resource"], entryLabel); bindingIds.push(String(integer(entry.binding, `${entryLabel}.binding`))); const ref = object(entry.resource, `${entryLabel}.resource`); const kind = String(ref.kind); if (kind === "buffer") { exact(ref, ["kind", "resourceId", "offset", "size"], `${entryLabel}.resource`); const source = resources.get(token(ref.resourceId, `${entryLabel}.resource.resourceId`)); const offset = integer(ref.offset, `${entryLabel}.resource.offset`); const size = integer(ref.size, `${entryLabel}.resource.size`, 1); if (source?.kind !== "buffer" || offset + size > source.byteLength) throw new TypeError(`${entryLabel}.resource is out of bounds.`); } else if (kind === "texture-view") { exact(ref, ["kind", "resourceId", "view"], `${entryLabel}.resource`); const source = resources.get(token(ref.resourceId, `${entryLabel}.resource.resourceId`)); if (source?.kind !== "texture") throw new TypeError(`${entryLabel}.resource is not a texture.`); textureView(ref.view, `${entryLabel}.resource.view`, source); } else if (kind === "sampler") { exact(ref, ["kind", "resourceId"], `${entryLabel}.resource`); if (resources.get(token(ref.resourceId, `${entryLabel}.resource.resourceId`))?.kind !== "sampler") throw new TypeError(`${entryLabel}.resource is not a sampler.`); } else throw new TypeError(`${entryLabel}.resource.kind is unsupported.`); }
      unique(bindingIds, `${label}.entries`);
      bindGroups.set(id, { group: groupIndex, entries: parsedEntries });
    }
    const pipelines = new Map(unit?.pipelines.map((pipeline) => [pipeline.pipelineId, pipeline]) ?? []);
    const pipelineIds = new Set(pipelines.keys());
    const commandBindGroups = (value: unknown, pipelineId: string, label: string): void => {
      const ids = boundedArray(value, label, 32).map((item, index) => token(item, `${label}[${index}]`)); unique(ids, label);
      const pipeline = pipelines.get(pipelineId); if (!pipeline) { if (unit) throw new TypeError(`${label} pipeline is missing.`); return; }
      const expectedGroups = [...pipeline.layout.bindGroups].sort((left, right) => left.group - right.group);
      if (ids.length !== expectedGroups.length) throw new TypeError(`${label} must bind every pipeline group exactly once.`);
      ids.forEach((id, index) => { const actual = bindGroups.get(id); const expected = expectedGroups[index]!; if (!actual || actual.group !== expected.group) throw new TypeError(`${label}[${index}] does not match pipeline group ${expected.group}.`); const actualBindings = actual.entries.map((entry) => Number(entry.binding)).sort((left, right) => left - right); const expectedBindings = expected.entries.map((entry) => entry.binding).sort((left, right) => left - right); if (actualBindings.join(",") !== expectedBindings.join(",")) throw new TypeError(`${label}[${index}] bind-group entries differ from the pipeline layout.`); });
    };
    const commands = boundedArray(fixture.commands, "fixture.commands", maxCommands); if (commands.length === 0 || commands.length > maxCommands) throw new TypeError("Fixture requires bounded commands.");
    let executionCommands = 0;
    for (const [index, value] of commands.entries()) {
      const label = `fixture.commands[${index}]`; const command = object(value, label); const kind = String(command.kind);
      if (kind === "dispatch") { executionCommands += 1; exact(command, ["kind", "pipelineId", "bindGroupIds", "workgroups"], label); const id = token(command.pipelineId, `${label}.pipelineId`); if (unit && (pipelines.get(id)?.kind !== "compute")) throw new TypeError(`${label} references a missing or non-compute pipeline.`); commandBindGroups(command.bindGroupIds, id, `${label}.bindGroupIds`); const workgroups = tuple(command.workgroups, `${label}.workgroups`, 3, 1); if (workgroups[0]! * workgroups[1]! * workgroups[2]! > 1_048_576) throw new TypeError(`${label}.workgroups exceeds the hard dispatch bound.`); }
      else if (kind === "copy-buffer") { exact(command, ["kind", "source", "destination", "byteLength"], label); const source = resources.get(token(command.source, `${label}.source`)); const destination = resources.get(token(command.destination, `${label}.destination`)); const bytes = integer(command.byteLength, `${label}.byteLength`, 1); if (source?.kind !== "buffer" || destination?.kind !== "buffer" || bytes > (source.byteLength ?? 0) || bytes > (destination.byteLength ?? 0)) throw new TypeError(`${label} is out of bounds.`); }
      else if (kind === "copy-texture-to-buffer") {
        exact(command, ["kind", "source", "destination", "extent"], label);
        const source = object(command.source, `${label}.source`); exact(source, ["resourceId", "mipLevel", "origin", "aspect"], `${label}.source`);
        const sourceResource = resources.get(token(source.resourceId, `${label}.source.resourceId`));
        if (sourceResource?.kind !== "texture") throw new TypeError(`${label}.source is not a texture.`);
        if (!sourceResource.usage.includes("copy-src")) throw new TypeError(`${label}.source requires copy-src texture usage.`);
        if (sourceResource.sampleCount !== 1) throw new TypeError(`${label}.source must not be multisampled.`);
        const bytesPerTexel = UNCOMPRESSED_COLOR_BYTES.get(sourceResource.format);
        if (!bytesPerTexel || source.aspect !== "all") throw new TypeError(`${label}.source format/aspect is unsupported for a fixture-v1 texture readback.`);
        const mipLevel = integer(source.mipLevel, `${label}.source.mipLevel`); if (mipLevel >= sourceResource.mipLevelCount) throw new TypeError(`${label}.source.mipLevel is out of bounds.`);
        const origin = tuple(source.origin, `${label}.source.origin`, 3); const extent = tuple(command.extent, `${label}.extent`, 3, 1) as [number, number, number]; const available = mipExtent(sourceResource, mipLevel);
        if (origin.some((axis, axisIndex) => checkedSum(axis, extent[axisIndex]!, `${label}.source copy range`) > available[axisIndex]!)) throw new TypeError(`${label}.source copy range is out of bounds.`);

        const destination = object(command.destination, `${label}.destination`); exact(destination, ["resourceId", "offset", "bytesPerRow", "rowsPerImage"], `${label}.destination`);
        const destinationResource = resources.get(token(destination.resourceId, `${label}.destination.resourceId`));
        if (destinationResource?.kind !== "buffer") throw new TypeError(`${label}.destination is not a buffer.`);
        if (!destinationResource.usage.includes("copy-dst")) throw new TypeError(`${label}.destination requires copy-dst buffer usage.`);
        const offset = integer(destination.offset, `${label}.destination.offset`); if (offset % bytesPerTexel !== 0) throw new TypeError(`${label}.destination.offset must be texel-block aligned.`);
        const bytesPerRow = integer(destination.bytesPerRow, `${label}.destination.bytesPerRow`, 1); if (bytesPerRow % 256 !== 0) throw new TypeError(`${label}.destination.bytesPerRow must be 256-byte aligned.`);
        const rowsPerImage = integer(destination.rowsPerImage, `${label}.destination.rowsPerImage`, 1);
        const requiredBytes = linearTextureDataBounds(extent, bytesPerTexel, bytesPerRow, rowsPerImage, `${label}.destination`).minimum;
        if (checkedSum(offset, requiredBytes, `${label}.destination range`) > destinationResource.byteLength) throw new TypeError(`${label}.destination range is out of bounds.`);
      }
      else if (kind === "draw") { executionCommands += 1; exact(command, ["kind", "pipelineId", "bindGroupIds", "vertexBuffers", "colorAttachments", "depthStencilAttachment", "vertexCount", "instanceCount", "firstVertex", "firstInstance"], label); const id = token(command.pipelineId, `${label}.pipelineId`); if (unit && (pipelines.get(id)?.kind !== "render")) throw new TypeError(`${label} references a missing or non-render pipeline.`); commandBindGroups(command.bindGroupIds, id, `${label}.bindGroupIds`); boundedArray(command.vertexBuffers, `${label}.vertexBuffers`, 16).forEach((value, vertexIndex) => { const vertexLabel = `${label}.vertexBuffers[${vertexIndex}]`; const vertex = object(value, vertexLabel); exact(vertex, ["slot", "resourceId", "offset", "size"], vertexLabel); integer(vertex.slot, `${vertexLabel}.slot`); const resource = resources.get(token(vertex.resourceId, `${vertexLabel}.resourceId`)); const offset = integer(vertex.offset, `${vertexLabel}.offset`); const size = integer(vertex.size, `${vertexLabel}.size`, 1); if (resource?.kind !== "buffer" || !resource.usage.includes("vertex") || offset + size > resource.byteLength) throw new TypeError(`${vertexLabel} is not a bounded vertex buffer.`); }); boundedArray(command.colorAttachments, `${label}.colorAttachments`, 8).forEach((value, attachmentIndex) => { const attachmentLabel = `${label}.colorAttachments[${attachmentIndex}]`; const attachment = object(value, attachmentLabel); exact(attachment, ["resourceId", "view", "clearValue", "loadOp", "storeOp"], attachmentLabel); const target = resources.get(token(attachment.resourceId, `${attachmentLabel}.resourceId`)); if (target?.kind !== "texture" || !target.usage.includes("render-attachment")) throw new TypeError(`${attachmentLabel} is not a render-attachment texture.`); textureView(attachment.view, `${attachmentLabel}.view`, target); if (textureFormatAspect(target.format, `${attachmentLabel} format`) !== "color") throw new TypeError(`${attachmentLabel} must use a color texture format.`); finiteTuple(attachment.clearValue, `${attachmentLabel}.clearValue`, 4); if (!["clear", "load"].includes(String(attachment.loadOp)) || !["store", "discard"].includes(String(attachment.storeOp))) throw new TypeError(`${attachmentLabel} has invalid ops.`); }); if (command.depthStencilAttachment !== null) { const attachment = object(command.depthStencilAttachment, `${label}.depthStencilAttachment`); exact(attachment, ["resourceId", "view", "depthClearValue", "depthLoadOp", "depthStoreOp", "stencilClearValue", "stencilLoadOp", "stencilStoreOp"], `${label}.depthStencilAttachment`); const target = resources.get(token(attachment.resourceId, `${label}.depthStencilAttachment.resourceId`)); if (target?.kind !== "texture" || !target.usage.includes("render-attachment")) throw new TypeError(`${label}.depthStencilAttachment is not a render-attachment texture.`); textureView(attachment.view, `${label}.depthStencilAttachment.view`, target); if (textureFormatAspect(target.format, `${label}.depthStencilAttachment format`) === "color") throw new TypeError(`${label}.depthStencilAttachment must use a depth/stencil texture format.`); if (typeof attachment.depthClearValue !== "number" || !Number.isFinite(attachment.depthClearValue) || attachment.depthClearValue < 0 || attachment.depthClearValue > 1) throw new TypeError(`${label}.depthClearValue is invalid.`); integer(attachment.stencilClearValue, `${label}.stencilClearValue`, 0, 255); if (!["clear", "load"].includes(String(attachment.depthLoadOp)) || !["store", "discard"].includes(String(attachment.depthStoreOp)) || attachment.stencilLoadOp !== null && !["clear", "load"].includes(String(attachment.stencilLoadOp)) || attachment.stencilStoreOp !== null && !["store", "discard"].includes(String(attachment.stencilStoreOp)) || (attachment.stencilLoadOp === null) !== (attachment.stencilStoreOp === null)) throw new TypeError(`${label}.depth/stencil attachment has invalid ops.`); } const vertexCount = integer(command.vertexCount, `${label}.vertexCount`, 1); const instanceCount = integer(command.instanceCount, `${label}.instanceCount`, 1); if (vertexCount * instanceCount > 16_777_216) throw new TypeError(`${label} exceeds the hard draw invocation bound.`); integer(command.firstVertex, `${label}.firstVertex`); integer(command.firstInstance, `${label}.firstInstance`); }
      else throw new TypeError(`${label}.kind is unsupported.`);
    }
    if (executionCommands === 0) throw new TypeError("Fixture requires a bounded dispatch or draw command.");
    const readbacks = boundedArray(fixture.readbacks, "fixture.readbacks", 512); if (readbacks.length === 0) throw new TypeError("Fixture requires semantic readback evidence."); const parsedReadbacks: UnknownRecord[] = [];
    for (const [index, value] of readbacks.entries()) { const label = `fixture.readbacks[${index}]`; const readback = object(value, label); parsedReadbacks.push(readback); exact(readback, ["resourceId", "byteOffset", "byteLength", "expectedSha256"], label); const resource = resources.get(token(readback.resourceId, `${label}.resourceId`)); const offset = integer(readback.byteOffset, `${label}.byteOffset`); const size = integer(readback.byteLength, `${label}.byteLength`, 1); if (resource?.kind !== "buffer" || !resource.usage.includes("map-read") || offset + size > (resource.byteLength ?? 0)) throw new TypeError(`${label} is not a bounded map-read buffer range.`); sha(readback.expectedSha256, `${label}.expectedSha256`); }
    const probes = boundedArray(fixture.layoutProbes, "fixture.layoutProbes", 512); if (probes.length === 0) throw new TypeError("Fixture requires at least one structured CPU-to-GPU and GPU-to-CPU layout probe."); const probeIds: string[] = []; const probeSources: string[] = [];
    for (const [index, value] of probes.entries()) {
      const label = `fixture.layoutProbes[${index}]`; const probe = object(value, label); probeIds.push(token(probe.probeId, `${label}.probeId`)); const commandIndex = integer(probe.commandIndex, `${label}.commandIndex`, 0, commands.length - 1); const command = object(commands[commandIndex], `${label}.command`);
      if (probe.kind === "buffer-record") {
        exact(probe, ["kind", "probeId", "source", "pipelineId", "commandIndex", "input", "output"], label);
        const source = object(probe.source, `${label}.source`); exact(source, ["moduleId", "group", "binding", "recordName"], `${label}.source`); const moduleId = token(source.moduleId, `${label}.source.moduleId`); const group = integer(source.group, `${label}.source.group`); const binding = integer(source.binding, `${label}.source.binding`); token(source.recordName, `${label}.source.recordName`); probeSources.push(`binding:${moduleId}:${group}:${binding}`);
        const pipelineId = token(probe.pipelineId, `${label}.pipelineId`); if (unit && !pipelineIds.has(pipelineId)) throw new TypeError(`${label}.pipelineId is missing.`); if (command.pipelineId !== pipelineId || command.kind !== "dispatch" && command.kind !== "draw") throw new TypeError(`${label} must target its declared executable pipeline command.`);
        const input = object(probe.input, `${label}.input`); exact(input, ["resourceId", "byteOffset", "byteLength", "value"], `${label}.input`); const inputId = token(input.resourceId, `${label}.input.resourceId`); const inputResource = resources.get(inputId); const inputOffset = integer(input.byteOffset, `${label}.input.byteOffset`); const inputLength = integer(input.byteLength, `${label}.input.byteLength`, 1); if (inputResource?.kind !== "buffer" || !inputResource.hasInitialData || inputOffset + inputLength > (inputResource.byteLength ?? 0)) throw new TypeError(`${label}.input must be an initialized bounded buffer range.`); jsonValue(input.value, `${label}.input.value`);
        const commandGroups = boundedArray(command.bindGroupIds, `${label}.command.bindGroupIds`).map(String); const bindsSource = commandGroups.some((id) => { const selected = bindGroups.get(id); if (selected?.group !== group) return false; const entry = selected.entries.find((candidate) => candidate.binding === binding); return entry ? object(entry.resource, `${label}.boundResource`).resourceId === inputId : false; }); if (!bindsSource) throw new TypeError(`${label}.input is not bound at the declared model source in its command.`);
      } else if (probe.kind === "vertex-input") {
        exact(probe, ["kind", "probeId", "source", "commandIndex", "input", "output"], label);
        const source = object(probe.source, `${label}.source`); exact(source, ["pipelineId", "shaderLocation", "semantic"], `${label}.source`); const pipelineId = token(source.pipelineId, `${label}.source.pipelineId`); const shaderLocation = integer(source.shaderLocation, `${label}.source.shaderLocation`); const semantic = token(source.semantic, `${label}.source.semantic`); probeSources.push(`vertex:${pipelineId}:${shaderLocation}:${semantic}`);
        if (command.kind !== "draw" || command.pipelineId !== pipelineId) throw new TypeError(`${label} must target its declared render pipeline draw command.`);
        const input = object(probe.input, `${label}.input`); exact(input, ["resourceId", "vertexBufferSlot", "elementIndex", "value"], `${label}.input`); const inputId = token(input.resourceId, `${label}.input.resourceId`); const inputResource = resources.get(inputId); const slot = integer(input.vertexBufferSlot, `${label}.input.vertexBufferSlot`); const elementIndex = integer(input.elementIndex, `${label}.input.elementIndex`); if (inputResource?.kind !== "buffer" || !inputResource.hasInitialData || !inputResource.usage.includes("vertex")) throw new TypeError(`${label}.input must be an initialized vertex buffer.`); jsonValue(input.value, `${label}.input.value`);
        if (unit) { const pipeline = pipelines.get(pipelineId); if (!pipeline || pipeline.kind !== "render") throw new TypeError(`${label}.source.pipelineId is not a render pipeline.`); const layout = pipeline.vertexBuffers[slot]; const attribute = layout?.attributes.find((item) => item.shaderLocation === shaderLocation); if (!layout || !attribute || attribute.semantic !== semantic) throw new TypeError(`${label} does not identify an exact pipeline vertex semantic.`); const commandBuffer = boundedArray(command.vertexBuffers, `${label}.command.vertexBuffers`).map((item) => object(item, `${label}.command.vertexBuffer`)).find((item) => item.slot === slot); if (!commandBuffer || commandBuffer.resourceId !== inputId) throw new TypeError(`${label}.input is not bound to its declared vertex-buffer slot.`); const first = integer(layout.stepMode === "vertex" ? command.firstVertex : command.firstInstance, `${label}.command.firstElement`); const count = integer(layout.stepMode === "vertex" ? command.vertexCount : command.instanceCount, `${label}.command.elementCount`, 1); if (elementIndex < first || elementIndex >= first + count) throw new TypeError(`${label}.input element is not consumed by its draw command.`); }
      } else throw new TypeError(`${label}.kind is unsupported in qualification fixture v1.`);
      const output = object(probe.output, `${label}.output`); exact(output, ["readbackIndex", "recordName", "expectedValue"], `${label}.output`); integer(output.readbackIndex, `${label}.output.readbackIndex`, 0, parsedReadbacks.length - 1); token(output.recordName, `${label}.output.recordName`); jsonValue(output.expectedValue, `${label}.output.expectedValue`);
    }
    unique(probeIds, "fixture.layoutProbes probe IDs"); unique(probeSources, "fixture.layoutProbes model sources");
    return { ok: true, value: fixture as unknown as ShaderQualificationFixtureManifest };
  } catch (cause) {
    return { ok: false, diagnostics: [{ code: "invalid-contract", severity: "error", message: cause instanceof Error ? cause.message : "Invalid qualification fixture." }] };
  }
}

/** Validates the non-self-referential, data-only candidate bundle envelope. */
export function validateQualificationBundleManifest(value: unknown): ShaderResult<ShaderQualificationBundleManifest> {
  try {
    const bundle = object(value, "qualification"); exact(bundle, ["contractVersion", "inventory", "subject", "shaderManifestCorePath", "gpuInterfaceManifest", "modelCompatibilityFixtures", "modules", "fixtures"], "qualification");
    if (bundle.contractVersion !== SHADER_QUALIFICATION_BUNDLE_VERSION) throw new TypeError("Unsupported qualification bundle version.");
    const inventory = validateCompileUnitInventory(bundle.inventory); if (!inventory.ok) throw new TypeError(inventory.diagnostics.map((item) => item.message).join("; "));
    const subject = object(bundle.subject, "qualification.subject"); exact(subject, ["shaderManifestCore", "compileUnitInventorySha256", "shaderAbiHash", "interfaceManifestSha256", "modelAbiHashes", "modules", "requiredCompileUnitIds", "requiredCellIds"], "qualification.subject");
    const candidate = object(subject.shaderManifestCore, "qualification.subject.shaderManifestCore"); exact(candidate, ["shaderId", "version", "sha256"], "qualification.subject.shaderManifestCore"); token(candidate.shaderId, "qualification.subject.shaderManifestCore.shaderId"); token(candidate.version, "qualification.subject.shaderManifestCore.version"); sha(candidate.sha256, "qualification.subject.shaderManifestCore.sha256");
    path(bundle.shaderManifestCorePath, "qualification.shaderManifestCorePath", [".json"]);
    const interfaceManifest = object(bundle.gpuInterfaceManifest, "qualification.gpuInterfaceManifest"); exact(interfaceManifest, ["path", "sha256"], "qualification.gpuInterfaceManifest"); path(interfaceManifest.path, "qualification.gpuInterfaceManifest.path", [".json"]); const interfaceSha = sha(interfaceManifest.sha256, "qualification.gpuInterfaceManifest.sha256"); if (interfaceSha !== subject.interfaceManifestSha256) throw new TypeError("GPU interface file digest differs from subject.");
    const modelFixtures = boundedArray(bundle.modelCompatibilityFixtures, "qualification.modelCompatibilityFixtures").map((item, index) => { const label = `qualification.modelCompatibilityFixtures[${index}]`; const fixture = object(item, label); exact(fixture, ["fixtureId", "path", "sha256"], label); return { fixtureId: token(fixture.fixtureId, `${label}.fixtureId`), path: path(fixture.path, `${label}.path`, [".json"]), sha256: sha(fixture.sha256, `${label}.sha256`) }; }); if (modelFixtures.length === 0) throw new TypeError("Qualification requires at least one model compatibility fixture."); unique(modelFixtures.map((item) => item.fixtureId), "qualification.modelCompatibilityFixtures"); unique(modelFixtures.map((item) => item.path), "qualification.modelCompatibilityFixtures paths");
    sha(subject.compileUnitInventorySha256, "qualification.subject.compileUnitInventorySha256"); sha(subject.shaderAbiHash, "qualification.subject.shaderAbiHash"); sha(subject.interfaceManifestSha256, "qualification.subject.interfaceManifestSha256"); const modelHashes = boundedArray(subject.modelAbiHashes, "qualification.subject.modelAbiHashes").map((item, index) => sha(item, `qualification.subject.modelAbiHashes[${index}]`)); if (modelHashes.length === 0) throw new TypeError("Qualification requires at least one model ABI hash."); unique(modelHashes, "qualification.subject.modelAbiHashes");
    const modules = boundedArray(bundle.modules, "qualification.modules").map((item, index) => { const label = `qualification.modules[${index}]`; const module = object(item, label); exact(module, ["moduleId", "path", "sha256"], label); return { moduleId: token(module.moduleId, `${label}.moduleId`), path: path(module.path, `${label}.path`, [".wgsl"]), sha256: sha(module.sha256, `${label}.sha256`) }; }); if (modules.length === 0) throw new TypeError("Qualification requires at least one final WGSL module."); unique(modules.map((item) => item.moduleId), "qualification.modules"); unique(modules.map((item) => item.path), "qualification.modules paths");
    const subjectModules = boundedArray(subject.modules, "qualification.subject.modules").map((item, index) => { const label = `qualification.subject.modules[${index}]`; const module = object(item, label); exact(module, ["moduleId", "sha256"], label); return `${token(module.moduleId, `${label}.moduleId`)}:${sha(module.sha256, `${label}.sha256`)}`; }); unique(subjectModules, "qualification.subject.modules"); const moduleIdentities = modules.map((item) => `${item.moduleId}:${item.sha256}`); if ([...subjectModules].sort().join("\n") !== [...moduleIdentities].sort().join("\n")) throw new TypeError("Subject module set differs from bundle modules.");
    const fixtures = boundedArray(bundle.fixtures, "qualification.fixtures").map((item, index) => { const label = `qualification.fixtures[${index}]`; const fixture = object(item, label); exact(fixture, ["fixtureId", "path", "sha256", "kind"], label); if (fixture.kind !== "qualification-fixture") throw new TypeError(`${label}.kind is invalid.`); return { fixtureId: token(fixture.fixtureId, `${label}.fixtureId`), path: path(fixture.path, `${label}.path`, [".json"]), sha256: sha(fixture.sha256, `${label}.sha256`) }; }); if (fixtures.length === 0) throw new TypeError("Qualification requires at least one semantic fixture."); unique(fixtures.map((item) => item.fixtureId), "qualification.fixtures"); unique(fixtures.map((item) => item.path), "qualification.fixtures paths");
    const fixtureIdentities = new Set(fixtures.map((item) => `${item.fixtureId}:${item.path}:${item.sha256}`)); for (const unit of inventory.value.compileUnits) { const ref = unit.qualificationFixture; if (!fixtureIdentities.has(`${ref.fixtureId}:${ref.path}:${ref.sha256}`)) throw new TypeError(`Compile unit ${unit.compileUnitId} fixture is absent or stale.`); }
    const unitIds = orderedUniqueTokens(subject.requiredCompileUnitIds, "qualification.subject.requiredCompileUnitIds"); const expectedUnits = [...inventory.value.compileUnits.map((unit) => unit.compileUnitId)].sort(); if (unitIds.join("\n") !== expectedUnits.join("\n")) throw new TypeError("Subject compile-unit IDs differ from inventory."); orderedUniqueTokens(subject.requiredCellIds, "qualification.subject.requiredCellIds");
    return { ok: true, value: bundle as unknown as ShaderQualificationBundleManifest };
  } catch (cause) {
    return { ok: false, diagnostics: [{ code: "invalid-contract", severity: "error", message: cause instanceof Error ? cause.message : "Invalid qualification bundle." }] };
  }
}
