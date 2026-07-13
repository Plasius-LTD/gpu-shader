import { describe, expect, it } from "vitest";

import {
  SHADER_QUALIFICATION_FIXTURE_VERSION,
  type GpuInterfaceManifest,
  type GpuRecordLayout,
  type SerializableGpuRenderPipelineDescriptor,
  type ShaderVersionManifest,
  type ShaderVersionManifestCore,
} from "../src/contracts.js";
import {
  parseGpuInterfaceManifest,
  parseSerializableGpuPipelineDescriptors,
  parseShaderStyleProfileManifest,
  parseShaderQualificationModelCompatibilityFixture,
  parseShaderVersionManifest,
  parseShaderVersionManifestCore,
} from "../src/manifest-validation.js";
import {
  inferWgslRequiredFeatures,
  validateShaderDerivedRequirements,
} from "../src/requirements-validation.js";
import {
  clone,
  COMPUTE_WGSL,
  reflectedInterface,
  shaderAssets,
} from "./fixtures.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function renderPipeline(): SerializableGpuRenderPipelineDescriptor {
  const blend = {
    operation: "add" as const,
    srcFactor: "src-alpha" as const,
    dstFactor: "one-minus-src-alpha" as const,
  };
  const stencil = {
    compare: "always" as const,
    failOp: "keep" as const,
    depthFailOp: "increment-clamp" as const,
    passOp: "replace" as const,
  };
  return {
    kind: "render",
    pipelineId: "model.render",
    layout: {
      bindGroups: [{
        group: 0,
        entries: [
          {
            group: 0,
            binding: 0,
            resource: { kind: "sampler", samplerType: "filtering" },
            visibility: ["fragment"],
          },
          {
            group: 0,
            binding: 1,
            resource: {
              kind: "texture",
              sampleType: "float",
              viewDimension: "2d",
              multisampled: false,
            },
            visibility: ["fragment"],
          },
          {
            group: 0,
            binding: 2,
            resource: {
              kind: "storage-texture",
              access: "write-only",
              format: "rgba8unorm",
              viewDimension: "2d",
            },
            visibility: ["fragment"],
          },
          {
            group: 0,
            binding: 3,
            resource: { kind: "external-texture" },
            visibility: ["fragment"],
          },
          {
            group: 0,
            binding: 4,
            resource: {
              kind: "buffer",
              addressSpace: "uniform",
              access: "read",
              recordName: null,
              minimumBindingSize: 0,
            },
            visibility: ["vertex", "fragment"],
          },
        ],
      }],
    },
    vertex: { moduleId: "compute", entryPoint: "vertexMain", constants: { ENABLED: true } },
    fragment: { moduleId: "compute", entryPoint: "fragmentMain", constants: { SCALE: 1 } },
    vertexBuffers: [{
      arrayStride: 16,
      stepMode: "instance",
      attributes: [{
        format: "float32x4",
        offset: 0,
        shaderLocation: 0,
        semantic: null,
      }],
    }],
    primitive: {
      topology: "triangle-strip",
      stripIndexFormat: "uint32",
      frontFace: "cw",
      cullMode: "back",
      unclippedDepth: true,
    },
    colorTargets: [{
      format: "bgra8unorm",
      blend: { color: blend, alpha: blend },
      writeMask: 15,
    }],
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: true,
      depthCompare: "less-equal",
      stencilFront: stencil,
      stencilBack: stencil,
      stencilReadMask: 0xffff_ffff,
      stencilWriteMask: 0xffff_ffff,
      depthBias: -1,
      depthBiasSlopeScale: 1.5,
      depthBiasClamp: 0,
    },
    multisample: { count: 4, mask: 0xffff_ffff, alphaToCoverageEnabled: true },
  };
}

async function renderShaderManifest(): Promise<ShaderVersionManifest> {
  const assets = await shaderAssets();
  return {
    ...clone(assets.shaderManifest),
    pipelines: [renderPipeline()],
    renderRoles: [{ role: "material", pipelineIds: ["model.render"] }],
    requirements: {
      ...assets.shaderManifest.requirements,
      features: ["shader-f16", "depth-clip-control"],
      formats: ["rgba8unorm", "bgra8unorm", "depth24plus-stencil8"],
      limits: [
        { name: "maxBindGroups", comparator: "at-least", value: 1 },
        { name: "maxBindingsPerBindGroup", comparator: "at-least", value: 5 },
        { name: "maxBindGroupsPlusVertexBuffers", comparator: "at-least", value: 2 },
        { name: "maxSampledTexturesPerShaderStage", comparator: "at-least", value: 5 },
        { name: "maxSamplersPerShaderStage", comparator: "at-least", value: 2 },
        { name: "maxStorageTexturesPerShaderStage", comparator: "at-least", value: 1 },
        { name: "maxUniformBuffersPerShaderStage", comparator: "at-least", value: 2 },
        { name: "maxVertexBuffers", comparator: "at-least", value: 1 },
        { name: "maxVertexAttributes", comparator: "at-least", value: 1 },
        { name: "maxVertexBufferArrayStride", comparator: "at-least", value: 16 },
        { name: "maxColorAttachments", comparator: "at-least", value: 1 },
      ],
    },
  };
}

function withoutEvidence(manifest: ShaderVersionManifest): ShaderVersionManifestCore {
  const { validationEvidence, additionalValidationEvidence, ...core } = manifest;
  void validationEvidence;
  void additionalValidationEvidence;
  return core;
}

describe("strict render pipeline and manifest contracts", () => {
  it("parses every stable explicit render descriptor state used by admission", async () => {
    const pipeline = renderPipeline();
    expect(parseSerializableGpuPipelineDescriptors([pipeline], ["compute"])).toEqual([pipeline]);

    const manifest = await renderShaderManifest();
    const parsed = parseShaderVersionManifest(manifest);
    expect(parsed.pipelines).toEqual([pipeline]);
    expect(Object.isFrozen(parsed.pipelines[0])).toBe(true);
  });

  it.each([
    ["uniform write access", (pipeline: SerializableGpuRenderPipelineDescriptor) => {
      const resource = pipeline.layout.bindGroups[0]!.entries[4]!.resource;
      if (resource.kind !== "buffer") throw new Error("Expected a buffer fixture.");
      (resource as Mutable<typeof resource>).access = "write";
    }, /access must be read/u],
    ["non-boolean texture multisampling", (pipeline: SerializableGpuRenderPipelineDescriptor) => {
      const resource = pipeline.layout.bindGroups[0]!.entries[1]!.resource;
      if (resource.kind !== "texture") throw new Error("Expected a texture fixture.");
      (resource as unknown as Record<string, unknown>).multisampled = "false";
    }, /multisampled must be boolean/u],
    ["empty visibility", (pipeline: SerializableGpuRenderPipelineDescriptor) => {
      (pipeline.layout.bindGroups[0]!.entries[0] as Mutable<typeof pipeline.layout.bindGroups[0]["entries"][number]>).visibility = [];
    }, /must include at least one shader stage/u],
    ["entry parent group mismatch", (pipeline: SerializableGpuRenderPipelineDescriptor) => {
      (pipeline.layout.bindGroups[0]!.entries[0] as Mutable<typeof pipeline.layout.bindGroups[0]["entries"][number]>).group = 1;
    }, /differs from its parent/u],
    ["strip index on a list topology", (pipeline: SerializableGpuRenderPipelineDescriptor) => {
      (pipeline.primitive as Mutable<typeof pipeline.primitive>).topology = "triangle-list";
    }, /only valid for strip topologies/u],
    ["alpha-to-coverage without multisampling", (pipeline: SerializableGpuRenderPipelineDescriptor) => {
      (pipeline.multisample as Mutable<typeof pipeline.multisample>).count = 1;
    }, /requires multisampling/u],
    ["unknown programmable module", (pipeline: SerializableGpuRenderPipelineDescriptor) => {
      (pipeline.vertex as Mutable<typeof pipeline.vertex>).moduleId = "missing";
    }, /moduleId is not in modules/u],
    ["non-boolean unclipped depth", (pipeline: SerializableGpuRenderPipelineDescriptor) => {
      (pipeline.primitive as unknown as Record<string, unknown>).unclippedDepth = "false";
    }, /unclippedDepth must be boolean/u],
    ["non-boolean depth writes", (pipeline: SerializableGpuRenderPipelineDescriptor) => {
      if (pipeline.depthStencil === null) throw new Error("Expected a depth fixture.");
      (pipeline.depthStencil as unknown as Record<string, unknown>).depthWriteEnabled = "true";
    }, /depthWriteEnabled must be boolean/u],
    ["non-boolean alpha-to-coverage", (pipeline: SerializableGpuRenderPipelineDescriptor) => {
      (pipeline.multisample as unknown as Record<string, unknown>).alphaToCoverageEnabled = 1;
    }, /alphaToCoverageEnabled must be boolean/u],
  ])("rejects %s", (_label, mutate, error) => {
    const pipeline = clone(renderPipeline());
    mutate(pipeline);
    expect(() => parseSerializableGpuPipelineDescriptors([pipeline], ["compute"])).toThrow(error);
  });

  it("rejects color attachments without a fragment stage and non-contiguous bind groups", () => {
    const noFragment = clone(renderPipeline());
    (noFragment as Mutable<typeof noFragment>).fragment = null;
    expect(() => parseSerializableGpuPipelineDescriptors([noFragment], ["compute"])).toThrow(
      "colorTargets must be empty",
    );

    const nonContiguous = clone(renderPipeline());
    (nonContiguous.layout as Mutable<typeof nonContiguous.layout>).bindGroups = [{
      ...nonContiguous.layout.bindGroups[0]!,
      group: 1,
      entries: nonContiguous.layout.bindGroups[0]!.entries.map((entry) => ({ ...entry, group: 1 })),
    }];
    expect(() => parseSerializableGpuPipelineDescriptors([nonContiguous], ["compute"])).toThrow(
      "contiguous from zero",
    );
  });

  it.each([
    ["depth clip feature", (manifest: ShaderVersionManifest) => {
      (manifest.requirements as Mutable<typeof manifest.requirements>).features = ["shader-f16"];
    }, /depth-clip-control/u],
    ["storage texture format", (manifest: ShaderVersionManifest) => {
      (manifest.requirements as Mutable<typeof manifest.requirements>).formats = [
        "bgra8unorm",
        "depth24plus-stencil8",
      ];
    }, /omits structurally required format rgba8unorm/u],
    ["color target format", (manifest: ShaderVersionManifest) => {
      (manifest.requirements as Mutable<typeof manifest.requirements>).formats = [
        "rgba8unorm",
        "depth24plus-stencil8",
      ];
    }, /omits structurally required format bgra8unorm/u],
    ["depth format", (manifest: ShaderVersionManifest) => {
      (manifest.requirements as Mutable<typeof manifest.requirements>).formats = [
        "rgba8unorm",
        "bgra8unorm",
      ];
    }, /omits structurally required format depth24plus-stencil8/u],
    ["vertex stride limit", (manifest: ShaderVersionManifest) => {
      (manifest.requirements as Mutable<typeof manifest.requirements>).limits = manifest.requirements.limits.filter(
        (limit) => limit.name !== "maxVertexBufferArrayStride",
      );
    }, /maxVertexBufferArrayStride at least 16/u],
    ["external-texture expanded sampled-texture slots", (manifest: ShaderVersionManifest) => {
      (manifest.requirements as Mutable<typeof manifest.requirements>).limits = manifest.requirements.limits.map(
        (limit) => limit.name === "maxSampledTexturesPerShaderStage" ? { ...limit, value: 4 } : limit,
      );
    }, /maxSampledTexturesPerShaderStage at least 5/u],
    ["per-stage sampler slots", (manifest: ShaderVersionManifest) => {
      (manifest.requirements as Mutable<typeof manifest.requirements>).limits = manifest.requirements.limits.filter(
        (limit) => limit.name !== "maxSamplersPerShaderStage",
      );
    }, /maxSamplersPerShaderStage at least 2/u],
    ["bind-group plus vertex-buffer slots", (manifest: ShaderVersionManifest) => {
      (manifest.requirements as Mutable<typeof manifest.requirements>).limits = manifest.requirements.limits.filter(
        (limit) => limit.name !== "maxBindGroupsPlusVertexBuffers",
      );
    }, /maxBindGroupsPlusVertexBuffers at least 2/u],
  ])("rejects a manifest that understates its derived %s", async (_label, mutate, error) => {
    const manifest = await renderShaderManifest();
    mutate(manifest);
    expect(() => parseShaderVersionManifest(manifest)).toThrow(error);
  });

  it("round-trips a cycle-free shader core and rejects evidence in that contract", async () => {
    const manifest = await renderShaderManifest();
    const core = withoutEvidence(manifest);
    expect(parseShaderVersionManifestCore(core)).toEqual(core);
    expect(() => parseShaderVersionManifestCore(manifest)).toThrow(
      "must not contain validationEvidence",
    );
  });
});

describe("strict reflected record boundaries", () => {
  it("accepts a direct trailing runtime-sized array", async () => {
    const manifest = clone(await reflectedInterface());
    const runtimeRecord: GpuRecordLayout = {
      name: "RuntimeValues",
      alignment: 16,
      byteSize: null,
      minimumByteSize: 16,
      runtimeArrayMember: "values",
      addressSpaces: ["storage"],
      members: [
        {
          name: "count",
          offset: 0,
          alignment: 4,
          valueByteSize: 4,
          occupiedByteSize: 4,
          explicitAlign: null,
          explicitSize: null,
          type: { kind: "scalar", scalar: "u32", alignment: 4, byteSize: 4 },
        },
        {
          name: "values",
          offset: 16,
          alignment: 16,
          valueByteSize: null,
          occupiedByteSize: null,
          explicitAlign: null,
          explicitSize: null,
          type: {
            kind: "array",
            element: { kind: "vector", scalar: "f32", width: 3, alignment: 16, byteSize: 12 },
            count: null,
            stride: 16,
            alignment: 16,
            byteSize: null,
          },
        },
      ],
    };
    (manifest as Mutable<GpuInterfaceManifest>).records = [...manifest.records, runtimeRecord];

    expect(parseGpuInterfaceManifest(manifest).records.at(-1)).toEqual(runtimeRecord);
  });

  it.each([
    ["non-power-of-two explicit alignment", (record: GpuRecordLayout) => {
      const member = record.members[0]!;
      (member as Mutable<typeof member>).explicitAlign = 6;
      (member as Mutable<typeof member>).alignment = 6;
    }, /explicitAlign must be a power of two/u],
    ["shrinking explicit size", (record: GpuRecordLayout) => {
      const member = record.members[0]!;
      (member as Mutable<typeof member>).explicitSize = 8;
      (member as Mutable<typeof member>).occupiedByteSize = 8;
    }, /explicitSize must not shrink/u],
    ["duplicate address space", (record: GpuRecordLayout) => {
      (record as Mutable<typeof record>).addressSpaces = ["storage", "storage"];
    }, /duplicate storage/u],
  ])("rejects a record with %s", async (_label, mutate, error) => {
    const manifest = clone(await reflectedInterface());
    const record = manifest.records.find((candidate) => candidate.name === "ModelData")!;
    mutate(record);
    expect(() => parseGpuInterfaceManifest(manifest)).toThrow(error);
  });

  it("rejects unsafe tokens, invalid provenance and duplicate immutable URI query keys", async () => {
    const unsafeToken = clone(await reflectedInterface());
    (unsafeToken as Mutable<typeof unsafeToken>).interfaceId = "../escape";
    expect(() => parseGpuInterfaceManifest(unsafeToken)).toThrow("safe token");

    const provenance = clone(await reflectedInterface());
    (provenance.generatedBy as Mutable<typeof provenance.generatedBy>).reflectorVersion = "2.0.0" as "1.5.0";
    expect(() => parseGpuInterfaceManifest(provenance)).toThrow("Unsupported reflector provenance");

    const assets = await shaderAssets();
    const duplicateQuery = clone(assets.shaderManifest);
    (duplicateQuery.modules[0] as Mutable<typeof duplicateQuery.modules[number]>).uri =
      "https://assets.example.invalid/module.wgsl?versionid=one&VersionId=two";
    expect(() => parseShaderVersionManifest(duplicateQuery)).toThrow("duplicate query parameters");
  });

  it("strictly parses the model compatibility qualification fixture version", async () => {
    const assets = await shaderAssets();
    const fixture = {
      contractVersion: SHADER_QUALIFICATION_FIXTURE_VERSION,
      fixtureId: "fixture.model",
      model: assets.model,
    };
    expect(parseShaderQualificationModelCompatibilityFixture(fixture)).toEqual(fixture);
    expect(() => parseShaderQualificationModelCompatibilityFixture({
      ...fixture,
      contractVersion: "2.0.0",
    })).toThrow("Unsupported model compatibility fixture version");
  });

  it.each([
    ["non-object root", async () => null, /must be an object/u],
    ["missing required field", async () => {
      const manifest = clone(await reflectedInterface()) as unknown as Record<string, unknown>;
      delete manifest.generatedBy;
      return manifest;
    }, /generatedBy is required/u],
    ["empty identifier", async () => ({ ...clone(await reflectedInterface()), interfaceId: "" }), /bounded non-empty string/u],
    ["unsupported contract version", async () => ({ ...clone(await reflectedInterface()), contractVersion: "2.0.0" }), /Unsupported GPU interface contract version/u],
    ["empty module closure", async () => ({ ...clone(await reflectedInterface()), modules: [] }), /modules must not be empty/u],
    ["non-array records", async () => ({ ...clone(await reflectedInterface()), records: {} }), /records must be a bounded array/u],
  ])("rejects an interface with %s", async (_label, createValue, error) => {
    const value = await createValue();
    expect(() => parseGpuInterfaceManifest(value)).toThrow(error);
  });

  it.each([
    ["stale scalar algebra", (manifest: GpuInterfaceManifest) => {
      const record = manifest.records.find((candidate) => candidate.name === "ModelData")!;
      const member = record.members.find((candidate) => candidate.name === "radius")!;
      if (member.type.kind !== "scalar") throw new Error("Expected a scalar fixture.");
      (member.type as Mutable<typeof member.type>).byteSize = 8;
    }, /inconsistent scalar layout/u],
    ["stale atomic algebra", (manifest: GpuInterfaceManifest) => {
      const record = manifest.records.find((candidate) => candidate.name === "ModelData")!;
      const member = record.members.find((candidate) => candidate.name === "counter")!;
      if (member.type.kind !== "atomic") throw new Error("Expected an atomic fixture.");
      (member.type as Mutable<typeof member.type>).alignment = 8;
    }, /inconsistent atomic layout/u],
    ["stale vector algebra", (manifest: GpuInterfaceManifest) => {
      const record = manifest.records.find((candidate) => candidate.name === "Nested")!;
      const member = record.members.find((candidate) => candidate.name === "axis")!;
      if (member.type.kind !== "vector") throw new Error("Expected a vector fixture.");
      (member.type as Mutable<typeof member.type>).byteSize = 16;
    }, /inconsistent vector layout/u],
    ["stale matrix algebra", (manifest: GpuInterfaceManifest) => {
      const record = manifest.records.find((candidate) => candidate.name === "ModelData")!;
      const member = record.members.find((candidate) => candidate.name === "transform")!;
      if (member.type.kind !== "matrix") throw new Error("Expected a matrix fixture.");
      (member.type as Mutable<typeof member.type>).columnStride = 12;
    }, /inconsistent matrix layout/u],
    ["inconsistent runtime metadata", (manifest: GpuInterfaceManifest) => {
      const record = manifest.records.find((candidate) => candidate.name === "Nested")!;
      (record as Mutable<typeof record>).byteSize = null;
    }, /inconsistent runtime array metadata/u],
    ["stale record alignment", (manifest: GpuInterfaceManifest) => {
      const record = manifest.records.find((candidate) => candidate.name === "Nested")!;
      (record as Mutable<typeof record>).alignment = 32;
    }, /alignment is inconsistent/u],
    ["stale fixed size", (manifest: GpuInterfaceManifest) => {
      const record = manifest.records.find((candidate) => candidate.name === "Nested")!;
      (record as Mutable<typeof record>).minimumByteSize += 16;
    }, /inconsistent fixed\/runtime size metadata/u],
  ])("rejects a reflected interface with %s", async (_label, mutate, error) => {
    const manifest = clone(await reflectedInterface());
    mutate(manifest);
    expect(() => parseGpuInterfaceManifest(manifest)).toThrow(error);
  });

  it("rejects excessive type nesting before recursive reflection data can exhaust the stack", async () => {
    const manifest = clone(await reflectedInterface());
    const record = manifest.records.find((candidate) => candidate.name === "Nested")!;
    const member = record.members[0]!;
    let type: unknown = { kind: "scalar", scalar: "f32", alignment: 4, byteSize: 4 };
    for (let index = 0; index < 26; index += 1) {
      type = { kind: "array", element: type, count: 1, stride: 4, alignment: 4, byteSize: 4 };
    }
    (member as unknown as Record<string, unknown>).type = type;

    expect(() => parseGpuInterfaceManifest(manifest)).toThrow("exceeds the type nesting limit");
  });

  it("accepts and resolves a record-member semantic projection", async () => {
    const manifest = clone(await reflectedInterface());
    (manifest.modelAbi as Mutable<typeof manifest.modelAbi>).semantics = [
      ...manifest.modelAbi.semantics,
      {
        semantic: "model.radius",
        source: { kind: "record-member", recordName: "ModelData", memberPath: ["radius"] },
      },
    ];
    expect(parseGpuInterfaceManifest(manifest).modelAbi.semantics).toContainEqual({
      semantic: "model.radius",
      source: { kind: "record-member", recordName: "ModelData", memberPath: ["radius"] },
    });
  });

  it.each([
    ["missing semantic record", "Missing", ["value"], /references missing record/u],
    ["missing semantic member", "ModelData", ["missing"], /references missing member/u],
    ["non-record semantic traversal", "ModelData", ["radius", "value"], /traverses a non-record member/u],
  ])("rejects a %s", async (_label, recordName, memberPath, error) => {
    const manifest = clone(await reflectedInterface());
    (manifest.modelAbi as Mutable<typeof manifest.modelAbi>).semantics = [
      ...manifest.modelAbi.semantics,
      { semantic: "model.extra", source: { kind: "record-member", recordName, memberPath } },
    ];
    expect(() => parseGpuInterfaceManifest(manifest)).toThrow(error);
  });

  it.each([
    ["missing binding module", (manifest: GpuInterfaceManifest) => {
      (manifest.bindings[0] as Mutable<typeof manifest.bindings[number]>).moduleId = "missing";
    }, /bindings\[0\].moduleId is missing/u],
    ["missing override module", (manifest: GpuInterfaceManifest) => {
      (manifest.overrides[0] as Mutable<typeof manifest.overrides[number]>).moduleId = "missing";
    }, /overrides\[0\].moduleId is missing/u],
    ["missing entry module", (manifest: GpuInterfaceManifest) => {
      (manifest.entryPoints[0] as Mutable<typeof manifest.entryPoints[number]>).moduleId = "missing";
    }, /entryPoints\[0\].moduleId is missing/u],
    ["no entry points", (manifest: GpuInterfaceManifest) => {
      (manifest as Mutable<typeof manifest>).entryPoints = [];
    }, /entryPoints must not be empty/u],
  ])("rejects an interface with %s", async (_label, mutate, error) => {
    const manifest = clone(await reflectedInterface());
    mutate(manifest);
    expect(() => parseGpuInterfaceManifest(manifest)).toThrow(error);
  });

  it("accepts a bounded interpolation token on reflected entry-point IO", async () => {
    const manifest = clone(await reflectedInterface());
    const input = manifest.entryPoints[0]!.inputs[0]!;
    (input as Mutable<typeof input>).interpolation = "flat";
    expect(parseGpuInterfaceManifest(manifest).entryPoints[0]!.inputs[0]!.interpolation).toBe("flat");
  });
});

describe("shader/profile manifest rejection boundaries", () => {
  it.each([
    ["unsupported shader version", (manifest: ShaderVersionManifest) => {
      (manifest as unknown as Record<string, unknown>).contractVersion = "2.0.0";
    }, /Unsupported shader manifest contract version/u],
    ["empty shader modules", (manifest: ShaderVersionManifest) => {
      (manifest as Mutable<typeof manifest>).modules = [];
    }, /modules must not be empty/u],
    ["empty shader pipelines", (manifest: ShaderVersionManifest) => {
      (manifest as Mutable<typeof manifest>).pipelines = [];
    }, /pipelines must not be empty/u],
    ["empty render roles", (manifest: ShaderVersionManifest) => {
      (manifest as Mutable<typeof manifest>).renderRoles = [];
    }, /renderRoles must not be empty/u],
    ["empty compatible interfaces", (manifest: ShaderVersionManifest) => {
      (manifest as Mutable<typeof manifest>).compatibleModelInterfaces = [];
    }, /compatibleModelInterfaces must not be empty/u],
    ["negative limit", (manifest: ShaderVersionManifest) => {
      const limit = manifest.requirements.limits[0]!;
      (limit as Mutable<typeof limit>).value = -1;
    }, /non-negative safe integer/u],
  ])("rejects %s", async (_label, mutate, error) => {
    const { shaderManifest } = await shaderAssets();
    const manifest = clone(shaderManifest);
    mutate(manifest);
    expect(() => parseShaderVersionManifest(manifest)).toThrow(error);
  });

  it("rejects profile contract/version and empty-role drift", async () => {
    const { profileManifest } = await shaderAssets();
    expect(() => parseShaderStyleProfileManifest({
      ...clone(profileManifest),
      contractVersion: "2.0.0",
    })).toThrow("Unsupported style-profile contract version");
    expect(() => parseShaderStyleProfileManifest({
      ...clone(profileManifest),
      roles: [],
    })).toThrow("roles must not be empty");
  });

  it.each([
    ["relative", "shader.wgsl", /absolute immutable asset URI/u],
    ["insecure", "http://assets.example.invalid/shader.wgsl", /credential-free HTTPS/u],
    ["credentialed", "https://user:secret@assets.example.invalid/shader.wgsl", /credential-free HTTPS/u],
    ["fragmented", "https://assets.example.invalid/shader.wgsl#module", /credential-free HTTPS/u],
  ])("rejects a %s immutable module URI", async (_label, uri, error) => {
    const { shaderManifest } = await shaderAssets();
    const manifest = clone(shaderManifest);
    (manifest.modules[0] as Mutable<typeof manifest.modules[number]>).uri = uri;
    expect(() => parseShaderVersionManifest(manifest)).toThrow(error);
  });
});

describe("WGSL-derived requirement validation", () => {
  it("infers every stable feature from comment-free comma-separated enable directives", () => {
    expect(inferWgslRequiredFeatures([
      `
        // enable unsupported_line;
        /* outer /* enable unsupported_nested; */ still comment */
        enable f16, clip_distances, dual_source_blending;
        enable subgroups, primitive_index, subgroup_size_control;
      `,
    ])).toEqual([
      "clip-distances",
      "dual-source-blending",
      "primitive-index",
      "shader-f16",
      "subgroup-size-control",
      "subgroups",
    ]);
  });

  it.each([
    ["unmapped feature", "enable future_extension;", /no stable WebGPU feature mapping/u],
    ["invalid comma list", "enable f16, -bad;", /malformed enable directive/u],
    ["unterminated directive", "enable f16", /unterminated or malformed enable directive/u],
    ["unterminated block comment", "/* enable f16;", /unterminated block comment/u],
  ])("rejects an %s", (_label, source, error) => {
    expect(() => inferWgslRequiredFeatures([source])).toThrow(error);
  });

  it("resolves compute workgroup overrides by name, numeric id and reflected default", async () => {
    const assets = await shaderAssets();
    const constantCases: readonly Readonly<Record<string, boolean | number>>[] = [
      { WORKGROUP_X: 3 },
      { 7: 4 },
      {},
    ];
    for (const constants of constantCases) {
      const manifest = withoutEvidence(clone(assets.shaderManifest));
      const pipeline = manifest.pipelines[0];
      if (pipeline?.kind !== "compute") throw new Error("Expected a compute fixture.");
      (pipeline.compute as Mutable<typeof pipeline.compute>).constants = constants;
      (manifest.requirements as Mutable<typeof manifest.requirements>).limits = manifest.requirements.limits.map(
        (limit) => limit.name === "maxComputeWorkgroupSizeX"
          ? { ...limit, value: 4 }
          : limit.name === "maxComputeInvocationsPerWorkgroup"
            ? { ...limit, value: 8 }
            : limit,
      );
      expect(() => validateShaderDerivedRequirements({
        manifest,
        gpuInterface: assets.gpuInterface,
        moduleSources: new Map([["compute", COMPUTE_WGSL]]),
      })).not.toThrow();
    }
  });

  it.each([
    ["module closure", (manifest: ShaderVersionManifestCore, gpuInterface: GpuInterfaceManifest, sources: Map<string, string>) => {
      sources.set("extra", "");
    }, /module set/u],
    ["WGSL feature", (manifest: ShaderVersionManifestCore, gpuInterface: GpuInterfaceManifest, sources: Map<string, string>) => {
      sources.set("compute", `enable subgroups;\n${COMPUTE_WGSL}`);
    }, /omit WGSL-derived feature subgroups/u],
    ["compute entry point", (manifest: ShaderVersionManifestCore) => {
      const pipeline = manifest.pipelines[0];
      if (pipeline?.kind !== "compute") throw new Error("Expected a compute fixture.");
      (pipeline.compute as Mutable<typeof pipeline.compute>).entryPoint = "missing";
    }, /lacks reflected compute entry point/u],
    ["reflected override", (manifest: ShaderVersionManifestCore, gpuInterface: GpuInterfaceManifest) => {
      (gpuInterface as Mutable<typeof gpuInterface>).overrides = [];
    }, /references missing override/u],
    ["positive override value", (manifest: ShaderVersionManifestCore) => {
      const pipeline = manifest.pipelines[0];
      if (pipeline?.kind !== "compute") throw new Error("Expected a compute fixture.");
      (pipeline.compute as Mutable<typeof pipeline.compute>).constants = { WORKGROUP_X: 0 };
    }, /must resolve to a positive integer/u],
    ["minimum limit", (manifest: ShaderVersionManifestCore) => {
      (manifest.requirements as Mutable<typeof manifest.requirements>).limits = manifest.requirements.limits.filter(
        (limit) => limit.name !== "maxComputeWorkgroupSizeY",
      );
    }, /maxComputeWorkgroupSizeY at least 2/u],
    ["workgroup storage limit", (_manifest: ShaderVersionManifestCore, gpuInterface: GpuInterfaceManifest) => {
      (gpuInterface.entryPoints[0] as Mutable<typeof gpuInterface.entryPoints[number]>).workgroupStorageSize = 64;
    }, /maxComputeWorkgroupStorageSize at least 64/u],
    ["reflected model semantic", (manifest: ShaderVersionManifestCore) => {
      (manifest.requirements as Mutable<typeof manifest.requirements>).semantics = [];
    }, /omit reflected model semantic model.data/u],
    ["reflected storage binding size", (manifest: ShaderVersionManifestCore) => {
      (manifest.requirements as Mutable<typeof manifest.requirements>).limits = manifest.requirements.limits.filter(
        (limit) => limit.name !== "maxStorageBufferBindingSize",
      );
    }, /maxStorageBufferBindingSize at least 112/u],
  ])("fails closed for an understated %s", async (_label, mutate, error) => {
    const assets = await shaderAssets();
    const manifest = withoutEvidence(clone(assets.shaderManifest));
    const gpuInterface = clone(assets.gpuInterface);
    const sources = new Map([["compute", COMPUTE_WGSL]]);
    mutate(manifest, gpuInterface, sources);

    expect(() => validateShaderDerivedRequirements({ manifest, gpuInterface, moduleSources: sources })).toThrow(error);
  });

  it("rejects a workgroup invocation product outside the safe manifest range", async () => {
    const assets = await shaderAssets();
    const gpuInterface = clone(assets.gpuInterface);
    const entry = gpuInterface.entryPoints[0]!;
    (entry as Mutable<typeof entry>).workgroupSize = [
      { kind: "literal", value: Number.MAX_SAFE_INTEGER },
      { kind: "literal", value: 2 },
      { kind: "literal", value: 1 },
    ];

    expect(() => validateShaderDerivedRequirements({
      manifest: withoutEvidence(clone(assets.shaderManifest)),
      gpuInterface,
      moduleSources: new Map([["compute", COMPUTE_WGSL]]),
    })).toThrow("workgroup invocation count is outside the safe manifest range");
  });
});
