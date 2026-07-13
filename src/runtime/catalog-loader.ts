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
import { canonicalizeGpuContract } from "../canonical-json.js";
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

async function verifyBytes(bytes: Uint8Array, expected: string, label: string): Promise<void> {
  const actual = await computeSha256(bytes);
  if (actual !== expected) throw new TypeError(`${label} digest does not match its immutable reference.`);
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function snapshotProfileRef(ref: ShaderStyleProfileRef): ShaderStyleProfileRef {
  const profileId = ref.profileId;
  const version = ref.version;
  const manifestUri = ref.manifestUri;
  const manifestSha256 = ref.manifestSha256;
  return Object.freeze({ profileId, version, manifestUri, manifestSha256 });
}

function snapshotShaderRef(ref: ShaderVersionRef): ShaderVersionRef {
  const shaderId = ref.shaderId;
  const version = ref.version;
  const manifestUri = ref.manifestUri;
  const manifestSha256 = ref.manifestSha256;
  return Object.freeze({ shaderId, version, manifestUri, manifestSha256 });
}

function snapshotInterfaceRef(ref: GpuInterfaceRef): GpuInterfaceRef {
  const interfaceId = ref.interfaceId;
  const interfaceVersion = ref.interfaceVersion;
  const manifestUri = ref.manifestUri;
  const manifestSha256 = ref.manifestSha256;
  const interfaceAbiHash = ref.interfaceAbiHash;
  const modelAbiHash = ref.modelAbiHash;
  return Object.freeze({
    interfaceId,
    interfaceVersion,
    manifestUri,
    manifestSha256,
    interfaceAbiHash,
    modelAbiHash,
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
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
          throw new TypeError(`Distinct shader versions in one style profile reuse the same ${kind}.`);
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
  assertImmutableAssetVersion(ref.interfaceVersion);
  if (!catalog.isCatalogAssetUri(ref.manifestUri)) throw new TypeError("GPU interface URI is outside the promoted catalog root.");
  const loaded = await catalog.loadInterface(ref, signal);
  const bytes = copyBytes(loaded.bytes);
  const promoted = loaded.promoted;
  throwIfAborted(signal);
  if (!promoted) throw new TypeError("GPU interface is not promoted.");
  await verifyBytes(bytes, ref.manifestSha256, "GPU interface manifest");
  const manifest = parseGpuInterfaceManifest(parseJsonBytes(bytes, "GPU interface manifest"));
  if (
    manifest.interfaceId !== ref.interfaceId
    || manifest.interfaceVersion !== ref.interfaceVersion
    || manifest.interfaceAbiHash !== ref.interfaceAbiHash
    || manifest.modelAbiHash !== ref.modelAbiHash
  ) {
    throw new TypeError("GPU interface manifest identity does not match its exact reference.");
  }
  const modelAbiHash = await computeGpuAbiHash({ kind: "model", interface: manifest });
  const interfaceAbiHash = await computeGpuAbiHash({ kind: "interface", interface: manifest });
  if (modelAbiHash !== manifest.modelAbiHash || interfaceAbiHash !== manifest.interfaceAbiHash) {
    throw new TypeError("GPU interface ABI hashes do not match regenerated structural hashes.");
  }
  return manifest;
}

async function loadShader(
  catalog: PromotedShaderCatalogResolver,
  ref: ShaderVersionRef,
  signal?: AbortSignal,
): Promise<LoadedShaderVersion> {
  throwIfAborted(signal);
  assertImmutableAssetVersion(ref.version);
  if (!catalog.isCatalogAssetUri(ref.manifestUri)) throw new TypeError("Shader manifest URI is outside the promoted catalog root.");
  const loaded = await catalog.loadShader(ref, signal);
  const bytes = copyBytes(loaded.bytes);
  const promoted = loaded.promoted;
  throwIfAborted(signal);
  if (!promoted) throw new TypeError("Shader version is not promoted.");
  await verifyBytes(bytes, ref.manifestSha256, "Shader manifest");
  const manifest = parseShaderVersionManifest(parseJsonBytes(bytes, "Shader manifest"));
  if (manifest.shaderId !== ref.shaderId || manifest.version !== ref.version) {
    throw new TypeError("Shader manifest identity does not match its exact reference.");
  }
  for (const evidence of [
    manifest.validationEvidence,
    ...manifest.additionalValidationEvidence.map((item) => item.evidence),
  ]) {
    if (!catalog.isCatalogAssetUri(evidence.uri)) throw new TypeError("Shader validation evidence URI is outside the promoted catalog root.");
    if (!catalog.isCatalogAssetUri(evidence.attestationRef.uri)) throw new TypeError("Shader validation evidence attestation URI is outside the promoted catalog root.");
  }
  const interfaceRef = snapshotInterfaceRef(manifest.gpuInterface);
  const gpuInterface = await loadInterface(catalog, interfaceRef, signal);
  const normalizeModules = (values: readonly { readonly moduleId: string; readonly sha256: string }[]) =>
    [...values].sort((left, right) => left.moduleId < right.moduleId ? -1 : left.moduleId > right.moduleId ? 1 : 0)
      .map(({ moduleId, sha256 }) => ({ moduleId, sha256 }));
  if (canonicalizeGpuContract(normalizeModules(gpuInterface.modules)) !== canonicalizeGpuContract(normalizeModules(manifest.modules))) {
    throw new TypeError("Shader modules differ from the exact reflected GPU interface module set.");
  }
  const shaderAbiHash = await computeGpuAbiHash({
    kind: "shader",
    interface: gpuInterface,
    pipelines: manifest.pipelines,
    requirements: manifest.requirements,
  });
  if (shaderAbiHash !== manifest.shaderAbiHash) throw new TypeError("Shader ABI hash differs from regenerated pipeline/interface ABI.");
  const modulePairs = await mapLimit(manifest.modules, 4, async (module) => {
    throwIfAborted(signal);
    if (!catalog.isCatalogAssetUri(module.uri)) throw new TypeError(`Shader module ${module.moduleId} URI is outside the promoted catalog root.`);
    const asset = await catalog.loadModule(ref, module.moduleId, module.uri, signal);
    const moduleBytes = copyBytes(asset.bytes);
    const promoted = asset.promoted;
    throwIfAborted(signal);
    if (!promoted) throw new TypeError(`Shader module ${module.moduleId} is not promoted.`);
    if (moduleBytes.byteLength !== module.byteLength) {
      throw new TypeError(`Shader module ${module.moduleId} byte length does not match its manifest.`);
    }
    await verifyBytes(moduleBytes, module.sha256, `Shader module ${module.moduleId}`);
    return [module.moduleId, moduleBytes] as const;
  }, signal);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  validateShaderDerivedRequirements({ manifest, gpuInterface, moduleSources: new Map(modulePairs.map(([moduleId, bytes]) => [moduleId, decoder.decode(bytes)])) });
  return { ref, manifest, gpuInterface, modules: new Map(modulePairs) };
}

/** Loads only exact, promoted profile/shader/interface/module assets and verifies every digest. */
export async function loadShaderStyleProfile(input: {
  readonly ref: ShaderStyleProfileRef;
  readonly catalog: PromotedShaderCatalogResolver;
  readonly signal?: AbortSignal;
}): Promise<ShaderResult<LoadedShaderStyleProfile>> {
  const signal = input.signal;
  try {
    throwIfAborted(signal);
    const ref = snapshotProfileRef(input.ref);
    assertImmutableAssetVersion(ref.version);
    if (!input.catalog.isCatalogAssetUri(ref.manifestUri)) throw new TypeError("Style profile URI is outside the promoted catalog root.");
    const loaded = await input.catalog.loadProfile(ref, signal);
    const profileBytes = copyBytes(loaded.bytes);
    const promoted = loaded.promoted;
    throwIfAborted(signal);
    if (!promoted) {
      return { ok: false, diagnostics: [diagnostic("unpromoted-asset", "Style profile is not promoted.")] };
    }
    await verifyBytes(profileBytes, ref.manifestSha256, "Style profile manifest");
    const manifest = parseShaderStyleProfileManifest(parseJsonBytes(profileBytes, "Style profile manifest"));
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
        shader = loadShader(input.catalog, shaderRef, signal);
        cache.set(cacheKey, shader);
      }
      const resolved = await shader;
      if (!resolved.manifest.renderRoles.some((role) => role.role === binding.role)) {
        throw new TypeError(`Shader ${resolved.manifest.shaderId} does not implement role ${binding.role}.`);
      }
      const validationScopes = new Map(
        resolved.manifest.additionalValidationEvidence.map((item) => [item.scope, item.evidence]),
      );
      for (const requirement of manifest.requiredValidationScopes) {
        const evidence = validationScopes.get(requirement.scope);
        if (!evidence) {
          throw new TypeError(`Shader ${resolved.manifest.shaderId} lacks required validation scope ${requirement.scope}.`);
        }
        if (
          evidence.matrixId !== requirement.matrixId
          || evidence.matrixVersion !== requirement.matrixVersion
          || evidence.matrixSha256 !== requirement.matrixSha256
        ) {
          throw new TypeError(
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
    if (signal?.aborted) throw cause;
    const code = cause instanceof TypeError && /digest/u.test(cause.message)
      ? "digest-mismatch"
      : "invalid-contract";
    return {
      ok: false,
      diagnostics: [diagnostic(code, cause instanceof Error ? cause.message : "Style profile loading failed.")],
    };
  }
}
