import ts from "typescript";
import { describe, expect, it } from "vitest";

import { canonicalizeGpuContract } from "../src/canonical-json.js";
import type {
  GpuModelBindingLayout,
  GpuRecordMemberLayout,
  ShaderVersionManifest,
} from "../src/contracts.js";
import { generateGpuInterfaceArtifacts } from "../src/node/generate-artifacts.js";
import { reflectGpuInterface } from "../src/node/reflect.js";
import {
  parseGpuInterfaceManifest,
  parseJsonBytes,
  parseModelGpuCompatibilityDescriptor,
  parseShaderStyleProfileManifest,
  parseShaderVersionManifest,
} from "../src/manifest-validation.js";
import { clone, reflectedInterface, shaderAssets } from "./fixtures.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function expectTypeError(operation: () => unknown, message: string | RegExp, label?: string): void {
  expect(operation, label).toThrow(message);
}

describe("strict manifest parsing", () => {
  it("round-trips and recursively freezes a reflected GPU interface", async () => {
    const reflected = await reflectedInterface();
    const parsed = parseGpuInterfaceManifest(JSON.parse(canonicalizeGpuContract(reflected)));
    expect(parsed).toEqual(reflected);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.records)).toBe(true);
    expect(Object.isFrozen(parsed.records[0]!.members[0])).toBe(true);
  });

  it("rejects unknown nested fields and stale layout algebra", async () => {
    const unknown = clone(await reflectedInterface()) as unknown as Record<string, unknown>;
    (unknown.generatedBy as Record<string, unknown>).untrusted = true;
    expectTypeError(() => parseGpuInterfaceManifest(unknown), /untrusted.*not part/u);

    const staleOffset = clone(await reflectedInterface());
    const member = staleOffset.records.find((record) => record.name === "Nested")!.members[1]!;
    (member as Mutable<GpuRecordMemberLayout>).offset = 8;
    expectTypeError(() => parseGpuInterfaceManifest(staleOffset), /offset|layout|overlap|algebra/u);

    const staleRecordRef = clone(await reflectedInterface());
    const samples = staleRecordRef.records.find((record) => record.name === "ModelData")!.members
      .find((candidate) => candidate.name === "samples")!;
    if (samples.type.kind !== "array" || samples.type.element.kind !== "record") {
      throw new Error("Fixture did not reflect the nested fixed array.");
    }
    (samples.type.element as Mutable<typeof samples.type.element>).byteSize = 32;
    expectTypeError(() => parseGpuInterfaceManifest(staleRecordRef), /stale layout metadata|layout algebra/u);
  });

  it("rejects caller-forged model-facing resource layouts", async () => {
    const forged = clone(await reflectedInterface());
    const modelBinding = forged.modelAbi.bindings[0]! as Mutable<GpuModelBindingLayout>;
    if (modelBinding.resource.kind !== "buffer") throw new Error("Fixture binding must be a buffer.");
    (modelBinding.resource as Mutable<typeof modelBinding.resource>).minimumBindingSize += 16;
    expectTypeError(
      () => parseGpuInterfaceManifest(forged),
      /model.*binding|reflected.*binding|projection|layout/u,
    );
  });

  it("rejects semantic projections that do not resolve exactly once", async () => {
    const missing = clone(await reflectedInterface());
    (missing.modelAbi as Mutable<typeof missing.modelAbi>).semantics = [];
    expectTypeError(() => parseGpuInterfaceManifest(missing), /semantic.*exactly one|projection/u);

    const duplicate = clone(await reflectedInterface());
    (duplicate.modelAbi as Mutable<typeof duplicate.modelAbi>).semantics = [
      ...duplicate.modelAbi.semantics,
      duplicate.modelAbi.semantics[0]!,
    ];
    expectTypeError(() => parseGpuInterfaceManifest(duplicate), /duplicate/u);

    const forgedCoordinates = clone(await reflectedInterface());
    const source = forgedCoordinates.modelAbi.semantics[0]!.source;
    if (source.kind !== "binding") throw new Error("Fixture semantic must select a binding.");
    (source as Mutable<typeof source>).binding = 7;
    expectTypeError(() => parseGpuInterfaceManifest(forgedCoordinates), /missing binding/u);
  });

  it("rejects a binding semantic redirected to a different existing reflected binding", async () => {
    const source = `
      struct Data { value: u32, }
      @group(0) @binding(0) var<storage, read> first: Data;
      @group(0) @binding(1) var<storage, read> second: Data;
      @compute @workgroup_size(1) fn main() { let value = first.value + second.value; }
    `;
    const resource = {
      kind: "buffer" as const,
      addressSpace: "storage" as const,
      access: "read" as const,
      recordName: "Data",
      minimumBindingSize: 4,
    };
    const manifest = await reflectGpuInterface({
      interfaceId: "binding.semantic.interface",
      interfaceVersion: "1",
      modules: [{ moduleId: "bindings", source }],
      pipelines: [{
        kind: "compute",
        pipelineId: "bindings.pipeline",
        layout: { bindGroups: [{ group: 0, entries: [
          { group: 0, binding: 0, resource, visibility: ["compute"] },
          { group: 0, binding: 1, resource, visibility: ["compute"] },
        ] }] },
        compute: { moduleId: "bindings", entryPoint: "main", constants: {} },
      }],
      modelFacingRecordNames: ["Data"],
      modelFacingBindings: [
        { moduleId: "bindings", group: 0, binding: 0, semantic: "model.first" },
        { moduleId: "bindings", group: 0, binding: 1, semantic: "model.second" },
      ],
      semantics: [
        { semantic: "model.first", source: { kind: "binding", moduleId: "bindings", group: 0, binding: 0 } },
        { semantic: "model.second", source: { kind: "binding", moduleId: "bindings", group: 0, binding: 1 } },
      ],
    });
    const forged = clone(manifest);
    const semantic = forged.modelAbi.semantics.find((item) => item.semantic === "model.first")!;
    if (semantic.source.kind !== "binding") throw new Error("Fixture semantic must select a binding.");
    (semantic.source as Mutable<typeof semantic.source>).binding = 1;
    expectTypeError(() => parseGpuInterfaceManifest(forged), /does not resolve to its selected model binding|exactly one/u);
  });

  it("rejects a vertex semantic redirected to a different existing reflected attribute", async () => {
    const source = `
      struct VertexOut { @builtin(position) position: vec4f, }
      @vertex fn vertexMain(@location(0) position: vec3f, @location(1) normal: vec3f) -> VertexOut {
        return VertexOut(vec4f(position + normal * 0.0, 1.0));
      }
    `;
    const manifest = await reflectGpuInterface({
      interfaceId: "vertex.semantic.interface",
      interfaceVersion: "1",
      modules: [{ moduleId: "render", source }],
      pipelines: [{
        kind: "render",
        pipelineId: "render.pipeline",
        layout: { bindGroups: [] },
        vertex: { moduleId: "render", entryPoint: "vertexMain", constants: {} },
        fragment: null,
        vertexBuffers: [{
          arrayStride: 24,
          stepMode: "vertex",
          attributes: [
            { format: "float32x3", offset: 0, shaderLocation: 0, semantic: "model.position" },
            { format: "float32x3", offset: 12, shaderLocation: 1, semantic: "model.normal" },
          ],
        }],
        primitive: { topology: "triangle-list", stripIndexFormat: null, frontFace: "ccw", cullMode: "none", unclippedDepth: false },
        colorTargets: [],
        depthStencil: null,
        multisample: { count: 1, mask: 0xffff_ffff, alphaToCoverageEnabled: false },
      }],
      modelFacingRecordNames: [],
      modelFacingBindings: [],
      semantics: [
        { semantic: "model.position", source: { kind: "vertex-attribute", pipelineId: "render.pipeline", shaderLocation: 0 } },
        { semantic: "model.normal", source: { kind: "vertex-attribute", pipelineId: "render.pipeline", shaderLocation: 1 } },
      ],
    });
    const forged = clone(manifest);
    const semantic = forged.modelAbi.semantics.find((item) => item.semantic === "model.position")!;
    if (semantic.source.kind !== "vertex-attribute") throw new Error("Fixture semantic must select an attribute.");
    (semantic.source as Mutable<typeof semantic.source>).shaderLocation = 1;
    expectTypeError(() => parseGpuInterfaceManifest(forged), /does not resolve to its selected model vertex|exactly one/u);
  });

  it("strictly parses shader/profile manifests and rejects deep contract drift", async () => {
    const { shaderManifest, profileManifest } = await shaderAssets();
    expect(parseShaderVersionManifest(clone(shaderManifest))).toEqual(shaderManifest);
    expect(parseShaderStyleProfileManifest(clone(profileManifest))).toEqual(profileManifest);

    const missingAttestationRef = clone(shaderManifest);
    delete (missingAttestationRef.validationEvidence as unknown as Record<string, unknown>).attestationRef;
    expectTypeError(() => parseShaderVersionManifest(missingAttestationRef), /attestationRef is required/u);

    const forgedAttestationRef = clone(shaderManifest);
    (forgedAttestationRef.validationEvidence.attestationRef as Mutable<typeof forgedAttestationRef.validationEvidence.attestationRef>).sha256 = "not-a-digest" as typeof shaderManifest.validationEvidence.attestationRef.sha256;
    expectTypeError(() => parseShaderVersionManifest(forgedAttestationRef), /attestationRef.*SHA-256/u);

    const unknownPipeline = clone(shaderManifest);
    (unknownPipeline.pipelines[0] as unknown as Record<string, unknown>).manualLayout = 64;
    expectTypeError(() => parseShaderVersionManifest(unknownPipeline), /manualLayout|unknown/u);

    const nonFinite = clone(shaderManifest);
    const compute = nonFinite.pipelines[0];
    if (compute?.kind !== "compute") throw new Error("Fixture pipeline must be compute.");
    (compute.compute.constants as Record<string, number>).WORKGROUP_X = Number.NaN;
    expectTypeError(() => parseShaderVersionManifest(nonFinite), /finite/u);

    const unassigned = clone(shaderManifest);
    (unassigned.renderRoles[0] as Mutable<typeof unassigned.renderRoles[number]>).pipelineIds = [];
    expectTypeError(() => parseShaderVersionManifest(unassigned), /pipelineIds must not be empty|Every pipeline/u);

    const wrongRole = clone(profileManifest);
    (wrongRole.roles[0] as Mutable<typeof wrongRole.roles[number]>).role = "not-a-role" as "material";
    expectTypeError(() => parseShaderStyleProfileManifest(wrongRole), /role.*invalid/u);

    const duplicateRole = clone(profileManifest);
    (duplicateRole as Mutable<typeof duplicateRole>).roles = [...duplicateRole.roles, duplicateRole.roles[0]!];
    expectTypeError(() => parseShaderStyleProfileManifest(duplicateRole), /duplicate/u);

    const noCompatibleModel = clone(profileManifest);
    (noCompatibleModel as Mutable<typeof noCompatibleModel>).compatibleModelInterfaces = [];
    expectTypeError(() => parseShaderStyleProfileManifest(noCompatibleModel), /compatibleModelInterfaces.*must not be empty/u);
  });

  it("fails closed for unregistered additive policies and evidence relabelling", async () => {
    const { shaderManifest, profileManifest } = await shaderAssets();
    const xrEvidence = {
      ...shaderManifest.validationEvidence,
      evidenceId: "qualification-xr",
      uri: "https://catalog.example/evidence/qualification-xr.json",
      sha256: "7".repeat(64) as typeof shaderManifest.validationEvidence.sha256,
      matrixId: "webgpu-xr",
      matrixVersion: "2026-07-13",
      matrixSha256: "3".repeat(64) as typeof shaderManifest.validationEvidence.matrixSha256,
      attestationRef: {
        uri: "https://catalog.example/evidence/qualification-xr.attestation.json",
        sha256: "4".repeat(64) as typeof shaderManifest.validationEvidence.attestationRef.sha256,
      },
    };
    const xrShader = clone(shaderManifest);
    (xrShader as Mutable<typeof xrShader>).additionalValidationEvidence = [{ scope: "xr", evidence: xrEvidence }];
    expectTypeError(() => parseShaderVersionManifest(xrShader), /not bound to a supported additive/u);

    const xrProfile = clone(profileManifest);
    const xrRequirement = {
      scope: "xr",
      matrixId: xrEvidence.matrixId,
      matrixVersion: xrEvidence.matrixVersion,
      matrixSha256: xrEvidence.matrixSha256,
    };
    (xrProfile as Mutable<typeof xrProfile>).requiredValidationScopes = [xrRequirement];
    expectTypeError(() => parseShaderStyleProfileManifest(xrProfile), /not a supported additive/u);

    const duplicateScope = clone(xrShader);
    (duplicateScope as Mutable<typeof duplicateScope>).additionalValidationEvidence = [
      ...duplicateScope.additionalValidationEvidence,
      duplicateScope.additionalValidationEvidence[0]!,
    ];
    expectTypeError(() => parseShaderVersionManifest(duplicateScope), /scopes.*duplicate/u);

    const reservedScope = clone(xrShader);
    (reservedScope.additionalValidationEvidence[0] as Mutable<typeof reservedScope.additionalValidationEvidence[number]>).scope = "universal";
    expectTypeError(() => parseShaderVersionManifest(reservedScope), /universal is reserved/u);

    const reservedProfile = clone(xrProfile);
    (reservedProfile as Mutable<typeof reservedProfile>).requiredValidationScopes = [{
      ...xrRequirement,
      scope: "universal",
    }];
    expectTypeError(() => parseShaderStyleProfileManifest(reservedProfile), /reserved universal/u);

    const relabelledUniversal = clone(shaderManifest);
    (relabelledUniversal as Mutable<typeof relabelledUniversal>).additionalValidationEvidence = [{
      scope: "xr",
      evidence: { ...relabelledUniversal.validationEvidence, evidenceId: "fake-xr" },
    }];
    expectTypeError(() => parseShaderVersionManifest(relabelledUniversal), /additive matrix policy/u);

    const universal = shaderManifest.validationEvidence;
    const universalCollisions = [
      ["evidence ID", { ...xrEvidence, evidenceId: universal.evidenceId }, /evidence ID/u],
      ["evidence URI", { ...xrEvidence, uri: universal.uri }, /evidence\/attestation URI/u],
      ["evidence digest", { ...xrEvidence, sha256: universal.sha256 }, /evidence\/attestation digest/u],
      ["attestation URI", { ...xrEvidence, attestationRef: { ...xrEvidence.attestationRef, uri: universal.attestationRef.uri } }, /evidence\/attestation URI/u],
      ["attestation digest", { ...xrEvidence, attestationRef: { ...xrEvidence.attestationRef, sha256: universal.attestationRef.sha256 } }, /evidence\/attestation digest/u],
      ["cross-kind URI", { ...xrEvidence, uri: universal.attestationRef.uri }, /evidence\/attestation URI/u],
      ["cross-kind digest", { ...xrEvidence, sha256: universal.attestationRef.sha256 }, /evidence\/attestation digest/u],
    ] as const;
    for (const [label, evidence, expected] of universalCollisions) {
      const candidate = clone(shaderManifest);
      (candidate as Mutable<typeof candidate>).additionalValidationEvidence = [{ scope: "xr", evidence }];
      expectTypeError(() => parseShaderVersionManifest(candidate), expected, label);
    }

    const spatialEvidence = {
      ...xrEvidence,
      evidenceId: "qualification-spatial",
      uri: "https://catalog.example/evidence/qualification-spatial.json",
      sha256: "8".repeat(64) as typeof xrEvidence.sha256,
      matrixId: "webgpu-spatial",
      matrixVersion: "2026-07-14",
      matrixSha256: "6".repeat(64) as typeof xrEvidence.matrixSha256,
      attestationRef: {
        uri: "https://catalog.example/evidence/qualification-spatial.attestation.json",
        sha256: "9".repeat(64) as typeof xrEvidence.attestationRef.sha256,
      },
    };
    const supplementalCollisions = [
      ["evidence ID", { ...spatialEvidence, evidenceId: xrEvidence.evidenceId }, /evidence ID/u],
      ["evidence URI", { ...spatialEvidence, uri: xrEvidence.uri }, /evidence\/attestation URI/u],
      ["evidence digest", { ...spatialEvidence, sha256: xrEvidence.sha256 }, /evidence\/attestation digest/u],
      ["attestation URI", { ...spatialEvidence, attestationRef: { ...spatialEvidence.attestationRef, uri: xrEvidence.attestationRef.uri } }, /evidence\/attestation URI/u],
      ["attestation digest", { ...spatialEvidence, attestationRef: { ...spatialEvidence.attestationRef, sha256: xrEvidence.attestationRef.sha256 } }, /evidence\/attestation digest/u],
      ["cross-kind URI", { ...spatialEvidence, uri: xrEvidence.attestationRef.uri }, /evidence\/attestation URI/u],
      ["cross-kind digest", { ...spatialEvidence, sha256: xrEvidence.attestationRef.sha256 }, /evidence\/attestation digest/u],
    ] as const;
    for (const [label, evidence, expected] of supplementalCollisions) {
      const candidate = clone(shaderManifest);
      (candidate as Mutable<typeof candidate>).additionalValidationEvidence = [
        { scope: "xr", evidence: xrEvidence },
        { scope: "spatial", evidence },
      ];
      expectTypeError(() => parseShaderVersionManifest(candidate), expected, label);
    }

    const selfCollidingUri = clone(shaderManifest);
    (selfCollidingUri.validationEvidence.attestationRef as Mutable<typeof selfCollidingUri.validationEvidence.attestationRef>).uri = selfCollidingUri.validationEvidence.uri;
    expectTypeError(() => parseShaderVersionManifest(selfCollidingUri), /distinct URIs and digests/u);

    const selfCollidingDigest = clone(shaderManifest);
    (selfCollidingDigest.validationEvidence.attestationRef as Mutable<typeof selfCollidingDigest.validationEvidence.attestationRef>).sha256 = selfCollidingDigest.validationEvidence.sha256;
    expectTypeError(() => parseShaderVersionManifest(selfCollidingDigest), /distinct URIs and digests/u);

    const staleUniversalPolicy = clone(shaderManifest);
    (staleUniversalPolicy.validationEvidence as Mutable<typeof staleUniversalPolicy.validationEvidence>).matrixSha256 = "4".repeat(64) as typeof staleUniversalPolicy.validationEvidence.matrixSha256;
    expectTypeError(() => parseShaderVersionManifest(staleUniversalPolicy), /supported universal/u);
  });

  it("strictly preserves an exact default style-profile ref and permits an explicit null default", async () => {
    const assets = await shaderAssets();
    expect(parseModelGpuCompatibilityDescriptor(clone(assets.model))).toEqual(assets.model);
    expect(assets.model.defaultStyleProfile).toEqual(assets.profileRef);

    const noDefault = clone(assets.model);
    (noDefault as Mutable<typeof noDefault>).defaultStyleProfile = null;
    expect(parseModelGpuCompatibilityDescriptor(noDefault).defaultStyleProfile).toBeNull();

    const forged = clone(assets.model);
    (forged.defaultStyleProfile as Mutable<NonNullable<typeof forged.defaultStyleProfile>>).manifestSha256 = "not-a-digest" as typeof assets.profileRef.manifestSha256;
    expectTypeError(() => parseModelGpuCompatibilityDescriptor(forged), /defaultStyleProfile.*SHA-256/u);
  });

  it("rejects malformed UTF-8, invalid JSON and digest/SAS URI forgery", async () => {
    expectTypeError(() => parseJsonBytes(Uint8Array.of(0xff), "manifest"), /UTF-8 JSON/u);
    expectTypeError(() => parseJsonBytes(new TextEncoder().encode("{"), "manifest"), /UTF-8 JSON/u);

    const { shaderManifest } = await shaderAssets();
    const badDigest = clone(shaderManifest);
    (badDigest as Mutable<ShaderVersionManifest>).shaderAbiHash = "A".repeat(64) as ShaderVersionManifest["shaderAbiHash"];
    expectTypeError(() => parseShaderVersionManifest(badDigest), /lowercase SHA-256/u);

    const sas = clone(shaderManifest);
    (sas.modules[0] as Mutable<typeof sas.modules[number]>).uri =
      "https://account.blob.core.windows.net/assets/shader.wgsl?versionid=one&sig=secret";
    expectTypeError(() => parseShaderVersionManifest(sas), /SAS credentials/u);

    const aliased = clone(shaderManifest);
    (aliased.modules[0] as Mutable<typeof aliased.modules[number]>).uri =
      "https://ASSETS.example.invalid:443/shaders/../shaders/main.wgsl";
    expectTypeError(() => parseShaderVersionManifest(aliased), /canonical URL serialization/u);

    const aliasedEvidence = clone(shaderManifest);
    (aliasedEvidence.validationEvidence as Mutable<typeof aliasedEvidence.validationEvidence>).uri =
      "https://assets.example.invalid/evidence/a/../qualification-test.json";
    expectTypeError(() => parseShaderVersionManifest(aliasedEvidence), /canonical URL serialization/u);
  });
});

describe("generated interface artifacts", () => {
  it("emits deterministic canonical manifest JSON and syntactically valid TypeScript", async () => {
    const manifest = await reflectedInterface();
    const first = generateGpuInterfaceArtifacts(manifest);
    const second = generateGpuInterfaceArtifacts({ ...manifest, records: [...manifest.records].reverse() });
    expect(first).toEqual(second);
    expect(JSON.parse(first.manifestJson)).toEqual(JSON.parse(canonicalizeGpuContract(manifest)));
    expect(first.byteConstants).toContain("MODEL_DATA_BYTE_SIZE = 112");
    expect(first.byteConstants).toContain("MODEL_DATA_RADIUS_OFFSET = 96");
    expect(first.typescriptTypes).toContain("export interface ModelDataGpuRecord");
    const schema = JSON.parse(first.jsonSchemas) as Record<string, unknown>;
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$defs).toEqual(expect.objectContaining({ ModelData: expect.any(Object), Nested: expect.any(Object) }));

    for (const [name, source] of Object.entries({
      types: first.typescriptTypes,
      constants: first.byteConstants,
      codecs: first.codecs,
    })) {
      const result = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, strict: true },
        reportDiagnostics: true,
        fileName: `${name}.ts`,
      });
      expect(result.diagnostics, name).toEqual([]);
    }
  });
});
