import { canonicalizeGpuContract } from "../src/canonical-json.js";
import {
  SHADER_COMPILE_UNIT_VERSION,
  SHADER_QUALIFICATION_BUNDLE_VERSION,
  SHADER_QUALIFICATION_FIXTURE_VERSION,
  SHADER_STYLE_PROFILE_MANIFEST_VERSION,
  SHADER_VALIDATION_EVIDENCE_VERSION,
  SHADER_VERSION_MANIFEST_VERSION,
  SUPPORTED_STABLE_WEBGPU_MATRIX_POLICIES,
  type GpuInterfaceManifest,
  type GpuInterfaceRef,
  type GpuRecordLayout,
  type LoadedShaderStyleProfile,
  type ModelGpuCompatibilityDescriptor,
  type PromotedShaderCatalogResolver,
  type SerializableGpuComputePipelineDescriptor,
  type ShaderCellEvidence,
  type ShaderCompileUnitInventory,
  type ShaderQualificationBundleManifest,
  type ShaderQualificationFixtureManifest,
  type ShaderQualificationExecutionProducer,
  type ShaderQualificationResult,
  type ShaderRunnerCellPreflightEvidence,
  type ShaderStyleProfileManifest,
  type ShaderStyleProfileRef,
  type ShaderTrustedWorkflowProvenance,
  type ShaderVersionManifest,
  type ShaderVersionRef,
  type Sha256Hex,
  type StableWebGpuMatrixCell,
  type StableWebGpuMatrixManifest,
} from "../src/contracts.js";
import { computeGpuAbiHash, computeSha256 } from "../src/hash.js";
import { reflectGpuInterface } from "../src/node/reflect.js";
import { loadShaderStyleProfile } from "../src/runtime/catalog-loader.js";
import {
  createQualificationPreflight,
  type EvidenceArtifact,
} from "../src/testing/evidence.js";

export const ZERO_SHA = "0".repeat(64) as Sha256Hex;
export const ONE_SHA = "1".repeat(64) as Sha256Hex;
export const TWO_SHA = "2".repeat(64) as Sha256Hex;
export const AUTOMATION_SHA = "3".repeat(64) as Sha256Hex;
export const ZERO_MODEL_AFTER_DISPATCH_SHA = "e3ba189bffb7e2b32a521019ae4afee959c2fe86565caa06b787c7c83d78b108" as Sha256Hex;

export const COMPUTE_WGSL = `
struct Nested {
  axis: vec3f,
  weight: f32,
}

struct ModelData {
  transform: mat3x3f,
  samples: array<Nested, 2>,
  counter: atomic<u32>,
  @align(16) @size(16) radius: f32,
}

@group(0) @binding(0) var<storage, read_write> model: ModelData;
@id(7) override WORKGROUP_X: u32 = 1u;

@compute @workgroup_size(WORKGROUP_X, 2, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x == 0u) {
    atomicAdd(&model.counter, 1u);
  }
}
`.trim();

export function computePipeline(
  overrides: Readonly<Record<string, boolean | number>> = {},
): SerializableGpuComputePipelineDescriptor {
  return {
    kind: "compute",
    pipelineId: "model.compute",
    layout: {
      bindGroups: [{
        group: 0,
        entries: [{
          group: 0,
          binding: 0,
          resource: {
            kind: "buffer",
            addressSpace: "storage",
            access: "read_write",
            recordName: "ModelData",
            minimumBindingSize: 112,
          },
          visibility: ["compute"],
        }],
      }],
    },
    compute: { moduleId: "compute", entryPoint: "main", constants: overrides },
  };
}

let reflectedPromise: Promise<GpuInterfaceManifest> | undefined;

export async function reflectedInterface(): Promise<GpuInterfaceManifest> {
  reflectedPromise ??= reflectGpuInterface({
    interfaceId: "model.interface",
    interfaceVersion: "1.0.0",
    modules: [{ moduleId: "compute", source: COMPUTE_WGSL }],
    pipelines: [computePipeline()],
    modelFacingRecordNames: ["ModelData"],
    modelFacingBindings: [{ moduleId: "compute", group: 0, binding: 0, semantic: "model.data" }],
    semantics: [{
      semantic: "model.data",
      source: { kind: "binding", moduleId: "compute", group: 0, binding: 0 },
    }],
  });
  return reflectedPromise;
}

export function scalarRecord(): GpuRecordLayout {
  return {
    name: "ScalarRecord",
    alignment: 16,
    byteSize: 32,
    minimumByteSize: 32,
    runtimeArrayMember: null,
    addressSpaces: ["storage"],
    members: [
      {
        name: "position",
        offset: 0,
        alignment: 16,
        valueByteSize: 12,
        occupiedByteSize: 12,
        explicitAlign: null,
        explicitSize: null,
        type: { kind: "vector", scalar: "f32", width: 3, alignment: 16, byteSize: 12 },
      },
      {
        name: "tag",
        offset: 12,
        alignment: 4,
        valueByteSize: 4,
        occupiedByteSize: 4,
        explicitAlign: null,
        explicitSize: null,
        type: { kind: "scalar", scalar: "u32", alignment: 4, byteSize: 4 },
      },
      {
        name: "weight",
        offset: 16,
        alignment: 4,
        valueByteSize: 4,
        occupiedByteSize: 16,
        explicitAlign: null,
        explicitSize: 16,
        type: { kind: "scalar", scalar: "f32", alignment: 4, byteSize: 4 },
      },
    ],
  };
}

export function runtimeArrayRecord(): GpuRecordLayout {
  return {
    name: "RuntimeRecord",
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
}

export async function shaderAssets() {
  const gpuInterface = await reflectedInterface();
  const interfaceBytes = new TextEncoder().encode(canonicalizeGpuContract(gpuInterface));
  const interfaceManifestSha256 = await computeSha256(interfaceBytes);
  const interfaceRef: GpuInterfaceRef = {
    interfaceId: gpuInterface.interfaceId,
    interfaceVersion: gpuInterface.interfaceVersion,
    manifestUri: "https://assets.example.invalid/interfaces/model/1/manifest.json",
    manifestSha256: interfaceManifestSha256,
    interfaceAbiHash: gpuInterface.interfaceAbiHash,
    modelAbiHash: gpuInterface.modelAbiHash,
  };
  const moduleBytes = new TextEncoder().encode(COMPUTE_WGSL);
  const moduleSha256 = await computeSha256(moduleBytes);
  const pipeline = computePipeline();
  const requirements = {
    semantics: ["model.data"],
    features: ["shader-f16"],
    limits: [
      { name: "maxBindGroups", comparator: "at-least" as const, value: 1 },
      { name: "maxBindingsPerBindGroup", comparator: "at-least" as const, value: 1 },
      { name: "maxComputeWorkgroupSizeX", comparator: "at-least" as const, value: 1 },
      { name: "maxComputeWorkgroupSizeY", comparator: "at-least" as const, value: 2 },
      { name: "maxComputeWorkgroupSizeZ", comparator: "at-least" as const, value: 1 },
      { name: "maxComputeInvocationsPerWorkgroup", comparator: "at-least" as const, value: 2 },
      { name: "maxStorageBuffersPerShaderStage", comparator: "at-least" as const, value: 1 },
      { name: "maxStorageBufferBindingSize", comparator: "at-least" as const, value: 112 },
    ],
    formats: ["rgba8unorm"],
  };
  const shaderAbiHash = await computeGpuAbiHash({
    kind: "shader",
    interface: gpuInterface,
    pipelines: [pipeline],
    requirements,
  });
  const shaderManifest: ShaderVersionManifest = {
    contractVersion: SHADER_VERSION_MANIFEST_VERSION,
    shaderId: "shader.realistic",
    version: "1.0.0",
    modules: [{
      moduleId: "compute",
      uri: "https://assets.example.invalid/shaders/realistic/1/compute.wgsl",
      byteLength: moduleBytes.byteLength,
      sha256: moduleSha256,
      contentType: "text/wgsl; charset=utf-8",
    }],
    gpuInterface: interfaceRef,
    pipelines: [pipeline],
    renderRoles: [{ role: "material", pipelineIds: [pipeline.pipelineId] }],
    compatibleModelInterfaces: [{
      interfaceId: gpuInterface.interfaceId,
      interfaceVersion: gpuInterface.interfaceVersion,
      manifestSha256: interfaceManifestSha256,
      interfaceAbiHash: gpuInterface.interfaceAbiHash,
      modelAbiHash: gpuInterface.modelAbiHash,
    }],
    requirements,
    shaderAbiHash,
    validationEvidence: {
      evidenceId: "qualification-test",
      uri: "https://assets.example.invalid/evidence/qualification-test.json",
      sha256: TWO_SHA,
      matrixId: "stable-webgpu",
      matrixVersion: "2026-07-13",
      matrixSha256: SUPPORTED_STABLE_WEBGPU_MATRIX_POLICIES[0].matrixSha256 as Sha256Hex,
      attestationRef: {
        uri: "https://assets.example.invalid/evidence/qualification-test.attestation-ref.json",
        sha256: ONE_SHA,
      },
    },
    additionalValidationEvidence: [],
  };
  const shaderBytes = new TextEncoder().encode(canonicalizeGpuContract(shaderManifest));
  const shaderRef: ShaderVersionRef = {
    shaderId: shaderManifest.shaderId,
    version: shaderManifest.version,
    manifestUri: "https://assets.example.invalid/shaders/realistic/1/manifest.json",
    manifestSha256: await computeSha256(shaderBytes),
  };
  const profileManifest: ShaderStyleProfileManifest = {
    contractVersion: SHADER_STYLE_PROFILE_MANIFEST_VERSION,
    profileId: "style.realistic",
    version: "1.0.0",
    style: "realistic",
    roles: [{ role: "material", shader: shaderRef }],
    compatibleModelInterfaces: [...shaderManifest.compatibleModelInterfaces],
    requiredSemantics: ["model.data"],
    requiredValidationScopes: [],
  };
  const profileBytes = new TextEncoder().encode(canonicalizeGpuContract(profileManifest));
  const profileRef: ShaderStyleProfileRef = {
    profileId: profileManifest.profileId,
    version: profileManifest.version,
    manifestUri: "https://assets.example.invalid/profiles/realistic/1/manifest.json",
    manifestSha256: await computeSha256(profileBytes),
  };
  const model: ModelGpuCompatibilityDescriptor = {
    modelId: "model.fixture",
    version: "1.0.0",
    gpuInterface: interfaceRef,
    modelAbiHash: gpuInterface.modelAbiHash,
    providedSemantics: ["model.data"],
    defaultStyleProfile: profileRef,
  };
  return {
    gpuInterface,
    interfaceBytes,
    interfaceRef,
    moduleBytes,
    moduleSha256,
    shaderManifest,
    shaderBytes,
    shaderRef,
    profileManifest,
    profileBytes,
    profileRef,
    model,
  };
}

export async function promotedCatalog(
  overrides: Partial<PromotedShaderCatalogResolver> = {},
): Promise<PromotedShaderCatalogResolver> {
  const assets = await shaderAssets();
  return {
    isCatalogAssetUri: (uri) => uri.startsWith("https://assets.example.invalid/"),
    loadProfile: async () => ({ bytes: assets.profileBytes, promoted: true }),
    loadShader: async () => ({ bytes: assets.shaderBytes, promoted: true }),
    loadInterface: async () => ({ bytes: assets.interfaceBytes, promoted: true }),
    loadModule: async () => ({ bytes: assets.moduleBytes, promoted: true }),
    ...overrides,
  };
}

export async function loadedStyleProfile(): Promise<LoadedShaderStyleProfile> {
  const assets = await shaderAssets();
  const result = await loadShaderStyleProfile({
    ref: assets.profileRef,
    catalog: await promotedCatalog(),
  });
  if (!result.ok) throw new TypeError(result.diagnostics.map((item) => item.message).join("; "));
  return result.value;
}

export function mutableLoadedStyleProfile(value: LoadedShaderStyleProfile): LoadedShaderStyleProfile {
  return {
    ref: clone(value.ref),
    manifest: clone(value.manifest),
    shaders: new Map([...value.shaders].map(([role, shader]) => [role, {
      ref: clone(shader.ref),
      manifest: clone(shader.manifest),
      gpuInterface: clone(shader.gpuInterface),
      modules: new Map([...shader.modules].map(([moduleId, bytes]) => [moduleId, new Uint8Array(bytes)])),
    }])),
  };
}

export function validInventory(): ShaderCompileUnitInventory {
  return {
    contractVersion: SHADER_COMPILE_UNIT_VERSION,
    fragments: [{ fragmentId: "fragment.main", path: "wgsl/main.wgsl", sha256: ZERO_SHA }],
    compileUnits: [{
      contractVersion: SHADER_COMPILE_UNIT_VERSION,
      compileUnitId: "unit.main",
      fragmentIds: ["fragment.main"],
      modules: [{
        moduleId: "compute",
        sha256: ZERO_SHA,
        assembly: { kind: "concat-v1", fragmentIds: ["fragment.main"] },
      }],
      entryPoints: [{ moduleId: "compute", name: "main", stage: "compute" }],
      pipelines: [computePipeline()],
      interfaceRef: {
        interfaceId: "model.interface",
        interfaceVersion: "1.0.0",
        manifestUri: "https://account.blob.core.windows.net/assets/interface.json?versionid=one",
        manifestSha256: ZERO_SHA,
        interfaceAbiHash: ZERO_SHA,
        modelAbiHash: ZERO_SHA,
      },
      overrideValues: {},
      qualificationFixture: { fixtureId: "fixture.main", path: "fixtures/main.json", sha256: ONE_SHA },
    }],
  };
}

export function validVertexInventory(): ShaderCompileUnitInventory {
  return {
    contractVersion: SHADER_COMPILE_UNIT_VERSION,
    fragments: [{ fragmentId: "fragment.vertex", path: "wgsl/vertex.wgsl", sha256: ZERO_SHA }],
    compileUnits: [{
      contractVersion: SHADER_COMPILE_UNIT_VERSION,
      compileUnitId: "unit.vertex",
      fragmentIds: ["fragment.vertex"],
      modules: [{
        moduleId: "vertex",
        sha256: ZERO_SHA,
        assembly: { kind: "concat-v1", fragmentIds: ["fragment.vertex"] },
      }],
      entryPoints: [{ moduleId: "vertex", name: "vertexMain", stage: "vertex" }],
      pipelines: [{
        kind: "render",
        pipelineId: "model.vertex",
        layout: { bindGroups: [] },
        vertex: { moduleId: "vertex", entryPoint: "vertexMain", constants: {} },
        fragment: null,
        vertexBuffers: [{
          arrayStride: 16,
          stepMode: "vertex",
          attributes: [{
            format: "float32x4",
            offset: 0,
            shaderLocation: 0,
            semantic: "model.position",
          }],
        }],
        primitive: {
          topology: "triangle-list",
          stripIndexFormat: null,
          frontFace: "ccw",
          cullMode: "none",
          unclippedDepth: false,
        },
        colorTargets: [],
        depthStencil: null,
        multisample: { count: 1, mask: 0xffff_ffff, alphaToCoverageEnabled: false },
      }],
      interfaceRef: {
        interfaceId: "model.vertex.interface",
        interfaceVersion: "1.0.0",
        manifestUri: "https://account.blob.core.windows.net/assets/vertex-interface.json?versionid=one",
        manifestSha256: ZERO_SHA,
        interfaceAbiHash: ZERO_SHA,
        modelAbiHash: ZERO_SHA,
      },
      overrideValues: {},
      qualificationFixture: {
        fixtureId: "fixture.vertex",
        path: "fixtures/vertex.json",
        sha256: ONE_SHA,
      },
    }],
  };
}

export function validVertexQualificationFixture(): ShaderQualificationFixtureManifest {
  return {
    contractVersion: SHADER_QUALIFICATION_FIXTURE_VERSION,
    fixtureId: "fixture.vertex",
    resources: [
      {
        kind: "buffer",
        resourceId: "vertices",
        byteLength: 16,
        usage: ["vertex"],
        initialData: { path: "data/vertex.bin", sha256: ZERO_SHA },
      },
      {
        kind: "buffer",
        resourceId: "readback",
        byteLength: 16,
        usage: ["map-read"],
        initialData: null,
      },
    ],
    bindGroups: [],
    commands: [{
      kind: "draw",
      pipelineId: "model.vertex",
      bindGroupIds: [],
      vertexBuffers: [{ slot: 0, resourceId: "vertices", offset: 0, size: 16 }],
      colorAttachments: [],
      depthStencilAttachment: null,
      vertexCount: 1,
      instanceCount: 1,
      firstVertex: 0,
      firstInstance: 0,
    }],
    layoutProbes: [{
      kind: "vertex-input",
      probeId: "probe.model-position",
      source: {
        pipelineId: "model.vertex",
        shaderLocation: 0,
        semantic: "model.position",
      },
      commandIndex: 0,
      input: {
        resourceId: "vertices",
        vertexBufferSlot: 0,
        elementIndex: 0,
        value: [1, 2, 3, 1],
      },
      output: {
        readbackIndex: 0,
        recordName: "VertexReadback",
        expectedValue: { value: [1, 2, 3, 1] },
      },
    }],
    readbacks: [{
      resourceId: "readback",
      byteOffset: 0,
      byteLength: 16,
      expectedSha256: ZERO_SHA,
    }],
    bounds: { maxBufferBytes: 32, maxTextureTexels: 1, maxCommands: 1, timeoutMs: 10_000 },
  };
}

export function validQualificationFixture(): ShaderQualificationFixtureManifest {
  return {
    contractVersion: SHADER_QUALIFICATION_FIXTURE_VERSION,
    fixtureId: "fixture.main",
    resources: [
      {
        kind: "buffer",
        resourceId: "model",
        byteLength: 112,
        usage: ["storage", "copy-src"],
        initialData: { path: "data/model.bin", sha256: ZERO_SHA },
      },
      {
        kind: "buffer",
        resourceId: "readback",
        byteLength: 112,
        usage: ["copy-dst", "map-read"],
        initialData: null,
      },
    ],
    bindGroups: [{
      bindGroupId: "group.0",
      group: 0,
      entries: [{
        binding: 0,
        resource: { kind: "buffer", resourceId: "model", offset: 0, size: 112 },
      }],
    }],
    commands: [
      { kind: "dispatch", pipelineId: "model.compute", bindGroupIds: ["group.0"], workgroups: [1, 1, 1] },
      { kind: "copy-buffer", source: "model", destination: "readback", byteLength: 112 },
    ],
    layoutProbes: [{
      kind: "buffer-record",
      probeId: "probe.model-data",
      source: { moduleId: "compute", group: 0, binding: 0, recordName: "ModelData" },
      pipelineId: "model.compute",
      commandIndex: 0,
      input: {
        resourceId: "model",
        byteOffset: 0,
        byteLength: 112,
        value: {
          transform: [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
          samples: [
            { axis: [0, 0, 0], weight: 0 },
            { axis: [0, 0, 0], weight: 0 },
          ],
          counter: 0,
          radius: 0,
        },
      },
      output: {
        readbackIndex: 0,
        recordName: "ModelData",
        expectedValue: {
          transform: [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
          samples: [
            { axis: [0, 0, 0], weight: 0 },
            { axis: [0, 0, 0], weight: 0 },
          ],
          counter: 2,
          radius: 0,
        },
      },
    }],
    readbacks: [{ resourceId: "readback", byteOffset: 0, byteLength: 112, expectedSha256: ZERO_MODEL_AFTER_DISPATCH_SHA }],
    bounds: { maxBufferBytes: 224, maxTextureTexels: 1, maxCommands: 2, timeoutMs: 10_000 },
  };
}

export async function qualificationBundle(matrix: StableWebGpuMatrixManifest): Promise<ShaderQualificationBundleManifest> {
  const inventory = validInventory();
  const inventorySha = await computeSha256(canonicalizeGpuContract(inventory));
  return {
    contractVersion: SHADER_QUALIFICATION_BUNDLE_VERSION,
    inventory,
    subject: {
      shaderManifestCore: { shaderId: "shader.realistic", version: "1.0.0", sha256: ZERO_SHA },
      compileUnitInventorySha256: inventorySha,
      shaderAbiHash: ONE_SHA,
      interfaceManifestSha256: TWO_SHA,
      modelAbiHashes: [ZERO_SHA],
      modules: [{ moduleId: "compute", sha256: ZERO_SHA }],
      requiredCompileUnitIds: ["unit.main"],
      requiredCellIds: matrix.cells.map((cell) => cell.cellId),
    },
    shaderManifestCorePath: "manifests/shader-core.json",
    gpuInterfaceManifest: { path: "manifests/interface.json", sha256: TWO_SHA },
    modelCompatibilityFixtures: [{
      fixtureId: "model.fixture",
      path: "fixtures/model-compatibility.json",
      sha256: TWO_SHA,
    }],
    modules: [{ moduleId: "compute", path: "wgsl/main.wgsl", sha256: ZERO_SHA }],
    fixtures: [{ fixtureId: "fixture.main", path: "fixtures/main.json", sha256: ONE_SHA, kind: "qualification-fixture" }],
  };
}

export function provenance(): ShaderTrustedWorkflowProvenance {
  return {
    repository: "Plasius-LTD/gpu-shader",
    commit: { algorithm: "sha1", hex: "a".repeat(40) },
    ref: "refs/heads/main",
    workflowRef: "Plasius-LTD/gpu-shader/.github/workflows/shader-qualification.yml@refs/heads/main",
    workflowSha: { algorithm: "sha1", hex: "b".repeat(40) },
    runId: "12345",
    runAttempt: 1,
    job: "prepare",
    eventName: "workflow_dispatch",
    oidcAttestation: {
      issuer: "https://token.actions.githubusercontent.com",
      subject: "repo:Plasius-LTD/gpu-shader:ref:refs/heads/main",
      audience: "api://AzureADTokenExchange",
      verifiedClaimsSha256: TWO_SHA,
      verifiedAt: "2026-07-13T12:00:00.000Z",
      source: "trusted-runner-preflight",
    },
  };
}

export function executionProducer(
  cell: StableWebGpuMatrixCell,
  job: ShaderQualificationExecutionProducer["job"] = cell.adapter.kind === "software" ? "swiftshader" : "physical",
): ShaderQualificationExecutionProducer {
  const orchestrator = job === "physical-runner-preflight";
  const deviceController = cell.runnerLabels.includes("device-controller");
  const controllerOs = cell.runnerLabels.includes("macOS") ? "macos" : "ubuntu";
  const controllerArchitecture = cell.runnerLabels.includes("ARM64") ? "arm64" : "x64";
  return {
    repository: "Plasius-LTD/gpu-shader",
    commit: { algorithm: "sha1", hex: "a".repeat(40) },
    ref: "refs/heads/main",
    runId: "12345",
    runAttempt: 1,
    job,
    trustedWorkflowRepository: "Plasius-LTD/gpu-shader",
    trustedWorkflowRef: "Plasius-LTD/gpu-shader/.github/workflows/shader-qualification.yml@refs/heads/main",
    trustedWorkflowSha: { algorithm: "sha1", hex: "b".repeat(40) },
    runner: {
      name: orchestrator ? `controller-${cell.cellId}` : `runner-${cell.cellId}`,
      environment: orchestrator || cell.adapter.kind === "software" ? "github-hosted" : "self-hosted",
      os: orchestrator || deviceController ? controllerOs : cell.os.name,
      architecture: orchestrator || deviceController ? controllerArchitecture : cell.os.architecture,
    },
  };
}

/** Actual runner API labels may be a strict superset of the requested routing labels. */
export function actualRunnerLabels(cell: StableWebGpuMatrixCell): readonly string[] {
  return [...cell.runnerLabels, "fleet-observed"];
}

export function observedOsVersion(cell: StableWebGpuMatrixCell): string {
  const requirement = cell.os.versionRequirement;
  if (requirement.kind === "exact") return requirement.value;
  if (requirement.kind === "stable-channel") return "16093.59.0";
  if (cell.os.name === "windows") return `${requirement.value}.0.26100`;
  return `${requirement.value}.1`;
}

export function passingResult(
  unitId: string,
  cell: StableWebGpuMatrixCell,
  runnerLabels: readonly string[] = actualRunnerLabels(cell),
): ShaderQualificationResult {
  const phaseDigest = ZERO_SHA;
  const passed = (name: "assembly" | "reflection-schema" | "pipeline-layout" | "pipeline-creation" | "bind-group-creation" | "cpu-to-gpu-layout" | "gpu-to-cpu-layout" | "bounded-execution") => ({
    name,
    status: "passed" as const,
    durationMs: 1,
    evidenceSha256: phaseDigest,
  });
  return {
    compileUnitId: unitId,
    cellId: cell.cellId,
    status: "passed",
    startedAt: "2026-07-13T12:01:00.000Z",
    completedAt: "2026-07-13T12:01:01.000Z",
    observed: {
      runner: { id: `runner-${cell.cellId}`, labels: runnerLabels },
      os: {
        name: cell.os.name,
        version: observedOsVersion(cell),
        channel: cell.os.versionRequirement.kind === "stable-channel" ? cell.os.versionRequirement.channel : null,
        architecture: cell.os.architecture,
      },
      browser: { name: cell.browser.name, version: "stable-1", channel: cell.browser.channel },
      adapter: {
        physical: cell.adapter.kind === "physical",
        vendor: cell.adapter.vendor,
        family: cell.adapter.family,
        architecture: cell.adapter.family,
        device: cell.adapter.family,
        description: `${cell.adapter.vendor} ${cell.adapter.family}`,
        backend: cell.adapter.backend,
        driver: "qualified-driver-1",
      },
      features: [],
      limits: { maxStorageBuffersPerShaderStage: 8, maxStorageBufferBindingSize: 134_217_728 },
    },
    phases: [
      passed("assembly"),
      passed("reflection-schema"),
      { name: "shader-compilation", status: "passed", durationMs: 1, compilationMessagesSha256: phaseDigest, errorCount: 0 },
      passed("pipeline-layout"),
      passed("pipeline-creation"),
      passed("bind-group-creation"),
      passed("cpu-to-gpu-layout"),
      passed("gpu-to-cpu-layout"),
      passed("bounded-execution"),
      { name: "semantic-readback", status: "passed", durationMs: 1, expectedSha256: phaseDigest, actualSha256: phaseDigest },
    ],
    diagnostics: [],
  };
}

export async function evidenceScenario(matrix: StableWebGpuMatrixManifest, matrixBytes: Uint8Array) {
  const bundle = await qualificationBundle(matrix);
  const matrixSha = await computeSha256(matrixBytes);
  const harness = { id: "trusted-harness", version: "1.0.0", sha256: ONE_SHA };
  const preflight = await createQualificationPreflight({
    qualificationId: "qualification.test",
    bundle,
    matrix,
    matrixBytes,
    sourceUri: "https://account.blob.core.windows.net/candidates/candidate.tar?versionid=immutable-one",
    dataBundleSha256: TWO_SHA,
    matrixSha256: matrixSha,
    harnessSha256: harness.sha256,
    provenance: provenance(),
  });
  const runnerPreflights: EvidenceArtifact<ShaderRunnerCellPreflightEvidence>[] = [];
  const cellEvidence: EvidenceArtifact<ShaderCellEvidence>[] = [];
  for (const cell of matrix.cells) {
    const runnerLabels = actualRunnerLabels(cell);
    runnerPreflights.push(await artifact({
      contractVersion: SHADER_VALIDATION_EVIDENCE_VERSION,
      kind: "shader-runner-cell-preflight-evidence",
      qualificationId: preflight.qualificationId,
      cellId: cell.cellId,
      status: "available",
      matrixSha256: preflight.matrixSha256,
      runnerLabels: cell.runnerLabels,
      matchedRunners: [{ name: `runner-${cell.cellId}`, labels: runnerLabels }],
      adapterHarness: cell.adapter.kind === "software"
        ? { id: "trusted-driver", version: "1.0.0", sha256: AUTOMATION_SHA }
        : null,
      qualificationPreflightProvenance: preflight.provenance,
      producer: executionProducer(
        cell,
        cell.adapter.kind === "software" ? "swiftshader" : "physical-runner-preflight",
      ),
    }));
    cellEvidence.push(await artifact({
      contractVersion: SHADER_VALIDATION_EVIDENCE_VERSION,
      qualificationId: preflight.qualificationId,
      matrixId: matrix.matrixId,
      matrixVersion: matrix.version,
      matrixSha256: preflight.matrixSha256,
      cellId: cell.cellId,
      dataBundleSha256: preflight.dataBundleSha256,
      compileUnitInventorySha256: preflight.compileUnitInventorySha256,
      harness,
      automation: {
        kind: cell.automation.kind,
        driver: "trusted-driver",
        version: "1.0.0",
        sha256: AUTOMATION_SHA,
      },
      subjectBindingSha256: preflight.subjectBindingSha256,
      qualificationPreflightProvenance: preflight.provenance,
      producer: executionProducer(cell),
      results: [passingResult("unit.main", cell, runnerLabels)],
    }));
  }
  return {
    bundle,
    matrixSha,
    harness,
    preflight,
    preflightArtifact: await artifact(preflight),
    runnerPreflights,
    cellEvidence,
  };
}

export async function artifact<T>(value: T): Promise<EvidenceArtifact<T>> {
  const bytes = new TextEncoder().encode(canonicalizeGpuContract(value));
  return {
    value,
    bytes,
    sha256: await computeSha256(bytes),
  };
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export type DeepMutable<T> = T extends string | number | boolean | bigint | symbol | null | undefined
  ? T
  : T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? DeepMutable<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
      : T;

export function mutableClone<T>(value: T): DeepMutable<T> {
  return structuredClone(value) as DeepMutable<T>;
}
