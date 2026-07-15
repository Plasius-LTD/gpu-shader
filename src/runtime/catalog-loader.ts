import type {
  GpuInterfaceRef,
  LoadedShaderStyleProfile,
  LoadedShaderVersion,
  PromotedShaderCatalogResolver,
  ShaderDiagnostic,
  ShaderRenderRole,
  ShaderResult,
  ShaderStyleProfileRef,
  ShaderValidationEvidenceRef,
  ShaderVersionRef,
} from "../contracts.js";
import {
  canonicalizeGpuContract,
  GPU_CONTRACT_SNAPSHOT_LIMITS,
  snapshotGpuContract,
  snapshotUint8Array,
} from "../canonical-json.js";
import { assertImmutableAssetVersion } from "../asset-version.js";
import { computeGpuAbiHash, computeSha256 } from "../hash.js";
import {
  parseGpuInterfaceManifest,
  parseJsonBytes,
  parseShaderStyleProfileManifest,
  parseShaderVersionManifest,
} from "../manifest-validation.js";
import { validateShaderDerivedRequirements } from "../requirements-validation.js";
import { trustLoadedShaderStyleProfile } from "./trusted-values.js";

function diagnostic(code: ShaderDiagnostic["code"], message: string, path?: string): ShaderDiagnostic {
  return { code, severity: "error", message, ...(path ? { path } : {}) };
}

class CatalogLoadError extends TypeError {
  readonly diagnosticCode: ShaderDiagnostic["code"];

  constructor(message: string, diagnosticCode: ShaderDiagnostic["code"] = "invalid-contract") {
    super(message);
    this.name = "CatalogLoadError";
    this.diagnosticCode = diagnosticCode;
  }
}

function catalogFailure(
  message: string,
  diagnosticCode: ShaderDiagnostic["code"] = "invalid-contract",
): CatalogLoadError {
  return new CatalogLoadError(message, diagnosticCode);
}

function catalogContractStep<T>(operation: () => T, fallback: string): T {
  try {
    return operation();
  } catch (cause) {
    if (cause instanceof CatalogLoadError) throw cause;
    throw catalogFailure(cause instanceof TypeError ? cause.message : fallback);
  }
}

async function catalogContractStepAsync<T>(
  operation: () => Promise<T>,
  fallback: string,
): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof CatalogLoadError) throw cause;
    throw catalogFailure(cause instanceof TypeError ? cause.message : fallback);
  }
}

async function verifyBytes(bytes: Uint8Array, expected: string, label: string): Promise<void> {
  const actual = await catalogContractStepAsync(
    () => computeSha256(bytes),
    `${label} digest could not be computed.`,
  );
  if (actual !== expected) {
    throw catalogFailure(
      `${label} digest does not match its immutable reference.`,
      "digest-mismatch",
    );
  }
}

type CatalogAssetBytes = { readonly bytes: Uint8Array; readonly promoted: boolean };

function inspectCatalogAsset(
  value: unknown,
  label: string,
  maximumBytes: number,
): CatalogAssetBytes {
  try {
    if (typeof value !== "object" || value === null) throw new TypeError();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes("bytes") || !keys.includes("promoted")) {
      throw new TypeError();
    }
    const bytes = Reflect.getOwnPropertyDescriptor(value, "bytes");
    const promoted = Reflect.getOwnPropertyDescriptor(value, "promoted");
    if (
      !bytes?.enumerable
      || !Object.hasOwn(bytes, "value")
      || !promoted?.enumerable
      || !Object.hasOwn(promoted, "value")
      || typeof promoted.value !== "boolean"
    ) {
      throw new TypeError();
    }
    return Object.freeze({
      bytes: snapshotUint8Array(bytes.value, maximumBytes),
      promoted: promoted.value,
    });
  } catch {
    throw catalogFailure(`${label} returned invalid detached asset bytes.`);
  }
}

async function loadCatalogAsset(
  operation: () => Promise<unknown>,
  label: string,
  maximumBytes: number,
): Promise<CatalogAssetBytes> {
  let value: unknown;
  try {
    value = await operation();
  } catch {
    throw catalogFailure(`${label} provider request failed.`);
  }
  return inspectCatalogAsset(value, label, maximumBytes);
}

function isCatalogAssetUri(
  catalog: PromotedShaderCatalogResolver,
  uri: string,
): boolean {
  try {
    const result = catalog.isCatalogAssetUri(uri);
    if (typeof result !== "boolean") throw new TypeError();
    return result;
  } catch {
    throw catalogFailure("Promoted catalog URI validation failed.");
  }
}

function inspectLoadRequest(value: unknown): {
  readonly ref: ShaderStyleProfileRef;
  readonly catalog: PromotedShaderCatalogResolver;
  readonly signal?: AbortSignal;
} {
  try {
    if (typeof value !== "object" || value === null) throw new TypeError();
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string" || !["ref", "catalog", "signal"].includes(key))
      || !keys.includes("ref")
      || !keys.includes("catalog")
    ) {
      throw new TypeError();
    }
    const ref = Reflect.getOwnPropertyDescriptor(value, "ref");
    const catalog = Reflect.getOwnPropertyDescriptor(value, "catalog");
    const signal = Reflect.getOwnPropertyDescriptor(value, "signal");
    if (
      !ref?.enumerable
      || !Object.hasOwn(ref, "value")
      || !catalog?.enumerable
      || !Object.hasOwn(catalog, "value")
      || (signal !== undefined && (!signal.enumerable || !Object.hasOwn(signal, "value")))
    ) {
      throw new TypeError();
    }
    return Object.freeze({
      ref: ref.value as ShaderStyleProfileRef,
      catalog: catalog.value as PromotedShaderCatalogResolver,
      ...(signal === undefined ? {} : { signal: signal.value as AbortSignal | undefined }),
    });
  } catch {
    throw catalogFailure("Style profile load request must use enumerable own data properties.");
  }
}

function referenceObject(value: unknown, keys: readonly string[], label: string): Record<string, string> {
  let snapshot: unknown;
  try {
    snapshot = snapshotGpuContract(value);
  } catch {
    throw catalogFailure(`${label} must contain bounded detached JSON contract data.`);
  }
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    throw catalogFailure(`${label} must be an object.`);
  }
  const record = snapshot as Readonly<Record<string, unknown>>;
  const actual = Object.keys(record);
  if (actual.some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(record, key))
    || actual.some((key) => typeof record[key] !== "string")) {
    throw catalogFailure(`${label} has unknown, missing, or non-string fields.`);
  }
  return record as Record<string, string>;
}

function snapshotProfileRef(ref: ShaderStyleProfileRef): ShaderStyleProfileRef {
  const value = referenceObject(ref, ["profileId", "version", "manifestUri", "manifestSha256"], "Style profile reference");
  const profileId = value.profileId!;
  const version = value.version!;
  const manifestUri = value.manifestUri!;
  const manifestSha256 = value.manifestSha256! as ShaderStyleProfileRef["manifestSha256"];
  return Object.freeze({ profileId, version, manifestUri, manifestSha256 });
}

function snapshotShaderRef(ref: ShaderVersionRef): ShaderVersionRef {
  const value = referenceObject(ref, ["shaderId", "version", "manifestUri", "manifestSha256"], "Shader version reference");
  const shaderId = value.shaderId!;
  const version = value.version!;
  const manifestUri = value.manifestUri!;
  const manifestSha256 = value.manifestSha256! as ShaderVersionRef["manifestSha256"];
  return Object.freeze({ shaderId, version, manifestUri, manifestSha256 });
}

function snapshotInterfaceRef(ref: GpuInterfaceRef): GpuInterfaceRef {
  const value = referenceObject(ref, ["interfaceId", "interfaceVersion", "manifestUri", "manifestSha256", "interfaceAbiHash", "modelAbiHash"], "GPU interface reference");
  const interfaceId = value.interfaceId!;
  const interfaceVersion = value.interfaceVersion!;
  const manifestUri = value.manifestUri!;
  const manifestSha256 = value.manifestSha256! as GpuInterfaceRef["manifestSha256"];
  const interfaceAbiHash = value.interfaceAbiHash! as GpuInterfaceRef["interfaceAbiHash"];
  const modelAbiHash = value.modelAbiHash! as GpuInterfaceRef["modelAbiHash"];
  return Object.freeze({
    interfaceId,
    interfaceVersion,
    manifestUri,
    manifestSha256,
    interfaceAbiHash,
    modelAbiHash,
  });
}

function assertCatalogAssetVersion(value: string, label: string): void {
  try {
    assertImmutableAssetVersion(value);
  } catch {
    throw catalogFailure(`${label} must use an immutable asset version represented by an exact token.`);
  }
}

const ABORTED_GETTER = typeof AbortSignal === "undefined"
  ? undefined
  : Reflect.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal === undefined) return;
  let aborted: unknown;
  try {
    if (!ABORTED_GETTER) throw new TypeError();
    aborted = Reflect.apply(ABORTED_GETTER, signal, []);
  } catch {
    throw catalogFailure("Abort signal could not be inspected safely.");
  }
  if (aborted === true) throw new DOMException("Aborted", "AbortError");
}

function exactShaderRefKey(ref: ShaderVersionRef): string {
  return `${ref.shaderId}\u0000${ref.version}\u0000${ref.manifestUri}\u0000${ref.manifestSha256}`;
}

function evidenceArtifacts(evidence: ShaderValidationEvidenceRef): readonly [string, string, string, string, string] {
  return [
    evidence.evidenceId,
    evidence.uri,
    evidence.sha256,
    evidence.attestationRef.uri,
    evidence.attestationRef.sha256,
  ];
}

function assertDistinctEvidenceOwnership(shaders: readonly LoadedShaderVersion[]): void {
  const uniqueShaders = new Map<string, LoadedShaderVersion>();
  for (const shader of shaders) uniqueShaders.set(exactShaderRefKey(shader.ref), shader);
  const evidenceIds = new Map<string, string>();
  const artifactUris = new Map<string, string>();
  const artifactDigests = new Map<string, string>();
  for (const [shaderKey, shader] of uniqueShaders) {
    const evidenceValues = [
      shader.manifest.validationEvidence,
      ...shader.manifest.additionalValidationEvidence.map((item) => item.evidence),
    ];
    for (const evidence of evidenceValues) {
      const [evidenceId, evidenceUri, evidenceSha256, attestationUri, attestationSha256] = evidenceArtifacts(evidence);
      for (const [kind, value, owners] of [
        ["evidence ID", evidenceId, evidenceIds],
        ["evidence/attestation URI", evidenceUri, artifactUris],
        ["evidence/attestation URI", attestationUri, artifactUris],
        ["evidence/attestation digest", evidenceSha256, artifactDigests],
        ["evidence/attestation digest", attestationSha256, artifactDigests],
      ] as const) {
        const owner = owners.get(value);
        if (owner !== undefined && owner !== shaderKey) {
          throw catalogFailure(`Distinct shader versions in one style profile reuse the same ${kind}.`);
        }
        owners.set(value, shaderKey);
      }
    }
  }
}

async function mapLimit<T, U>(
  values: readonly T[],
  limit: number,
  operation: (value: T, index: number) => Promise<U>,
  signal?: AbortSignal,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      throwIfAborted(signal);
      const index = next++;
      const value = values[index];
      if (value !== undefined) { throwIfAborted(signal); results[index] = await operation(value, index); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

async function loadInterface(
  catalog: PromotedShaderCatalogResolver,
  ref: GpuInterfaceRef,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  assertCatalogAssetVersion(ref.interfaceVersion, "GPU interface reference");
  if (!isCatalogAssetUri(catalog, ref.manifestUri)) throw catalogFailure("GPU interface URI is outside the promoted catalog root.");
  const loaded = await loadCatalogAsset(
    () => catalog.loadInterface(ref, signal),
    "GPU interface",
    GPU_CONTRACT_SNAPSHOT_LIMITS.maximumInputBytes,
  );
  const bytes = loaded.bytes;
  const promoted = loaded.promoted;
  throwIfAborted(signal);
  if (!promoted) throw catalogFailure("GPU interface is not promoted.", "unpromoted-asset");
  await verifyBytes(bytes, ref.manifestSha256, "GPU interface manifest");
  const manifest = catalogContractStep(
    () => parseGpuInterfaceManifest(parseJsonBytes(bytes, "GPU interface manifest")),
    "GPU interface manifest failed strict contract validation.",
  );
  if (
    manifest.interfaceId !== ref.interfaceId
    || manifest.interfaceVersion !== ref.interfaceVersion
    || manifest.interfaceAbiHash !== ref.interfaceAbiHash
    || manifest.modelAbiHash !== ref.modelAbiHash
  ) {
    throw catalogFailure("GPU interface manifest identity does not match its exact reference.");
  }
  const modelAbiHash = await catalogContractStepAsync(
    () => computeGpuAbiHash({ kind: "model", interface: manifest }),
    "GPU interface model ABI hash regeneration failed.",
  );
  const interfaceAbiHash = await catalogContractStepAsync(
    () => computeGpuAbiHash({ kind: "interface", interface: manifest }),
    "GPU interface ABI hash regeneration failed.",
  );
  if (modelAbiHash !== manifest.modelAbiHash || interfaceAbiHash !== manifest.interfaceAbiHash) {
    throw catalogFailure("GPU interface ABI hashes do not match regenerated structural hashes.");
  }
  return manifest;
}

async function loadShader(
  catalog: PromotedShaderCatalogResolver,
  ref: ShaderVersionRef,
  signal?: AbortSignal,
): Promise<LoadedShaderVersion> {
  throwIfAborted(signal);
  assertCatalogAssetVersion(ref.version, "Shader reference");
  if (!isCatalogAssetUri(catalog, ref.manifestUri)) throw catalogFailure("Shader manifest URI is outside the promoted catalog root.");
  const loaded = await loadCatalogAsset(
    () => catalog.loadShader(ref, signal),
    "Shader manifest",
    GPU_CONTRACT_SNAPSHOT_LIMITS.maximumInputBytes,
  );
  const bytes = loaded.bytes;
  const promoted = loaded.promoted;
  throwIfAborted(signal);
  if (!promoted) throw catalogFailure("Shader version is not promoted.", "unpromoted-asset");
  await verifyBytes(bytes, ref.manifestSha256, "Shader manifest");
  const manifest = catalogContractStep(
    () => parseShaderVersionManifest(parseJsonBytes(bytes, "Shader manifest")),
    "Shader manifest failed strict contract validation.",
  );
  if (manifest.shaderId !== ref.shaderId || manifest.version !== ref.version) {
    throw catalogFailure("Shader manifest identity does not match its exact reference.");
  }
  for (const evidence of [
    manifest.validationEvidence,
    ...manifest.additionalValidationEvidence.map((item) => item.evidence),
  ]) {
    if (!isCatalogAssetUri(catalog, evidence.uri)) throw catalogFailure("Shader validation evidence URI is outside the promoted catalog root.");
    if (!isCatalogAssetUri(catalog, evidence.attestationRef.uri)) throw catalogFailure("Shader validation evidence attestation URI is outside the promoted catalog root.");
  }
  const interfaceRef = snapshotInterfaceRef(manifest.gpuInterface);
  const gpuInterface = await loadInterface(catalog, interfaceRef, signal);
  const normalizeModules = (values: readonly { readonly moduleId: string; readonly sha256: string }[]) =>
    [...values].sort((left, right) => left.moduleId < right.moduleId ? -1 : left.moduleId > right.moduleId ? 1 : 0)
      .map(({ moduleId, sha256 }) => ({ moduleId, sha256 }));
  if (catalogContractStep(
    () => canonicalizeGpuContract(normalizeModules(gpuInterface.modules))
      !== canonicalizeGpuContract(normalizeModules(manifest.modules)),
    "Shader module-set comparison failed.",
  )) {
    throw catalogFailure("Shader modules differ from the exact reflected GPU interface module set.");
  }
  const shaderAbiHash = await catalogContractStepAsync(
    () => computeGpuAbiHash({
      kind: "shader",
      interface: gpuInterface,
      pipelines: manifest.pipelines,
      requirements: manifest.requirements,
    }),
    "Shader ABI hash regeneration failed.",
  );
  if (shaderAbiHash !== manifest.shaderAbiHash) throw catalogFailure("Shader ABI hash differs from regenerated pipeline/interface ABI.");
  const modulePairs = await mapLimit(manifest.modules, 4, async (module) => {
    throwIfAborted(signal);
    if (!isCatalogAssetUri(catalog, module.uri)) throw catalogFailure(`Shader module ${module.moduleId} URI is outside the promoted catalog root.`);
    const asset = await loadCatalogAsset(
      () => catalog.loadModule(ref, module.moduleId, module.uri, signal),
      `Shader module ${module.moduleId}`,
      module.byteLength,
    );
    const moduleBytes = asset.bytes;
    const promoted = asset.promoted;
    throwIfAborted(signal);
    if (!promoted) throw catalogFailure(`Shader module ${module.moduleId} is not promoted.`, "unpromoted-asset");
    if (moduleBytes.byteLength !== module.byteLength) {
      throw catalogFailure(`Shader module ${module.moduleId} byte length does not match its manifest.`);
    }
    await verifyBytes(moduleBytes, module.sha256, `Shader module ${module.moduleId}`);
    return [module.moduleId, moduleBytes] as const;
  }, signal);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  catalogContractStep(
    () => validateShaderDerivedRequirements({ manifest, gpuInterface, moduleSources: new Map(modulePairs.map(([moduleId, bytes]) => [moduleId, decoder.decode(bytes)])) }),
    "Shader source requirement validation failed.",
  );
  return { ref, manifest, gpuInterface, modules: new Map(modulePairs) };
}

/** Loads only exact, promoted profile/shader/interface/module assets and verifies every digest. */
export async function loadShaderStyleProfile(input: {
  readonly ref: ShaderStyleProfileRef;
  readonly catalog: PromotedShaderCatalogResolver;
  readonly signal?: AbortSignal;
}): Promise<ShaderResult<LoadedShaderStyleProfile>> {
  try {
    const request = inspectLoadRequest(input);
    const signal = request.signal;
    const catalog = request.catalog;
    throwIfAborted(signal);
    const ref = snapshotProfileRef(request.ref);
    assertCatalogAssetVersion(ref.version, "Style profile reference");
    if (!isCatalogAssetUri(catalog, ref.manifestUri)) throw catalogFailure("Style profile URI is outside the promoted catalog root.");
    const loaded = await loadCatalogAsset(
      () => catalog.loadProfile(ref, signal),
      "Style profile",
      GPU_CONTRACT_SNAPSHOT_LIMITS.maximumInputBytes,
    );
    const profileBytes = loaded.bytes;
    const promoted = loaded.promoted;
    throwIfAborted(signal);
    if (!promoted) {
      return { ok: false, diagnostics: [diagnostic("unpromoted-asset", "Style profile is not promoted.")] };
    }
    await verifyBytes(profileBytes, ref.manifestSha256, "Style profile manifest");
    const manifest = catalogContractStep(
      () => parseShaderStyleProfileManifest(parseJsonBytes(profileBytes, "Style profile manifest")),
      "Style profile manifest failed strict contract validation.",
    );
    if (manifest.profileId !== ref.profileId || manifest.version !== ref.version) {
      return { ok: false, diagnostics: [diagnostic("invalid-contract", "Style profile identity does not match its exact reference.")] };
    }
    const cache = new Map<string, Promise<LoadedShaderVersion>>();
    const pairs = await mapLimit(manifest.roles, 4, async (binding) => {
      throwIfAborted(signal);
      const shaderRef = snapshotShaderRef(binding.shader);
      const cacheKey = exactShaderRefKey(shaderRef);
      let shader = cache.get(cacheKey);
      if (!shader) {
        shader = loadShader(catalog, shaderRef, signal);
        cache.set(cacheKey, shader);
      }
      const resolved = await shader;
      if (!resolved.manifest.renderRoles.some((role) => role.role === binding.role)) {
        throw catalogFailure(`Shader ${resolved.manifest.shaderId} does not implement role ${binding.role}.`);
      }
      const validationScopes = new Map(
        resolved.manifest.additionalValidationEvidence.map((item) => [item.scope, item.evidence]),
      );
      for (const requirement of manifest.requiredValidationScopes) {
        const evidence = validationScopes.get(requirement.scope);
        if (!evidence) {
          throw catalogFailure(`Shader ${resolved.manifest.shaderId} lacks required validation scope ${requirement.scope}.`);
        }
        if (
          evidence.matrixId !== requirement.matrixId
          || evidence.matrixVersion !== requirement.matrixVersion
          || evidence.matrixSha256 !== requirement.matrixSha256
        ) {
          throw catalogFailure(
            `Shader ${resolved.manifest.shaderId} validation scope ${requirement.scope} is bound to a different matrix policy.`,
          );
        }
      }
      return [binding.role, resolved] as const;
    }, signal);
    assertDistinctEvidenceOwnership(pairs.map(([, shader]) => shader));
    return {
      ok: true,
      value: trustLoadedShaderStyleProfile({
        ref,
        manifest,
        shaders: new Map<ShaderRenderRole, LoadedShaderVersion>(pairs),
      }),
    };
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    const known = cause instanceof CatalogLoadError ? cause : undefined;
    return {
      ok: false,
      diagnostics: [diagnostic(
        known?.diagnosticCode ?? "invalid-contract",
        known?.message ?? "Style profile loading failed.",
      )],
    };
  }
}
