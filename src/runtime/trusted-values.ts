import type {
  GpuInterfaceManifest,
  LoadedShaderStyleProfile,
  LoadedShaderVersion,
  PreparedShaderStyleProfile,
  ShaderRenderRole,
  ShaderStyleProfileManifest,
  ShaderStyleProfileRef,
  ShaderVersionManifest,
  ShaderVersionRef,
} from "../contracts.js";

/** Internal immutable data retained independently from caller-visible runtime values. */
export interface TrustedLoadedShaderVersion {
  readonly publicValue: LoadedShaderVersion;
  readonly ref: ShaderVersionRef;
  readonly manifest: ShaderVersionManifest;
  readonly gpuInterface: GpuInterfaceManifest;
  readonly modules: ReadonlyMap<string, Uint8Array>;
}

/** Internal immutable profile state created only at the catalog-loading boundary. */
export interface TrustedLoadedShaderStyleProfile {
  readonly publicValue: LoadedShaderStyleProfile;
  readonly ref: ShaderStyleProfileRef;
  readonly manifest: ShaderStyleProfileManifest;
  readonly shaders: ReadonlyMap<ShaderRenderRole, TrustedLoadedShaderVersion>;
}

class ReadonlyMapView<K, V> implements ReadonlyMap<K, V> {
  readonly #source: ReadonlyMap<K, V>;

  constructor(source: ReadonlyMap<K, V>) {
    this.#source = source;
    Object.freeze(this);
  }

  get size(): number { return this.#source.size; }
  get(key: K): V | undefined { return this.#source.get(key); }
  has(key: K): boolean { return this.#source.has(key); }
  entries(): MapIterator<[K, V]> { return this.#source.entries(); }
  keys(): MapIterator<K> { return this.#source.keys(); }
  values(): MapIterator<V> { return this.#source.values(); }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.#source[Symbol.iterator](); }

  forEach(
    callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#source) callbackfn.call(thisArg, value, key, this);
  }
}

const loadedProfiles = new WeakMap<object, TrustedLoadedShaderStyleProfile>();
const preparedProfiles = new WeakSet<object>();

function immutableSnapshot<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => immutableSnapshot(item))) as T;
  }
  if (typeof value !== "object" || value === null) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = immutableSnapshot(item);
  }
  return Object.freeze(output) as T;
}

/** Creates a mutation-isolated public map facade over private runtime state. */
export function readonlyMapView<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  return new ReadonlyMapView(source);
}

/**
 * Copies and brands a catalog-loaded profile. This module is intentionally not a
 * package export; public callers can obtain branded values only through loading.
 */
export function trustLoadedShaderStyleProfile(
  raw: LoadedShaderStyleProfile,
): LoadedShaderStyleProfile {
  const shaderMemo = new Map<LoadedShaderVersion, TrustedLoadedShaderVersion>();
  const trustedShaders = new Map<ShaderRenderRole, TrustedLoadedShaderVersion>();
  const publicShaders = new Map<ShaderRenderRole, LoadedShaderVersion>();

  for (const [role, rawShader] of raw.shaders) {
    let trusted = shaderMemo.get(rawShader);
    if (!trusted) {
      const ref = immutableSnapshot(rawShader.ref);
      const manifest = immutableSnapshot(rawShader.manifest);
      const gpuInterface = immutableSnapshot(rawShader.gpuInterface);
      const privateModules = new Map<string, Uint8Array>();
      const publicModules = new Map<string, Uint8Array>();
      for (const [moduleId, bytes] of rawShader.modules) {
        const privateBytes = new Uint8Array(bytes);
        privateModules.set(moduleId, privateBytes);
        publicModules.set(moduleId, new Uint8Array(privateBytes));
      }
      const publicValue = Object.freeze({
        ref,
        manifest,
        gpuInterface,
        modules: readonlyMapView(publicModules),
      } satisfies LoadedShaderVersion);
      trusted = Object.freeze({
        publicValue,
        ref,
        manifest,
        gpuInterface,
        modules: readonlyMapView(privateModules),
      });
      shaderMemo.set(rawShader, trusted);
    }
    trustedShaders.set(role, trusted);
    publicShaders.set(role, trusted.publicValue);
  }

  const ref = immutableSnapshot(raw.ref);
  const manifest = immutableSnapshot(raw.manifest);
  const publicValue = Object.freeze({
    ref,
    manifest,
    shaders: readonlyMapView(publicShaders),
  } satisfies LoadedShaderStyleProfile);
  loadedProfiles.set(publicValue, Object.freeze({
    publicValue,
    ref,
    manifest,
    shaders: readonlyMapView(trustedShaders),
  }));
  return publicValue;
}

/** Rejects values that did not cross the promoted catalog loading boundary. */
export function requireTrustedLoadedShaderStyleProfile(
  value: LoadedShaderStyleProfile,
): TrustedLoadedShaderStyleProfile {
  const trusted = loadedProfiles.get(value as object);
  if (!trusted) {
    throw new TypeError("loaded must be returned by loadShaderStyleProfile.");
  }
  return trusted;
}

/** Brands and freezes a successfully prepared profile for controller admission. */
export function trustPreparedShaderStyleProfile<T extends PreparedShaderStyleProfile>(value: T): T {
  preparedProfiles.add(value as object);
  return Object.freeze(value);
}

/** Rejects structurally forged prepared profiles before frame-boundary activation. */
export function requireTrustedPreparedShaderStyleProfile(value: PreparedShaderStyleProfile): void {
  if (!preparedProfiles.has(value as object)) {
    throw new TypeError("prepared must be returned by prepareStyleProfile.");
  }
}
