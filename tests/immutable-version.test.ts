import { describe, expect, it, vi } from "vitest";

import { canonicalizeGpuContract } from "../src/canonical-json.js";
import { validateModelShaderCompatibility } from "../src/compatibility.js";
import type {
  GpuInterfaceManifest,
  PromotedShaderCatalogResolver,
  ShaderStyleProfileManifest,
  ShaderStyleProfileRef,
  ShaderVersionManifest,
} from "../src/contracts.js";
import { computeSha256 } from "../src/hash.js";
import {
  parseGpuInterfaceManifest,
  parseModelGpuCompatibilityDescriptor,
  parseShaderStyleProfileManifest,
  parseShaderVersionManifest,
} from "../src/manifest-validation.js";
import { loadShaderStyleProfile } from "../src/runtime/catalog-loader.js";
import { assertImmutableAssetVersion } from "../src/index.js";
import { clone, promotedCatalog, shaderAssets } from "./fixtures.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const INVALID_IMMUTABLE_VERSIONS = [
  "latest",
  "CURRENT",
  "Stable",
  "preview",
  "DEFAULT",
  "production",
  "Canary",
  "next",
  "HEAD",
  "main",
  "1.x",
  "1.x.preview",
  "vX",
  "v2.X",
  "1.*",
  "^1.2.3",
  ">=1.2.3",
  "1.2.3 || 2.0.0",
  "https://assets.example.invalid/version/1.0.0",
  "mcp://models/catalog/version",
  "versions/1.0.0",
  "versions\\1.0.0",
] as const;

async function encoded(value: unknown): Promise<{
  readonly bytes: Uint8Array;
  readonly sha256: string;
}> {
  const bytes = new TextEncoder().encode(canonicalizeGpuContract(value));
  return { bytes, sha256: await computeSha256(bytes) };
}

describe("immutable GPU asset versions", () => {
  it("exports one browser-safe exact-version validator", () => {
    for (const version of ["1", "v1", "1.2.3", "2026.07.13-a1", "build-x"]) {
      expect(assertImmutableAssetVersion(version)).toBe(version);
    }

    for (const version of INVALID_IMMUTABLE_VERSIONS) {
      expect(() => assertImmutableAssetVersion(version), version).toThrow(
        /Immutable asset version.*exact token.*mutable aliases.*ranges.*wildcards.*URLs/u,
      );
    }

    let error: unknown;
    try {
      assertImmutableAssetVersion("x".repeat(10_000));
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message.length).toBeLessThan(180);
  });

  it("rejects mutable versions in every manifest and reference position", async () => {
    const assets = await shaderAssets();
    const error = /immutable asset version.*exact token/iu;

    const gpuInterface = clone(assets.gpuInterface) as Mutable<GpuInterfaceManifest>;
    gpuInterface.interfaceVersion = "latest";
    expect(() => parseGpuInterfaceManifest(gpuInterface)).toThrow(error);

    const shader = clone(assets.shaderManifest) as Mutable<ShaderVersionManifest>;
    shader.version = "default";
    expect(() => parseShaderVersionManifest(shader)).toThrow(error);

    const shaderInterface = clone(assets.shaderManifest);
    (shaderInterface.gpuInterface as Mutable<typeof shaderInterface.gpuInterface>).interfaceVersion = "1.x";
    expect(() => parseShaderVersionManifest(shaderInterface)).toThrow(error);

    const compatibleShader = clone(assets.shaderManifest);
    (compatibleShader.compatibleModelInterfaces[0] as Mutable<typeof compatibleShader.compatibleModelInterfaces[number]>).interfaceVersion = "main";
    expect(() => parseShaderVersionManifest(compatibleShader)).toThrow(error);

    const profile = clone(assets.profileManifest) as Mutable<ShaderStyleProfileManifest>;
    profile.version = "CURRENT";
    expect(() => parseShaderStyleProfileManifest(profile)).toThrow(error);

    const profileShader = clone(assets.profileManifest);
    (profileShader.roles[0]!.shader as Mutable<typeof profileShader.roles[number]["shader"]>).version = "v2.X";
    expect(() => parseShaderStyleProfileManifest(profileShader)).toThrow(error);

    const compatibleProfile = clone(assets.profileManifest);
    (compatibleProfile.compatibleModelInterfaces[0] as Mutable<typeof compatibleProfile.compatibleModelInterfaces[number]>).interfaceVersion = "stable";
    expect(() => parseShaderStyleProfileManifest(compatibleProfile)).toThrow(error);

    const model = clone(assets.model);
    (model as Mutable<typeof model>).version = "preview";
    expect(() => parseModelGpuCompatibilityDescriptor(model)).toThrow(error);

    const modelInterface = clone(assets.model);
    (modelInterface.gpuInterface as Mutable<typeof modelInterface.gpuInterface>).interfaceVersion = "HEAD";
    expect(() => parseModelGpuCompatibilityDescriptor(modelInterface)).toThrow(error);

    const modelProfile = clone(assets.model);
    (modelProfile.defaultStyleProfile as Mutable<NonNullable<typeof modelProfile.defaultStyleProfile>>).version = "next";
    expect(() => parseModelGpuCompatibilityDescriptor(modelProfile)).toThrow(error);
  });

  it("detaches version accessors before returning strict parsed contracts", async () => {
    const assets = await shaderAssets();
    const cases = [
      [clone(assets.gpuInterface), "interfaceVersion", parseGpuInterfaceManifest],
      [clone(assets.shaderManifest), "version", parseShaderVersionManifest],
      [clone(assets.profileManifest), "version", parseShaderStyleProfileManifest],
      [clone(assets.model), "version", parseModelGpuCompatibilityDescriptor],
    ] as const;

    for (const [contract, field, parse] of cases) {
      const exact = Reflect.get(contract, field) as string;
      let reads = 0;
      Object.defineProperty(contract, field, {
        configurable: true,
        enumerable: true,
        get: () => reads++ === 0 ? exact : "latest",
      });

      const parsed = parse(contract as never) as unknown as Record<string, unknown>;
      expect(parsed[field]).toBe(exact);
      expect(reads).toBe(1);
      expect(Object.isFrozen(parsed)).toBe(true);
    }
  });

  it("rejects a mutable top-level profile ref before any catalog access", async () => {
    const assets = await shaderAssets();
    const catalog = await promotedCatalog();
    const loadProfile = vi.spyOn(catalog, "loadProfile");
    const isCatalogAssetUri = vi.spyOn(catalog, "isCatalogAssetUri");

    const result = await loadShaderStyleProfile({
      ref: { ...assets.profileRef, version: "latest" },
      catalog,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: "invalid-contract",
          message: expect.stringMatching(/immutable asset version.*exact token/iu),
        }),
      ]);
    }
    expect(isCatalogAssetUri).not.toHaveBeenCalled();
    expect(loadProfile).not.toHaveBeenCalled();
  });

  it("rejects mutable nested shader and interface refs before resolving them", async () => {
    const assets = await shaderAssets();

    const profile = clone(assets.profileManifest);
    (profile.roles[0]!.shader as Mutable<typeof profile.roles[number]["shader"]>).version = "default";
    const profileArtifact = await encoded(profile);
    const loadShader = vi.fn<PromotedShaderCatalogResolver["loadShader"]>();
    const profileCatalog = await promotedCatalog({
      loadProfile: async () => ({ bytes: profileArtifact.bytes, promoted: true }),
      loadShader,
    });
    const profileRef: ShaderStyleProfileRef = {
      ...assets.profileRef,
      manifestSha256: profileArtifact.sha256 as ShaderStyleProfileRef["manifestSha256"],
    };

    const profileResult = await loadShaderStyleProfile({ ref: profileRef, catalog: profileCatalog });
    expect(profileResult.ok).toBe(false);
    if (!profileResult.ok) expect(profileResult.diagnostics[0]?.message).toMatch(/immutable asset version.*exact token/iu);
    expect(loadShader).not.toHaveBeenCalled();

    const shader = clone(assets.shaderManifest);
    (shader.gpuInterface as Mutable<typeof shader.gpuInterface>).interfaceVersion = "1.*";
    const shaderArtifact = await encoded(shader);
    const validProfile = clone(assets.profileManifest);
    (validProfile.roles[0]!.shader as Mutable<typeof validProfile.roles[number]["shader"]>).manifestSha256 =
      shaderArtifact.sha256 as typeof validProfile.roles[number]["shader"]["manifestSha256"];
    const validProfileArtifact = await encoded(validProfile);
    const loadInterface = vi.fn<PromotedShaderCatalogResolver["loadInterface"]>();
    const shaderCatalog = await promotedCatalog({
      loadProfile: async () => ({ bytes: validProfileArtifact.bytes, promoted: true }),
      loadShader: async () => ({ bytes: shaderArtifact.bytes, promoted: true }),
      loadInterface,
    });
    const validProfileRef: ShaderStyleProfileRef = {
      ...assets.profileRef,
      manifestSha256: validProfileArtifact.sha256 as ShaderStyleProfileRef["manifestSha256"],
    };

    const shaderResult = await loadShaderStyleProfile({ ref: validProfileRef, catalog: shaderCatalog });
    expect(shaderResult.ok).toBe(false);
    if (!shaderResult.ok) expect(shaderResult.diagnostics[0]?.message).toMatch(/immutable asset version.*exact token/iu);
    expect(loadInterface).not.toHaveBeenCalled();
  });

  it("snapshots a validated profile ref before giving it to the catalog", async () => {
    const assets = await shaderAssets();
    const base = await promotedCatalog();
    let versionReads = 0;
    let observedVersion: string | undefined;
    const ref = { ...assets.profileRef } as Mutable<ShaderStyleProfileRef>;
    Object.defineProperty(ref, "version", {
      enumerable: true,
      get: () => versionReads++ === 0 ? assets.profileRef.version : "latest",
    });
    const catalog: PromotedShaderCatalogResolver = {
      ...base,
      loadProfile: async (resolved, signal) => {
        observedVersion = resolved.version;
        return base.loadProfile(resolved, signal);
      },
    };

    const result = await loadShaderStyleProfile({ ref, catalog });

    expect(result.ok).toBe(true);
    expect(observedVersion).toBe(assets.profileRef.version);
    expect(versionReads).toBe(1);
  });

  it("fails direct compatibility checks closed for mutable model contracts", async () => {
    const assets = await shaderAssets();
    const model = clone(assets.model);
    (model as Mutable<typeof model>).version = "latest";

    const result = validateModelShaderCompatibility({
      model,
      shader: assets.shaderManifest,
      gpuInterface: assets.gpuInterface,
      profile: assets.profileManifest,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        code: "invalid-contract",
        message: expect.stringMatching(/immutable asset version.*exact token/iu),
      }));
    }
  });

  it("applies exact-version grammar to matrix evidence and profile scopes", async () => {
    const assets = await shaderAssets();
    const evidence = clone(assets.shaderManifest);
    (evidence.validationEvidence as Mutable<typeof evidence.validationEvidence>).matrixVersion = "default";
    expect(() => parseShaderVersionManifest(evidence)).toThrow(/immutable asset version.*exact token/iu);

    const profile = clone(assets.profileManifest) as Mutable<ShaderStyleProfileManifest>;
    profile.requiredValidationScopes = [{
      scope: "xr",
      matrixId: "xr-webgpu",
      matrixVersion: "latest",
      matrixSha256: "a".repeat(64) as ShaderStyleProfileManifest["requiredValidationScopes"][number]["matrixSha256"],
    }];
    expect(() => parseShaderStyleProfileManifest(profile)).toThrow(/immutable asset version.*exact token/iu);
  });
});
