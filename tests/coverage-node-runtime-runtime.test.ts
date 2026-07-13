import { describe, expect, it, vi } from "vitest";

import { canonicalizeGpuContract } from "../src/canonical-json.js";
import type {
  FrameBoundaryScheduler,
  GpuBindingResourceLayout,
  GpuDeviceLike,
  LoadedShaderStyleProfile,
  PreparedShaderStyleProfile,
  PromotedShaderCatalogResolver,
  SerializableGpuRenderPipelineDescriptor,
  ShaderStyleProfileManifest,
  ShaderStyleProfileRef,
  ShaderVersionManifest,
} from "../src/contracts.js";
import { computeSha256 } from "../src/hash.js";
import { loadShaderStyleProfile } from "../src/runtime/catalog-loader.js";
import { prepareStyleProfile } from "../src/runtime/profile-preparer.js";
import { activateStyleProfile, createShaderStyleController } from "../src/runtime/style-controller.js";
import {
  trustLoadedShaderStyleProfile,
  trustPreparedShaderStyleProfile,
} from "../src/runtime/trusted-values.js";
import { clone, loadedStyleProfile, mutableLoadedStyleProfile, promotedCatalog, shaderAssets } from "./fixtures.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const LIMITS = {
  maxBindGroups: 4,
  maxBindingsPerBindGroup: 8,
  maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupSizeY: 256,
  maxComputeWorkgroupSizeZ: 64,
  maxComputeInvocationsPerWorkgroup: 256,
  maxStorageBuffersPerShaderStage: 8,
  maxStorageBufferBindingSize: 134_217_728,
  maxSampledTexturesPerShaderStage: 16,
  maxSamplersPerShaderStage: 16,
  maxStorageTexturesPerShaderStage: 8,
  maxUniformBuffersPerShaderStage: 12,
  maxUniformBufferBindingSize: 65_536,
  maxBindGroupsPlusVertexBuffers: 24,
  maxVertexBuffers: 8,
  maxVertexAttributes: 16,
  maxVertexBufferArrayStride: 2_048,
  maxColorAttachments: 8,
  maxInterStageShaderVariables: 16,
  maxInterStageShaderComponents: 60,
};

const capabilities = () => ({ features: ["shader-f16"], limits: LIMITS, formats: ["rgba8unorm"] });

function gpuDevice(overrides: Partial<GpuDeviceLike> = {}) {
  const createBindGroupLayout = vi.fn((descriptor: unknown) => ({ descriptor }));
  const createPipelineLayout = vi.fn((descriptor: unknown) => ({ descriptor }));
  const createShaderModule = vi.fn(() => ({ getCompilationInfo: async () => ({ messages: [] }) }));
  const createComputePipelineAsync = vi.fn(async (descriptor: unknown) => ({ descriptor }));
  const createRenderPipelineAsync = vi.fn(async (descriptor: unknown) => ({ descriptor }));
  const device: GpuDeviceLike = {
    features: ["shader-f16"],
    limits: LIMITS,
    createBindGroupLayout,
    createPipelineLayout,
    createShaderModule,
    createComputePipelineAsync,
    createRenderPipelineAsync,
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(async () => null),
    ...overrides,
  };
  return { device, createBindGroupLayout, createPipelineLayout, createShaderModule, createComputePipelineAsync, createRenderPipelineAsync };
}

async function bytes(value: unknown): Promise<{ readonly bytes: Uint8Array; readonly sha256: string }> {
  const encoded = new TextEncoder().encode(canonicalizeGpuContract(value));
  return { bytes: encoded, sha256: await computeSha256(encoded) };
}

async function profileCatalog(input: {
  readonly profile?: ShaderStyleProfileManifest;
  readonly shader?: ShaderVersionManifest;
  readonly interfaceValue?: unknown;
  readonly overrides?: Partial<PromotedShaderCatalogResolver>;
} = {}): Promise<{ readonly ref: ShaderStyleProfileRef; readonly catalog: PromotedShaderCatalogResolver }> {
  const assets = await shaderAssets();
  const shader = input.shader ?? assets.shaderManifest;
  const shaderArtifact = await bytes(shader);
  const profile = clone(input.profile ?? assets.profileManifest);
  (profile.roles[0]!.shader as Mutable<typeof profile.roles[number]["shader"]>).manifestSha256 = shaderArtifact.sha256 as typeof profile.roles[number]["shader"]["manifestSha256"];
  const profileArtifact = await bytes(profile);
  const interfaceArtifact = await bytes(input.interfaceValue ?? assets.gpuInterface);
  return {
    ref: { ...assets.profileRef, manifestSha256: profileArtifact.sha256 as typeof assets.profileRef.manifestSha256 },
    catalog: await promotedCatalog({
      loadProfile: async () => ({ bytes: profileArtifact.bytes, promoted: true }),
      loadShader: async () => ({ bytes: shaderArtifact.bytes, promoted: true }),
      loadInterface: async () => ({ bytes: interfaceArtifact.bytes, promoted: true }),
      ...input.overrides,
    }),
  };
}

describe("promoted catalog fail-closed edge coverage", () => {
  it("rejects profile, shader, and interface identity drift after exact digest verification", async () => {
    const assets = await shaderAssets();

    const profile = clone(assets.profileManifest);
    (profile as Mutable<typeof profile>).profileId = "style.changed";
    const profileCase = await profileCatalog({ profile });
    const profileResult = await loadShaderStyleProfile(profileCase);
    expect(profileResult.ok).toBe(false);
    if (!profileResult.ok) expect(profileResult.diagnostics[0]?.message).toMatch(/profile identity/u);

    const shader = clone(assets.shaderManifest);
    (shader as Mutable<typeof shader>).shaderId = "shader.changed";
    const shaderCase = await profileCatalog({ shader });
    const shaderResult = await loadShaderStyleProfile(shaderCase);
    expect(shaderResult.ok).toBe(false);
    if (!shaderResult.ok) expect(shaderResult.diagnostics[0]?.message).toMatch(/Shader manifest identity/u);

    const changedInterface = clone(assets.gpuInterface);
    (changedInterface as Mutable<typeof changedInterface>).interfaceId = "interface.changed";
    const interfaceArtifact = await bytes(changedInterface);
    const interfaceShader = clone(assets.shaderManifest);
    (interfaceShader.gpuInterface as Mutable<typeof interfaceShader.gpuInterface>).manifestSha256 = interfaceArtifact.sha256 as typeof interfaceShader.gpuInterface.manifestSha256;
    const interfaceCase = await profileCatalog({ shader: interfaceShader, interfaceValue: changedInterface });
    const interfaceResult = await loadShaderStyleProfile(interfaceCase);
    expect(interfaceResult.ok).toBe(false);
    if (!interfaceResult.ok) expect(interfaceResult.diagnostics[0]?.message).toMatch(/interface manifest identity/u);
  });

  it("rejects stale module sets, shader ABI claims, module URIs, and undeclared roles", async () => {
    const assets = await shaderAssets();
    const cases: readonly [string, (shader: Mutable<ShaderVersionManifest>, profile: Mutable<ShaderStyleProfileManifest>) => void, RegExp][] = [
      ["module set", (shader) => { (shader.modules[0]! as Mutable<ShaderVersionManifest["modules"][number]>).sha256 = "0".repeat(64) as typeof shader.modules[number]["sha256"]; }, /module set/u],
      ["shader ABI", (shader) => { shader.shaderAbiHash = "1".repeat(64) as typeof shader.shaderAbiHash; }, /Shader ABI hash/u],
      ["module URI", (shader) => { (shader.modules[0]! as Mutable<ShaderVersionManifest["modules"][number]>).uri = "https://outside.invalid/module.wgsl"; }, /module.*outside the promoted catalog/u],
      ["role", (_shader, profile) => { (profile.roles[0]! as Mutable<ShaderStyleProfileManifest["roles"][number]>).role = "outline"; }, /does not implement role/u],
    ];
    for (const [label, mutate, expected] of cases) {
      const shader = clone(assets.shaderManifest) as Mutable<ShaderVersionManifest>;
      const profile = clone(assets.profileManifest) as Mutable<ShaderStyleProfileManifest>;
      mutate(shader, profile);
      const candidate = await profileCatalog({ shader, profile });
      const result = await loadShaderStyleProfile(candidate);
      expect(result.ok, label).toBe(false);
      if (!result.ok) expect(result.diagnostics[0]?.message, label).toMatch(expected);
    }
  });

  it("checks every catalog-root boundary and normalizes non-Error resolver failures", async () => {
    const assets = await shaderAssets();
    const externalProfile = { ...assets.profileRef, manifestUri: "https://outside.invalid/profile.json" };
    const direct = await loadShaderStyleProfile({ ref: externalProfile, catalog: await promotedCatalog() });
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.diagnostics[0]?.message).toMatch(/Style profile URI/u);

    const shader = clone(assets.shaderManifest);
    (shader.gpuInterface as Mutable<typeof shader.gpuInterface>).manifestUri = "https://outside.invalid/interface.json";
    const nested = await loadShaderStyleProfile(await profileCatalog({ shader }));
    expect(nested.ok).toBe(false);
    if (!nested.ok) expect(nested.diagnostics[0]?.message).toMatch(/GPU interface URI/u);

    const externalEvidence = clone(assets.shaderManifest);
    (externalEvidence.validationEvidence as Mutable<typeof externalEvidence.validationEvidence>).uri = "https://attacker.invalid/evidence.json";
    const evidenceResult = await loadShaderStyleProfile(await profileCatalog({ shader: externalEvidence }));
    expect(evidenceResult.ok).toBe(false);
    if (!evidenceResult.ok) expect(evidenceResult.diagnostics[0]?.message).toMatch(/validation evidence URI is outside/u);

    const externalAttestation = clone(assets.shaderManifest);
    (externalAttestation.validationEvidence.attestationRef as Mutable<typeof externalAttestation.validationEvidence.attestationRef>).uri = "https://attacker.invalid/attestation.json";
    const attestationResult = await loadShaderStyleProfile(await profileCatalog({ shader: externalAttestation }));
    expect(attestationResult.ok).toBe(false);
    if (!attestationResult.ok) expect(attestationResult.diagnostics[0]?.message).toMatch(/attestation URI is outside/u);

    const thrown = await loadShaderStyleProfile({
      ref: assets.profileRef,
      catalog: await promotedCatalog({ loadProfile: async () => { throw "resolver failed"; } }),
    });
    expect(thrown).toEqual({ ok: false, diagnostics: [{ code: "invalid-contract", severity: "error", message: "Style profile loading failed." }] });
  });

  it("deduplicates exact shader loads across roles and handles a primitive abort reason", async () => {
    const assets = await shaderAssets();
    const shader = clone(assets.shaderManifest);
    (shader as Mutable<typeof shader>).renderRoles = [
      ...shader.renderRoles,
      { role: "lighting", pipelineIds: [shader.pipelines[0]!.pipelineId] },
    ];
    const shaderArtifact = await bytes(shader);
    const shaderRef = { ...assets.shaderRef, manifestSha256: shaderArtifact.sha256 as typeof assets.shaderRef.manifestSha256 };
    const profile = clone(assets.profileManifest);
    (profile as Mutable<typeof profile>).roles = [
      { role: "material", shader: shaderRef },
      { role: "lighting", shader: shaderRef },
    ];
    const loadShader = vi.fn(async () => ({ bytes: shaderArtifact.bytes, promoted: true }));
    const candidate = await profileCatalog({ profile, shader, overrides: { loadShader } });
    const result = await loadShaderStyleProfile(candidate);
    expect(result.ok).toBe(true);
    expect(loadShader).toHaveBeenCalledOnce();

    const aborted = new AbortController();
    aborted.abort("primitive-reason");
    await expect(loadShaderStyleProfile({ ref: assets.profileRef, catalog: await promotedCatalog(), signal: aborted.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects evidence and attestation identity reuse across distinct shader versions", async () => {
    const assets = await shaderAssets();
    const universal = assets.shaderManifest.validationEvidence;
    const independentEvidence = {
      ...universal,
      evidenceId: "qualification-lighting",
      uri: "https://assets.example.invalid/evidence/qualification-lighting.json",
      sha256: "7".repeat(64) as typeof universal.sha256,
      attestationRef: {
        uri: "https://assets.example.invalid/evidence/qualification-lighting.attestation-ref.json",
        sha256: "4".repeat(64) as typeof universal.attestationRef.sha256,
      },
    };
    const collisions = [
      ["evidence ID", { ...independentEvidence, evidenceId: universal.evidenceId }],
      ["evidence URI", { ...independentEvidence, uri: universal.uri }],
      ["evidence digest", { ...independentEvidence, sha256: universal.sha256 }],
      ["attestation URI", { ...independentEvidence, attestationRef: { ...independentEvidence.attestationRef, uri: universal.attestationRef.uri } }],
      ["attestation digest", { ...independentEvidence, attestationRef: { ...independentEvidence.attestationRef, sha256: universal.attestationRef.sha256 } }],
      ["cross-kind URI", { ...independentEvidence, uri: universal.attestationRef.uri }],
      ["cross-kind digest", { ...independentEvidence, sha256: universal.attestationRef.sha256 }],
    ] as const;

    for (const [label, evidence] of collisions) {
      const materialShader = clone(assets.shaderManifest);
      const lightingShader = clone(assets.shaderManifest);
      (lightingShader as Mutable<typeof lightingShader>).shaderId = "shader.lighting";
      (lightingShader as Mutable<typeof lightingShader>).renderRoles = [{
        role: "lighting",
        pipelineIds: [lightingShader.pipelines[0]!.pipelineId],
      }];
      (lightingShader as Mutable<typeof lightingShader>).validationEvidence = evidence;
      const materialArtifact = await bytes(materialShader);
      const lightingArtifact = await bytes(lightingShader);
      const materialRef = {
        ...assets.shaderRef,
        manifestSha256: materialArtifact.sha256 as typeof assets.shaderRef.manifestSha256,
      };
      const lightingRef = {
        ...assets.shaderRef,
        shaderId: lightingShader.shaderId,
        manifestUri: "https://assets.example.invalid/shaders/lighting/manifest.json",
        manifestSha256: lightingArtifact.sha256 as typeof assets.shaderRef.manifestSha256,
      };
      const profile = clone(assets.profileManifest);
      (profile as Mutable<typeof profile>).roles = [
        { role: "material", shader: materialRef },
        { role: "lighting", shader: lightingRef },
      ];
      const profileArtifact = await bytes(profile);
      const result = await loadShaderStyleProfile({
        ref: { ...assets.profileRef, manifestSha256: profileArtifact.sha256 as typeof assets.profileRef.manifestSha256 },
        catalog: await promotedCatalog({
          loadProfile: async () => ({ bytes: profileArtifact.bytes, promoted: true }),
          loadShader: async (ref) => ({
            bytes: ref.shaderId === lightingShader.shaderId ? lightingArtifact.bytes : materialArtifact.bytes,
            promoted: true,
          }),
        }),
      });
      expect(result.ok, label).toBe(false);
      if (!result.ok) expect(result.diagnostics[0]?.message, label).toMatch(/Distinct shader versions.*reuse/u);
    }
  });

  it("does not deduplicate shader references whose manifest URIs differ", async () => {
    const assets = await shaderAssets();
    const shader = clone(assets.shaderManifest);
    (shader as Mutable<typeof shader>).renderRoles = [
      ...shader.renderRoles,
      { role: "lighting", pipelineIds: [shader.pipelines[0]!.pipelineId] },
    ];
    const shaderArtifact = await bytes(shader);
    const shaderRef = {
      ...assets.shaderRef,
      manifestSha256: shaderArtifact.sha256 as typeof assets.shaderRef.manifestSha256,
    };
    const profile = clone(assets.profileManifest);
    (profile as Mutable<typeof profile>).roles = [
      { role: "material", shader: shaderRef },
      {
        role: "lighting",
        shader: { ...shaderRef, manifestUri: "https://outside.invalid/shader.json" },
      },
    ];
    const loadShader = vi.fn(async () => ({ bytes: shaderArtifact.bytes, promoted: true }));
    const result = await loadShaderStyleProfile(await profileCatalog({
      profile,
      shader,
      overrides: { loadShader },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]?.message).toMatch(/Shader manifest URI is outside the promoted catalog root/u);
    expect(loadShader).toHaveBeenCalledOnce();
  });

  it("rejects supplemental evidence and profile scopes until an additive policy is registered", async () => {
    const assets = await shaderAssets();
    const shader = clone(assets.shaderManifest);
    const xrMatrixSha256 = "3".repeat(64) as typeof shader.validationEvidence.matrixSha256;
    (shader as Mutable<typeof shader>).additionalValidationEvidence = [{
      scope: "xr",
      evidence: {
        ...shader.validationEvidence,
        evidenceId: "qualification-xr",
        uri: "https://assets.example.invalid/evidence/qualification-xr.json",
        sha256: "7".repeat(64) as typeof shader.validationEvidence.sha256,
        matrixId: "webgpu-xr",
        matrixVersion: "2026-07-13",
        matrixSha256: xrMatrixSha256,
        attestationRef: {
          uri: "https://assets.example.invalid/evidence/qualification-xr.attestation-ref.json",
          sha256: "4".repeat(64) as typeof shader.validationEvidence.attestationRef.sha256,
        },
      },
    }];
    const profile = clone(assets.profileManifest);
    (profile as Mutable<typeof profile>).requiredValidationScopes = [{
      scope: "xr",
      matrixId: "webgpu-xr",
      matrixVersion: "2026-07-13",
      matrixSha256: xrMatrixSha256,
    }];

    const profileRejected = await loadShaderStyleProfile(await profileCatalog({
      profile,
      shader: assets.shaderManifest,
    }));
    expect(profileRejected.ok).toBe(false);
    if (!profileRejected.ok) expect(profileRejected.diagnostics[0]?.message).toMatch(/not a supported additive/u);

    const shaderRejected = await loadShaderStyleProfile(await profileCatalog({
      profile: assets.profileManifest,
      shader,
    }));
    expect(shaderRejected.ok).toBe(false);
    if (!shaderRejected.ok) expect(shaderRejected.diagnostics[0]?.message).toMatch(/not bound to a supported additive/u);
  });
});

describe("style preparation descriptor and cleanup edge coverage", () => {
  it("maps every binding resource descriptor and shader-stage visibility mask", async () => {
    const assets = await shaderAssets();
    const resources: readonly GpuBindingResourceLayout[] = [
      { kind: "buffer", addressSpace: "uniform", access: "read", recordName: "ModelData", minimumBindingSize: 112 },
      { kind: "buffer", addressSpace: "storage", access: "read", recordName: "ModelData", minimumBindingSize: 112 },
      { kind: "buffer", addressSpace: "storage", access: "read_write", recordName: "ModelData", minimumBindingSize: 112 },
      { kind: "sampler", samplerType: "comparison" },
      { kind: "texture", sampleType: "float", viewDimension: "2d", multisampled: false },
      { kind: "storage-texture", access: "write-only", format: "rgba8unorm", viewDimension: "2d" },
      { kind: "external-texture" },
    ];
    for (const resource of resources) {
      const loaded = mutableLoadedStyleProfile(await loadedStyleProfile());
      const shader = loaded.shaders.get("material")!;
      const pipeline = shader.manifest.pipelines[0]!;
      const group = pipeline.layout.bindGroups[0]! as Mutable<typeof pipeline.layout.bindGroups[number]>;
      group.entries = [...group.entries, { group: 0, binding: 1, resource, visibility: ["compute"] }];
      const reflectedBinding = clone(shader.gpuInterface.bindings[0]!) as Mutable<typeof shader.gpuInterface.bindings[number]>;
      reflectedBinding.variableName = `coverage_${resource.kind}`;
      reflectedBinding.binding = 1;
      reflectedBinding.resource = resource;
      (shader.gpuInterface as Mutable<typeof shader.gpuInterface>).bindings = [
        ...shader.gpuInterface.bindings,
        reflectedBinding,
      ];
      const reflectedEntry = shader.gpuInterface.entryPoints[0]! as Mutable<typeof shader.gpuInterface.entryPoints[number]>;
      reflectedEntry.bindingKeys = [...reflectedEntry.bindingKeys, "compute:0:1"];
      const requiredLimits = new Map(shader.manifest.requirements.limits.map((limit) => [limit.name, limit]));
      const requireLimit = (name: string, value: number): void => {
        const current = requiredLimits.get(name);
        if (!current || current.comparator !== "at-least" || current.value < value) {
          requiredLimits.set(name, { name, comparator: "at-least", value });
        }
      };
      requireLimit("maxBindingsPerBindGroup", 2);
      if (resource.kind === "buffer" && resource.addressSpace === "uniform") {
        requireLimit("maxUniformBuffersPerShaderStage", 1);
        requireLimit("maxUniformBufferBindingSize", 112);
      } else if (resource.kind === "buffer") {
        requireLimit("maxStorageBuffersPerShaderStage", 2);
        requireLimit("maxStorageBufferBindingSize", 112);
      } else if (resource.kind === "sampler") requireLimit("maxSamplersPerShaderStage", 1);
      else if (resource.kind === "texture") requireLimit("maxSampledTexturesPerShaderStage", 1);
      else if (resource.kind === "storage-texture") requireLimit("maxStorageTexturesPerShaderStage", 1);
      else {
        requireLimit("maxSampledTexturesPerShaderStage", 4);
        requireLimit("maxSamplersPerShaderStage", 1);
        requireLimit("maxUniformBuffersPerShaderStage", 1);
      }
      (shader.manifest.requirements as Mutable<typeof shader.manifest.requirements>).limits = [...requiredLimits.values()];
      const gpu = gpuDevice();
      const result = await prepareStyleProfile({ loaded: trustLoadedShaderStyleProfile(loaded), model: assets.model, capabilities: capabilities(), device: gpu.device });
      expect(result.ok, resource.kind).toBe(true);
      const descriptorKey = resource.kind === "buffer" ? "buffer"
        : resource.kind === "sampler" ? "sampler"
          : resource.kind === "texture" ? "texture"
            : resource.kind === "storage-texture" ? "storageTexture" : "externalTexture";
      expect(gpu.createBindGroupLayout).toHaveBeenCalledWith({
        entries: expect.arrayContaining([
          expect.objectContaining({ visibility: 4, [descriptorKey]: expect.any(Object) }),
        ]),
      });
    }
  });

  it("creates render pipelines, including fragment/depth/strip descriptors", async () => {
    const assets = await shaderAssets();
    const loaded = mutableLoadedStyleProfile(await loadedStyleProfile());
    const render: SerializableGpuRenderPipelineDescriptor = {
      kind: "render",
      pipelineId: "render.pipeline",
      layout: { bindGroups: [] },
      vertex: { moduleId: "compute", entryPoint: "vertexMain", constants: { ENABLED: true } },
      fragment: { moduleId: "compute", entryPoint: "fragmentMain", constants: { LEVEL: 2 } },
      vertexBuffers: [{ arrayStride: 16, stepMode: "vertex", attributes: [{ format: "float32x4", offset: 0, shaderLocation: 0, semantic: null }] }],
      primitive: { topology: "triangle-strip", stripIndexFormat: "uint16", frontFace: "cw", cullMode: "back", unclippedDepth: true },
      colorTargets: [{ format: "rgba8unorm", blend: null, writeMask: 15 }],
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less", stencilFront: { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "keep" }, stencilBack: { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "keep" }, stencilReadMask: 255, stencilWriteMask: 255, depthBias: 0, depthBiasSlopeScale: 0, depthBiasClamp: 0 },
      multisample: { count: 1, mask: 0xffff_ffff, alphaToCoverageEnabled: false },
    };
    const shader = loaded.shaders.get("material")!;
    (shader.manifest as Mutable<typeof shader.manifest>).pipelines = [render];
    (shader.manifest as Mutable<typeof shader.manifest>).renderRoles = [{ role: "material", pipelineIds: [render.pipelineId] }];
    (shader.manifest.requirements as Mutable<typeof shader.manifest.requirements>).features = ["shader-f16", "depth-clip-control"];
    (shader.manifest.requirements as Mutable<typeof shader.manifest.requirements>).formats = ["rgba8unorm", "depth24plus"];
    (shader.manifest.requirements as Mutable<typeof shader.manifest.requirements>).limits = [
      ...shader.manifest.requirements.limits,
      { name: "maxBindGroupsPlusVertexBuffers", comparator: "at-least", value: 1 },
      { name: "maxVertexBuffers", comparator: "at-least", value: 1 },
      { name: "maxVertexAttributes", comparator: "at-least", value: 1 },
      { name: "maxVertexBufferArrayStride", comparator: "at-least", value: 16 },
      { name: "maxColorAttachments", comparator: "at-least", value: 1 },
      { name: "maxInterStageShaderVariables", comparator: "at-least", value: 1 },
      { name: "maxInterStageShaderComponents", comparator: "at-least", value: 4 },
    ];
    const vector = { kind: "vector" as const, scalar: "f32" as const, width: 4 as const, alignment: 16, byteSize: 16 };
    (shader.gpuInterface as Mutable<typeof shader.gpuInterface>).entryPoints = [
      ...shader.gpuInterface.entryPoints,
      { moduleId: "compute", name: "vertexMain", stage: "vertex", inputs: [{ name: "position", locationKind: "location", location: 0, interpolation: null, type: vector }], outputs: [{ name: "varying", locationKind: "location", location: 0, interpolation: null, type: vector }], bindingKeys: [], overrideNames: [], workgroupSize: null, workgroupStorageSize: null },
      { moduleId: "compute", name: "fragmentMain", stage: "fragment", inputs: [{ name: "varying", locationKind: "location", location: 0, interpolation: null, type: vector }], outputs: [{ name: "color", locationKind: "location", location: 0, interpolation: null, type: vector }], bindingKeys: [], overrideNames: [], workgroupSize: null, workgroupStorageSize: null },
    ];
    const exactLimits = shader.manifest.requirements.limits;
    (shader.manifest.requirements as Mutable<typeof shader.manifest.requirements>).limits = exactLimits.filter(
      (limit) => limit.name !== "maxInterStageShaderComponents",
    );
    const understated = await prepareStyleProfile({
      loaded: trustLoadedShaderStyleProfile(loaded),
      model: assets.model,
      capabilities: { ...capabilities(), formats: ["rgba8unorm", "depth24plus"] },
      device: gpuDevice({ features: ["shader-f16", "depth-clip-control"] }).device,
    });
    expect(understated.ok).toBe(false);
    if (!understated.ok) expect(understated.diagnostics[0]?.message).toMatch(/maxInterStageShaderComponents at least 4/u);
    (shader.manifest.requirements as Mutable<typeof shader.manifest.requirements>).limits = exactLimits;
    const gpu = gpuDevice({ features: ["shader-f16", "depth-clip-control"] });
    const result = await prepareStyleProfile({
      loaded: trustLoadedShaderStyleProfile(loaded),
      model: assets.model,
      capabilities: { ...capabilities(), formats: ["rgba8unorm", "depth24plus"] },
      device: gpu.device,
    });
    expect(result.ok).toBe(true);
    expect(gpu.createRenderPipelineAsync).toHaveBeenCalledWith(expect.objectContaining({
      vertex: expect.objectContaining({ constants: { ENABLED: 1 } }),
      fragment: expect.objectContaining({ constants: { LEVEL: 2 } }),
      primitive: expect.objectContaining({ stripIndexFormat: "uint16" }),
      depthStencil: expect.objectContaining({ format: "depth24plus" }),
    }));
  });

  it("supports synchronous pipeline creation and devices without error scopes", async () => {
    const assets = await shaderAssets();
    const createComputePipeline = vi.fn((descriptor: unknown) => ({ descriptor }));
    const gpu = gpuDevice({
      createComputePipelineAsync: undefined,
      createComputePipeline,
      pushErrorScope: undefined,
      popErrorScope: undefined,
    });
    const result = await prepareStyleProfile({ loaded: await loadedStyleProfile(), model: assets.model, capabilities: capabilities(), device: gpu.device });
    expect(result.ok).toBe(true);
    expect(createComputePipeline).toHaveBeenCalledOnce();
  });

  it("rejects invalid role/pipeline contracts and an implementation that returns no pipeline", async () => {
    const assets = await shaderAssets();
    const roleMissing = mutableLoadedStyleProfile(await loadedStyleProfile());
    (roleMissing.shaders.get("material")!.manifest as Mutable<ShaderVersionManifest>).renderRoles = [];
    const first = await prepareStyleProfile({ loaded: trustLoadedShaderStyleProfile(roleMissing), model: assets.model, capabilities: capabilities(), device: gpuDevice().device });
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.diagnostics[0]?.message).toMatch(/renderRoles must not be empty/u);

    const pipelineMissing = mutableLoadedStyleProfile(await loadedStyleProfile());
    (pipelineMissing.shaders.get("material")!.manifest.renderRoles[0] as Mutable<ShaderVersionManifest["renderRoles"][number]>).pipelineIds = ["absent"];
    const second = await prepareStyleProfile({ loaded: trustLoadedShaderStyleProfile(pipelineMissing), model: assets.model, capabilities: capabilities(), device: gpuDevice().device });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.diagnostics[0]?.message).toMatch(/references missing pipeline absent/u);

    const noPipeline = gpuDevice({ createComputePipelineAsync: undefined, createComputePipeline: () => undefined });
    const third = await prepareStyleProfile({ loaded: await loadedStyleProfile(), model: assets.model, capabilities: capabilities(), device: noPipeline.device });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.diagnostics[0]?.message).toMatch(/did not create pipeline/u);
  });

  it("honors abort and ignores cleanup error-scope rejection after a primary failure", async () => {
    const assets = await shaderAssets();
    const abort = new AbortController();
    const pending = gpuDevice({ createComputePipelineAsync: async () => new Promise(() => undefined) });
    const operation = prepareStyleProfile({ loaded: await loadedStyleProfile(), model: assets.model, capabilities: capabilities(), device: pending.device, signal: abort.signal });
    abort.abort(new DOMException("cancelled", "AbortError"));
    const aborted = await operation;
    expect(aborted.ok).toBe(false);
    if (!aborted.ok) expect(aborted.diagnostics[0]?.code).toBe("pipeline-error");

    const cleanup = gpuDevice({
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [{ type: "error", message: "primary" }] }) }),
      popErrorScope: async () => { throw new Error("cleanup"); },
    });
    const failed = await prepareStyleProfile({ loaded: await loadedStyleProfile(), model: assets.model, capabilities: capabilities(), device: cleanup.device });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.diagnostics[0]?.code).toBe("compilation-error");
  });

  it("returns the primary diagnostic without awaiting a hung error-scope cleanup", async () => {
    const assets = await shaderAssets();
    const popErrorScope = vi.fn(async () => new Promise<null>(() => undefined));
    const gpu = gpuDevice({
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [{ type: "error", message: "primary" }] }) }),
      popErrorScope,
    });
    const result = await prepareStyleProfile({
      loaded: await loadedStyleProfile(),
      model: assets.model,
      capabilities: capabilities(),
      device: gpu.device,
      timeoutMs: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]?.code).toBe("compilation-error");
    expect(popErrorScope).toHaveBeenCalledOnce();
  });
});

function prepared(id: string, dispose: () => void = vi.fn()): PreparedShaderStyleProfile {
  return trustPreparedShaderStyleProfile({
    loaded: { manifest: { profileId: id } } as unknown as LoadedShaderStyleProfile,
    pipelines: new Map(),
    preparedAt: 0,
    dispose,
  });
}

describe("style controller scheduler edge coverage", () => {
  it("fails when the scheduler omits the callback and rejects a late callback", async () => {
    let callback: (() => void) | undefined;
    const candidate = prepared("candidate");
    const controller = createShaderStyleController({ scheduler: { schedule: async (operation) => { callback = operation; } } });
    const result = await activateStyleProfile({ controller, prepared: candidate });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]?.message).toMatch(/without invoking/u);
    expect(() => callback?.()).toThrow(/after completion/u);
  });

  it("uses custom retirement, tolerates retirement failure, and does not retire the same prepared value", async () => {
    const scheduler: FrameBoundaryScheduler = { schedule: async (operation) => { operation(); } };
    const initial = prepared("initial");
    const next = prepared("next");
    const retire = vi.fn(async () => undefined);
    const controller = createShaderStyleController({ scheduler, initial });
    expect((await activateStyleProfile({ controller, prepared: next, retire })).ok).toBe(true);
    expect(retire).toHaveBeenCalledWith(initial);

    const failingRetire = vi.fn(async () => { throw new Error("cleanup only"); });
    const final = prepared("final");
    expect((await activateStyleProfile({ controller, prepared: final, retire: failingRetire })).ok).toBe(true);
    expect(controller.current?.prepared).toBe(final);

    expect((await activateStyleProfile({ controller, prepared: final })).ok).toBe(true);
  });

  it("preserves the activation failure when candidate disposal throws and normalizes a primitive scheduler error", async () => {
    const candidate = prepared("candidate", () => { throw new Error("dispose failure"); });
    const controller = createShaderStyleController({ scheduler: { schedule: async () => { throw "primitive failure"; } } });
    const result = await activateStyleProfile({ controller, prepared: candidate });
    expect(result).toEqual({ ok: false, diagnostics: [{ code: "activation-error", severity: "error", message: "Frame-boundary activation failed." }] });
  });
});
