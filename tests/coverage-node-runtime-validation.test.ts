import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import {
  SHADER_VALIDATION_EVIDENCE_VERSION,
  type ShaderCompileUnitInventory,
  type ShaderQualificationFixtureManifest,
  type ShaderValidationEvidenceAttestationRef,
  type StableWebGpuMatrixManifest,
} from "../src/contracts.js";
import { computeSha256 } from "../src/hash.js";
import {
  parseQualificationExecutionProducer,
  parseShaderValidationEvidenceAttestationRef,
  parseTrustedWorkflowProvenance,
  verifyShaderValidationEvidenceAttestation,
} from "../src/testing/evidence.js";
import { defineShaderCompileUnit, validateCompileUnitInventory } from "../src/testing/inventory.js";
import { validateStableWebGpuMatrix } from "../src/testing/matrix.js";
import { validateQualificationBundleManifest, validateQualificationFixture } from "../src/testing/qualification-bundle.js";
import {
  clone,
  executionProducer,
  provenance,
  qualificationBundle,
  validInventory,
  validQualificationFixture,
  validVertexInventory,
  validVertexQualificationFixture,
  ZERO_SHA,
} from "./fixtures.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

async function stableMatrix(): Promise<StableWebGpuMatrixManifest> {
  return JSON.parse(await readFile(new URL("../matrices/stable-webgpu-2026-07-13.json", import.meta.url), "utf8")) as StableWebGpuMatrixManifest;
}

const diagnosticMessages = (result: ReturnType<typeof validateCompileUnitInventory>): string =>
  result.ok ? "" : result.diagnostics.map((item) => item.message).join("; ");

describe("compile-unit validator fail-closed branches", () => {
  it("freezes declarations and rejects malformed envelopes and bounds", () => {
    const unit = defineShaderCompileUnit(validInventory().compileUnits[0]!);
    expect(Object.isFrozen(unit)).toBe(true);
    expect(validateCompileUnitInventory(null).ok).toBe(false);
    expect(validateCompileUnitInventory({ inventory: [] }).ok).toBe(false);

    const badVersion = clone(validInventory()) as Mutable<ShaderCompileUnitInventory>;
    badVersion.contractVersion = "wrong" as typeof badVersion.contractVersion;
    expect(diagnosticMessages(validateCompileUnitInventory(badVersion))).toMatch(/Unsupported compile-unit/u);

    const nonArrays = { ...validInventory(), fragments: null, compileUnits: null };
    expect(validateCompileUnitInventory(nonArrays).ok).toBe(false);

    const oversized = clone(validInventory()) as Mutable<ShaderCompileUnitInventory>;
    oversized.fragments = Array.from({ length: 10_001 }, () => oversized.fragments[0]!);
    expect(diagnosticMessages(validateCompileUnitInventory(oversized))).toMatch(/bounded item count/u);
  });

  it("collects fragment identity, digest, and shape failures", () => {
    const cases: readonly ((inventory: Record<string, unknown>) => void)[] = [
      (inventory) => { (inventory.fragments as unknown[])[0] = null; },
      (inventory) => { (inventory.fragments as Record<string, unknown>[])[0]!.sha256 = "bad"; },
      (inventory) => { (inventory.fragments as Record<string, unknown>[]).push({ ...(inventory.fragments as Record<string, unknown>[])[0] }); },
      (inventory) => { ((inventory.fragments as Record<string, unknown>[])[0] as Record<string, unknown>).fragmentId = "../unsafe"; },
    ];
    for (const mutate of cases) {
      const inventory = clone(validInventory()) as unknown as Record<string, unknown>;
      mutate(inventory);
      expect(validateCompileUnitInventory(inventory).ok).toBe(false);
    }
  });

  it("rejects malformed unit modules, entries, overrides, refs, and fixtures", () => {
    const cases: readonly ((unit: Record<string, unknown>) => void)[] = [
      (unit) => { unit.contractVersion = "wrong"; },
      (unit) => { unit.fragmentIds = []; },
      (unit) => { unit.fragmentIds = ["fragment.main", "fragment.main"]; },
      (unit) => { unit.modules = []; },
      (unit) => { (unit.modules as Record<string, unknown>[])[0]!.sha256 = "bad"; },
      (unit) => { ((unit.modules as Record<string, unknown>[])[0]!.assembly as Record<string, unknown>).kind = "manual"; },
      (unit) => { unit.entryPoints = [{ moduleId: "compute", name: "main", stage: "invalid" }]; },
      (unit) => { unit.entryPoints = [...unit.entryPoints as unknown[], ...(unit.entryPoints as unknown[])]; },
      (unit) => { unit.pipelines = [{ broken: true }]; },
      (unit) => { unit.overrideValues = null; },
      (unit) => { unit.overrideValues = { EXTRA: 1 }; },
      (unit) => { (unit.interfaceRef as Record<string, unknown>).manifestSha256 = "bad"; },
      (unit) => { (unit.qualificationFixture as Record<string, unknown>).path = "fixture.bin"; },
    ];
    for (const mutate of cases) {
      const inventory = clone(validInventory()) as unknown as { compileUnits: Record<string, unknown>[] };
      mutate(inventory.compileUnits[0]!);
      expect(validateCompileUnitInventory(inventory).ok).toBe(false);
    }
  });

  it("detects conflicting override values across render stages", () => {
    const inventory = clone(validVertexInventory()) as unknown as { compileUnits: Record<string, unknown>[] };
    const unit = inventory.compileUnits[0]!;
    const pipeline = (unit.pipelines as Record<string, unknown>[])[0]!;
    pipeline.fragment = { moduleId: "vertex", entryPoint: "fragmentMain", constants: { LEVEL: 2 } };
    (pipeline.vertex as Record<string, unknown>).constants = { LEVEL: 1 };
    unit.entryPoints = [
      ...(unit.entryPoints as unknown[]),
      { moduleId: "vertex", name: "fragmentMain", stage: "fragment" },
    ];
    unit.overrideValues = { LEVEL: 1 };
    const result = validateCompileUnitInventory(inventory);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((item) => item.message).join(" ")).toMatch(/conflicting stage values/u);
  });
});

describe("stable matrix strict descriptor coverage", () => {
  it("rejects malformed top-level identity, policy, and cell arrays", async () => {
    expect(validateStableWebGpuMatrix([]).ok).toBe(false);
    const identity = clone(await stableMatrix()) as unknown as Record<string, unknown>;
    identity.contractVersion = "wrong";
    identity.matrixId = "";
    identity.version = "";
    expect(validateStableWebGpuMatrix(identity).ok).toBe(false);

    const policy = clone(await stableMatrix()) as unknown as Record<string, unknown>;
    policy.policy = { coverage: "some" };
    expect(validateStableWebGpuMatrix(policy).ok).toBe(false);

    const cells = clone(await stableMatrix()) as unknown as Record<string, unknown>;
    cells.cells = null;
    expect(validateStableWebGpuMatrix(cells).ok).toBe(false);
  });

  it("rejects each mutable cell descriptor boundary", async () => {
    const cases: readonly ((cell: Record<string, unknown>) => void)[] = [
      (cell) => { cell.cellId = "INVALID"; },
      (cell) => { cell.runnerLabels = []; },
      (cell) => { cell.runnerLabels = ["duplicate", "duplicate"]; },
      (cell) => { cell.browser = { name: "invented", channel: "stable" }; },
      (cell) => { cell.os = { name: "invented", versionRequirement: { kind: "exact", value: "1" }, architecture: "x64" }; },
      (cell) => { (cell.os as Record<string, unknown>).versionRequirement = { kind: "exact", value: "latest" }; },
      (cell) => { (cell.os as Record<string, unknown>).versionRequirement = { kind: "major", value: 0 }; },
      (cell) => { (cell.os as Record<string, unknown>).versionRequirement = { kind: "stable-channel", channel: "beta" }; },
      (cell) => { cell.adapter = { kind: "invented", vendor: "x", family: "x", backend: "x" }; },
      (cell) => { cell.automation = { kind: "invented" }; },
      (cell) => { cell.timeoutMs = 999; },
      (cell) => { cell.timeoutMs = 3_600_001; },
      (cell) => { cell.blocking = false; },
      (cell) => { cell.countsTowardStableCoverage = false; },
    ];
    for (const mutate of cases) {
      const matrix = clone(await stableMatrix()) as unknown as { cells: Record<string, unknown>[] };
      mutate(matrix.cells[0]!);
      expect(validateStableWebGpuMatrix(matrix).ok).toBe(false);
    }
  });
});

function extendedFixture(): ShaderQualificationFixtureManifest {
  const fixture = clone(validQualificationFixture()) as Mutable<ShaderQualificationFixtureManifest>;
  fixture.resources = [
    ...fixture.resources,
    {
      kind: "texture",
      resourceId: "color",
      dimension: "2d",
      size: [4, 4, 1],
      mipLevelCount: 3,
      sampleCount: 1,
      format: "rgba8unorm",
      usage: ["copy-src", "copy-dst", "render-attachment"],
      initialData: {
        path: "data/color.bin",
        sha256: ZERO_SHA,
        bytesPerRow: 16,
        rowsPerImage: 4,
        mipLevel: 0,
        origin: [0, 0, 0],
        aspect: "all",
      },
    },
    {
      kind: "sampler",
      resourceId: "sampler",
      descriptor: {
        addressModeU: "repeat",
        addressModeV: "mirror-repeat",
        addressModeW: "clamp-to-edge",
        magFilter: "linear",
        minFilter: "nearest",
        mipmapFilter: "linear",
        lodMinClamp: 0,
        lodMaxClamp: 4,
        compare: "less-equal",
        maxAnisotropy: 4,
      },
    },
  ];
  fixture.bindGroups = [
    ...fixture.bindGroups,
    {
      bindGroupId: "group.images",
      group: 1,
      entries: [
        { binding: 0, resource: { kind: "texture-view", resourceId: "color", view: { format: null, dimension: "2d", aspect: "all", baseMipLevel: 0, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 1 } } },
        { binding: 1, resource: { kind: "sampler", resourceId: "sampler" } },
      ],
    },
  ];
  fixture.commands = [
    ...fixture.commands,
    {
      kind: "copy-texture-to-buffer",
      source: { resourceId: "color", mipLevel: 0, origin: [0, 0, 0], aspect: "all" },
      destination: { resourceId: "readback", offset: 0, bytesPerRow: 256, rowsPerImage: 4 },
      extent: [1, 1, 1],
    },
  ];
  fixture.bounds = { ...fixture.bounds, maxTextureTexels: 16, maxCommands: 3 };
  return fixture;
}

describe("qualification fixture DSL branch coverage", () => {
  it("accepts texture upload/view/copy and full sampler descriptors", () => {
    const result = validateQualificationFixture(extendedFixture());
    expect(result.ok).toBe(true);
  });

  it("keeps 2d array layers constant across mips while deriving mip count from spatial dimensions", () => {
    const fixture = clone(extendedFixture()) as Mutable<ShaderQualificationFixtureManifest>;
    const color = fixture.resources[2];
    const imageGroup = fixture.bindGroups[1];
    const copy = fixture.commands[2];
    if (color?.kind !== "texture" || !imageGroup || copy?.kind !== "copy-texture-to-buffer") throw new Error("Expected extended texture fixture.");
    (color as Mutable<typeof color>).size = [4, 4, 64];
    (imageGroup.entries[0]!.resource as Mutable<typeof imageGroup.entries[number]["resource"]>) = {
      kind: "texture-view",
      resourceId: "color",
      view: { format: null, dimension: "2d-array", aspect: "all", baseMipLevel: 2, mipLevelCount: 1, baseArrayLayer: 63, arrayLayerCount: 1 },
    };
    (copy.source as Mutable<typeof copy.source>).mipLevel = 2;
    (copy.source as Mutable<typeof copy.source>).origin = [0, 0, 63];
    (fixture.bounds as Mutable<typeof fixture.bounds>).maxTextureTexels = 1024;
    expect(validateQualificationFixture(fixture).ok).toBe(true);

    const excessiveMips = clone(fixture) as Mutable<ShaderQualificationFixtureManifest>;
    const excessiveTexture = excessiveMips.resources[2];
    if (excessiveTexture?.kind !== "texture") throw new Error("Expected texture resource.");
    (excessiveTexture as Mutable<typeof excessiveTexture>).mipLevelCount = 4;
    expect(validateQualificationFixture(excessiveMips).ok).toBe(false);

    const layerOverflow = clone(fixture) as Mutable<ShaderQualificationFixtureManifest>;
    const overflowCopy = layerOverflow.commands[2];
    if (overflowCopy?.kind !== "copy-texture-to-buffer") throw new Error("Expected texture copy.");
    (overflowCopy.source as Mutable<typeof overflowCopy.source>).origin = [0, 0, 64];
    expect(validateQualificationFixture(layerOverflow).ok).toBe(false);
  });

  it("validates texture views against format, aspect, dimension, mip, and layer bounds", () => {
    const cases: readonly ((view: Record<string, unknown>) => void)[] = [
      (view) => { view.format = "rgba8unorm-srgb"; },
      (view) => { view.aspect = "depth-only"; },
      (view) => { view.dimension = "3d"; },
      (view) => { view.baseMipLevel = 3; },
      (view) => { view.mipLevelCount = 4; },
      (view) => { view.baseArrayLayer = 1; },
      (view) => { view.arrayLayerCount = 2; },
    ];
    for (const mutate of cases) {
      const fixture = clone(extendedFixture()) as unknown as Record<string, unknown>;
      const group = (fixture.bindGroups as Record<string, unknown>[])[1]!;
      const entry = (group.entries as Record<string, unknown>[])[0]!;
      const resource = entry.resource as Record<string, unknown>;
      mutate(resource.view as Record<string, unknown>);
      expect(validateQualificationFixture(fixture).ok).toBe(false);
    }
  });

  it("enforces the full mip-zero uncompressed copy-dst upload contract", () => {
    const cases: readonly ((texture: Record<string, unknown>, initial: Record<string, unknown>) => void)[] = [
      (texture) => { texture.usage = ["copy-src", "render-attachment"]; },
      (_texture, initial) => { initial.mipLevel = 1; },
      (_texture, initial) => { initial.origin = [0, 1, 0]; },
      (_texture, initial) => { initial.aspect = "depth-only"; },
      (_texture, initial) => { initial.bytesPerRow = 15; },
      (_texture, initial) => { initial.rowsPerImage = 3; },
      (texture) => { texture.format = "depth24plus"; },
      (texture) => { texture.format = "bc1-rgba-unorm"; },
    ];
    for (const mutate of cases) {
      const fixture = clone(extendedFixture()) as unknown as Record<string, unknown>;
      const texture = (fixture.resources as Record<string, unknown>[])[2]!;
      mutate(texture, texture.initialData as Record<string, unknown>);
      expect(validateQualificationFixture(fixture).ok).toBe(false);
    }
  });

  it("enforces texture-to-buffer usage, format, sample, range, layout, and destination capacity", () => {
    const cases: readonly ((fixture: Record<string, unknown>, texture: Record<string, unknown>, copy: Record<string, unknown>) => void)[] = [
      (_fixture, texture) => { texture.usage = ["copy-dst", "render-attachment"]; },
      (_fixture, texture) => { texture.initialData = null; texture.mipLevelCount = 1; texture.sampleCount = 4; texture.usage = ["copy-src", "render-attachment"]; },
      (_fixture, texture) => { texture.initialData = null; texture.format = "bc1-rgba-unorm"; },
      (_fixture, _texture, copy) => { (copy.source as Record<string, unknown>).mipLevel = 3; },
      (_fixture, _texture, copy) => { (copy.source as Record<string, unknown>).origin = [4, 0, 0]; },
      (_fixture, _texture, copy) => { (copy.source as Record<string, unknown>).aspect = "depth-only"; },
      (_fixture, _texture, copy) => { copy.extent = [5, 1, 1]; },
      (fixture) => { ((fixture.resources as Record<string, unknown>[])[1]!).usage = ["map-read"]; },
      (_fixture, _texture, copy) => { (copy.destination as Record<string, unknown>).offset = 1; },
      (_fixture, _texture, copy) => { (copy.destination as Record<string, unknown>).offset = 112; },
      (_fixture, _texture, copy) => { (copy.destination as Record<string, unknown>).bytesPerRow = 255; },
      (_fixture, _texture, copy) => { copy.extent = [1, 4, 1]; (copy.destination as Record<string, unknown>).rowsPerImage = 3; },
    ];
    for (const mutate of cases) {
      const fixture = clone(extendedFixture()) as unknown as Record<string, unknown>;
      const texture = (fixture.resources as Record<string, unknown>[])[2]!;
      const copy = (fixture.commands as Record<string, unknown>[])[2]!;
      mutate(fixture, texture, copy);
      expect(validateQualificationFixture(fixture).ok).toBe(false);
    }
  });

  it("accepts render color/depth attachments with exact views and operations", () => {
    const fixture = clone(validVertexQualificationFixture()) as Mutable<ShaderQualificationFixtureManifest>;
    fixture.resources = [
      ...fixture.resources,
      { kind: "texture", resourceId: "color", dimension: "2d", size: [1, 1, 1], mipLevelCount: 1, sampleCount: 1, format: "rgba8unorm", usage: ["render-attachment"], initialData: null },
      { kind: "texture", resourceId: "depth", dimension: "2d", size: [1, 1, 1], mipLevelCount: 1, sampleCount: 1, format: "depth24plus-stencil8", usage: ["render-attachment"], initialData: null },
    ];
    const draw = fixture.commands[0];
    if (draw?.kind !== "draw") throw new Error("Expected draw fixture.");
    (draw as Mutable<typeof draw>).colorAttachments = [{
      resourceId: "color",
      view: { format: null, dimension: null, aspect: "all", baseMipLevel: 0, mipLevelCount: null, baseArrayLayer: 0, arrayLayerCount: null },
      clearValue: [0, 0.5, 1, 1],
      loadOp: "clear",
      storeOp: "store",
    }];
    (draw as Mutable<typeof draw>).depthStencilAttachment = {
      resourceId: "depth",
      view: { format: "depth24plus-stencil8", dimension: "2d", aspect: "all", baseMipLevel: 0, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 1 },
      depthClearValue: 1,
      depthLoadOp: "clear",
      depthStoreOp: "store",
      stencilClearValue: 0,
      stencilLoadOp: "clear",
      stencilStoreOp: "store",
    };
    (fixture.bounds as Mutable<typeof fixture.bounds>).maxTextureTexels = 2;
    expect(validateQualificationFixture(fixture, validVertexInventory().compileUnits[0]).ok).toBe(true);
  });

  it("rejects texture and sampler descriptor boundary violations", () => {
    const cases: readonly ((fixture: Record<string, unknown>) => void)[] = [
      (fixture) => { ((fixture.resources as Record<string, unknown>[])[2] as Record<string, unknown>).dimension = "cube"; },
      (fixture) => { ((fixture.resources as Record<string, unknown>[])[2] as Record<string, unknown>).mipLevelCount = 9; },
      (fixture) => { ((fixture.resources as Record<string, unknown>[])[2] as Record<string, unknown>).sampleCount = 2; },
      (fixture) => { (((fixture.resources as Record<string, unknown>[])[2] as Record<string, unknown>).initialData as Record<string, unknown>).bytesPerRow = 255; },
      (fixture) => { (((fixture.resources as Record<string, unknown>[])[2] as Record<string, unknown>).initialData as Record<string, unknown>).mipLevel = 4; },
      (fixture) => { (((fixture.resources as Record<string, unknown>[])[2] as Record<string, unknown>).initialData as Record<string, unknown>).origin = [4, 0, 0]; },
      (fixture) => { (((fixture.resources as Record<string, unknown>[])[2] as Record<string, unknown>).initialData as Record<string, unknown>).aspect = "color-only"; },
      (fixture) => { ((fixture.resources as Record<string, unknown>[])[2] as Record<string, unknown>).usage = ["invalid"]; },
      (fixture) => { (((fixture.resources as Record<string, unknown>[])[3] as Record<string, unknown>).descriptor as Record<string, unknown>).addressModeU = "invalid"; },
      (fixture) => { (((fixture.resources as Record<string, unknown>[])[3] as Record<string, unknown>).descriptor as Record<string, unknown>).magFilter = "cubic"; },
      (fixture) => { (((fixture.resources as Record<string, unknown>[])[3] as Record<string, unknown>).descriptor as Record<string, unknown>).compare = "invalid"; },
      (fixture) => { (((fixture.resources as Record<string, unknown>[])[3] as Record<string, unknown>).descriptor as Record<string, unknown>).lodMaxClamp = -1; },
      (fixture) => { (((fixture.resources as Record<string, unknown>[])[3] as Record<string, unknown>).descriptor as Record<string, unknown>).maxAnisotropy = 17; },
      (fixture) => { (((fixture.resources as Record<string, unknown>[])[3] as Record<string, unknown>).descriptor as Record<string, unknown>).candidateCode = "run.js"; },
    ];
    for (const mutate of cases) {
      const fixture = clone(extendedFixture()) as unknown as Record<string, unknown>;
      mutate(fixture);
      expect(validateQualificationFixture(fixture).ok).toBe(false);
    }
  });

  it("rejects binding, texture-copy, and render attachment mismatches", () => {
    const bindingCases: readonly ((fixture: Record<string, unknown>) => void)[] = [
      (fixture) => { (((fixture.bindGroups as Record<string, unknown>[])[1]!.entries as Record<string, unknown>[])[0]!.resource as Record<string, unknown>).resourceId = "model"; },
      (fixture) => { (((fixture.bindGroups as Record<string, unknown>[])[1]!.entries as Record<string, unknown>[])[1]!.resource as Record<string, unknown>).resourceId = "color"; },
      (fixture) => { ((fixture.commands as Record<string, unknown>[])[2]!.source as Record<string, unknown>).aspect = "invalid"; },
      (fixture) => { ((fixture.commands as Record<string, unknown>[])[2]!.destination as Record<string, unknown>).resourceId = "color"; },
      (fixture) => { (fixture.commands as Record<string, unknown>[])[0]!.workgroups = [1_048_577, 1, 1]; },
    ];
    for (const mutate of bindingCases) {
      const fixture = clone(extendedFixture()) as unknown as Record<string, unknown>;
      mutate(fixture);
      expect(validateQualificationFixture(fixture).ok).toBe(false);
    }

    const render = clone(validVertexQualificationFixture()) as unknown as Record<string, unknown>;
    (render.commands as Record<string, unknown>[])[0]!.vertexCount = 16_777_217;
    expect(validateQualificationFixture(render, validVertexInventory().compileUnits[0]).ok).toBe(false);
  });

  it("rejects excessively deep or non-finite structured probe values", () => {
    const nonFinite = clone(validQualificationFixture());
    const probe = nonFinite.layoutProbes[0];
    if (probe?.kind !== "buffer-record") throw new Error("Expected buffer probe.");
    (probe.input as Mutable<typeof probe.input>).value = { value: Number.NaN };
    expect(validateQualificationFixture(nonFinite).ok).toBe(false);

    let value: Record<string, unknown> = {};
    for (let index = 0; index < 34; index += 1) value = { nested: value };
    const deep = clone(validQualificationFixture());
    const deepProbe = deep.layoutProbes[0];
    if (deepProbe?.kind !== "buffer-record") throw new Error("Expected buffer probe.");
    (deepProbe.input as Mutable<typeof deepProbe.input>).value = value as unknown as typeof deepProbe.input.value;
    expect(validateQualificationFixture(deep).ok).toBe(false);
  });
});

describe("qualification bundle envelope edge coverage", () => {
  it("rejects wrong versions, missing model fixtures, duplicate paths, unsorted subject IDs, and stale interface digests", async () => {
    const matrix = await stableMatrix();
    const cases: readonly ((bundle: Record<string, unknown>) => void)[] = [
      (bundle) => { bundle.contractVersion = "wrong"; },
      (bundle) => { bundle.modelCompatibilityFixtures = []; },
      (bundle) => { (bundle.modelCompatibilityFixtures as Record<string, unknown>[]).push({ ...(bundle.modelCompatibilityFixtures as Record<string, unknown>[])[0] }); },
      (bundle) => { ((bundle.gpuInterfaceManifest as Record<string, unknown>)).sha256 = ZERO_SHA; },
      (bundle) => { ((bundle.subject as Record<string, unknown>)).modelAbiHashes = [ZERO_SHA, ZERO_SHA]; },
      (bundle) => { ((bundle.subject as Record<string, unknown>)).requiredCompileUnitIds = ["unit.z", "unit.a"]; },
      (bundle) => { (bundle.fixtures as Record<string, unknown>[])[0]!.kind = "other"; },
    ];
    for (const mutate of cases) {
      const bundle = clone(await qualificationBundle(matrix)) as unknown as Record<string, unknown>;
      mutate(bundle);
      expect(validateQualificationBundleManifest(bundle).ok).toBe(false);
    }
  });
});

function validAttestationRef(evidenceSha256: string, bundleSha256: string): ShaderValidationEvidenceAttestationRef {
  const trustedSha = "a".repeat(40);
  return {
    contractVersion: SHADER_VALIDATION_EVIDENCE_VERSION,
    kind: "shader-validation-evidence-attestation-ref",
    evidence: { name: "evidence.json", sha256: evidenceSha256 as ShaderValidationEvidenceAttestationRef["evidence"]["sha256"] },
    attestation: {
      id: "attestation-1",
      url: "https://github.com/Plasius-LTD/gpu-shader/attestations/123",
      bundle: { name: "bundle.json", sha256: bundleSha256 as ShaderValidationEvidenceAttestationRef["attestation"]["bundle"]["sha256"] },
    },
    producer: {
      repository: "Plasius-LTD/gpu-shader",
      runId: "123",
      runAttempt: 1,
      trustedWorkflowRepository: "Plasius-LTD/gpu-shader",
      trustedWorkflowRef: "Plasius-LTD/gpu-shader/.github/workflows/shader-qualification.yml@refs/heads/main",
      trustedWorkflowSha: { algorithm: "sha1", hex: trustedSha },
    },
  };
}

describe("evidence provenance and attestation parser branches", () => {
  it("accepts SHA-256 workflow objects on protected main and rejects malformed provenance fields", () => {
    const sha256 = clone(provenance()) as unknown as Record<string, unknown>;
    sha256.workflowSha = { algorithm: "sha256", hex: "a".repeat(64) };
    sha256.workflowRef = "Plasius-LTD/gpu-shader/.github/workflows/shader-qualification.yml@refs/heads/main";
    expect(parseTrustedWorkflowProvenance(sha256)).toMatchObject({ workflowSha: { algorithm: "sha256" } });

    const cases: readonly ((value: Record<string, unknown>) => void)[] = [
      (value) => { value.repository = "Outside/repo"; },
      (value) => { value.commit = { algorithm: "md5", hex: "a".repeat(40) }; },
      (value) => { value.commit = { algorithm: "sha1", hex: "A".repeat(40) }; },
      (value) => { value.workflowRef = "Plasius-LTD/other/workflow.yml@main"; },
      (value) => { value.workflowRef = "Plasius-LTD/gpu-shader/.github/workflows/shader-qualification.yml@refs/heads/dev"; },
      (value) => { value.workflowRef = `Plasius-LTD/gpu-shader/.github/workflows/shader-qualification.yml@${"a".repeat(40)}`; },
      (value) => { value.runAttempt = 0; },
      (value) => { (value.oidcAttestation as Record<string, unknown>).issuer = "https://issuer.invalid"; },
      (value) => { (value.oidcAttestation as Record<string, unknown>).verifiedAt = "yesterday"; },
    ];
    for (const mutate of cases) {
      const value = clone(provenance()) as unknown as Record<string, unknown>;
      mutate(value);
      expect(() => parseTrustedWorkflowProvenance(value)).toThrow();
    }
  });

  it("rejects malformed execution producer jobs, trusted workflow, and runner identity", async () => {
    const cell = (await stableMatrix()).cells[0]!;
    const cases: readonly ((value: Record<string, unknown>) => void)[] = [
      (value) => { value.repository = "outside/repo"; },
      (value) => { value.job = "prepare"; },
      (value) => { value.trustedWorkflowRepository = "Plasius-LTD/other"; },
      (value) => { (value.runner as Record<string, unknown>).environment = "unknown"; },
      (value) => { (value.runner as Record<string, unknown>).name = ""; },
    ];
    for (const mutate of cases) {
      const value = clone(executionProducer(cell)) as unknown as Record<string, unknown>;
      mutate(value);
      expect(() => parseQualificationExecutionProducer(value)).toThrow();
    }
  });

  it("strictly parses attestation references and verifies exact bytes plus cryptographic result", async () => {
    const evidenceBytes = new TextEncoder().encode("evidence");
    const bundleBytes = new TextEncoder().encode("bundle");
    const ref = validAttestationRef(await computeSha256(evidenceBytes), await computeSha256(bundleBytes));
    expect(parseShaderValidationEvidenceAttestationRef(ref)).toEqual(ref);
    const verify = vi.fn(async () => true);
    const accepted = await verifyShaderValidationEvidenceAttestation({ ref, evidenceBytes, bundleBytes, verifyCryptographicBundle: verify });
    expect(accepted.ok).toBe(true);
    expect(verify).toHaveBeenCalledOnce();

    const cryptographic = await verifyShaderValidationEvidenceAttestation({ ref, evidenceBytes, bundleBytes, verifyCryptographicBundle: async () => false });
    expect(cryptographic.ok).toBe(false);
    const digest = await verifyShaderValidationEvidenceAttestation({ ref, evidenceBytes: Uint8Array.of(0), bundleBytes, verifyCryptographicBundle: async () => true });
    expect(digest.ok).toBe(false);
  });

  it("rejects attestation caller, names, workflow, URL, and bundle forgery", async () => {
    const evidenceBytes = new TextEncoder().encode("evidence");
    const bundleBytes = new TextEncoder().encode("bundle");
    const base = validAttestationRef(await computeSha256(evidenceBytes), await computeSha256(bundleBytes));
    const cases: readonly ((value: Record<string, unknown>) => void)[] = [
      (value) => { (value.producer as Record<string, unknown>).repository = "Outside/repo"; },
      (value) => { (value.producer as Record<string, unknown>).trustedWorkflowRepository = "Plasius-LTD/other"; },
      (value) => { (value.evidence as Record<string, unknown>).name = "evidence.txt"; },
      (value) => { (value.attestation as Record<string, unknown>).url = "http://github.com/Plasius-LTD/gpu-shader/attestations/123"; },
      (value) => { (value.attestation as Record<string, unknown>).url = "https://github.com/Other/repo/attestations/123"; },
      (value) => { (((value.attestation as Record<string, unknown>).bundle as Record<string, unknown>)).name = "bundle.zip"; },
    ];
    for (const mutate of cases) {
      const value = clone(base) as unknown as Record<string, unknown>;
      mutate(value);
      expect(() => parseShaderValidationEvidenceAttestationRef(value)).toThrow();
    }
  });
});
