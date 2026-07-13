/** Contract version shared by the first reflection-first manifest family. */
export const GPU_INTERFACE_MANIFEST_VERSION = "1.0.0" as const;
export const SHADER_VERSION_MANIFEST_VERSION = "1.0.0" as const;
export const SHADER_STYLE_PROFILE_MANIFEST_VERSION = "1.0.0" as const;
export const SHADER_COMPILE_UNIT_VERSION = "1.0.0" as const;
export const SHADER_VALIDATION_EVIDENCE_VERSION = "1.0.0" as const;
export const STABLE_WEBGPU_MATRIX_VERSION = "1.0.0" as const;
export const SHADER_QUALIFICATION_FIXTURE_VERSION = "1.0.0" as const;
export const SHADER_QUALIFICATION_BUNDLE_VERSION = "1.0.0" as const;
/** Remotely controlled rollout gate owned by the asset service. */
export const GPU_SHADER_STORE_FEATURE_FLAG = "asset.pipeline.shader-store.enabled" as const;
/** User-visible style discovery/selection entitlement owned by the capability service. */
export const GPU_SHADER_STYLE_SELECTION_CAPABILITY = "gpu.shader.style.select" as const;

/** Lowercase hexadecimal SHA-256 value. Runtime parsers enforce its shape. */
export type Sha256Hex = string & { readonly __sha256Hex: unique symbol };

/** Stable universal policies accepted by this contract implementation. */
export const SUPPORTED_STABLE_WEBGPU_MATRIX_POLICIES = [
  Object.freeze({
    matrixId: "stable-webgpu",
    matrixVersion: "2026-07-13",
    matrixSha256: "4620eca44fd03004ee7650cfe9fcf42934493611a5097da5525f71578980b016",
  }),
] as const satisfies readonly {
  readonly matrixId: string;
  readonly matrixVersion: string;
  readonly matrixSha256: string;
}[];
Object.freeze(SUPPORTED_STABLE_WEBGPU_MATRIX_POLICIES);

/**
 * Exact additive policies accepted by this release. Empty means supplemental
 * qualification fails closed until reviewed policy bytes and lanes are added.
 */
export const SUPPORTED_ADDITIVE_WEBGPU_MATRIX_POLICIES: readonly Readonly<{
  scope: string;
  matrixId: string;
  matrixVersion: string;
  matrixSha256: string;
}>[] = Object.freeze([]);

export interface GitObjectId {
  readonly algorithm: "sha1" | "sha256";
  readonly hex: string;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type ShaderDiagnosticSeverity = "error" | "warning" | "info";
export type ShaderDiagnosticCode =
  | "invalid-contract"
  | "digest-mismatch"
  | "model-abi-mismatch"
  | "interface-abi-mismatch"
  | "shader-abi-mismatch"
  | "incompatible-model-interface"
  | "missing-semantic"
  | "missing-feature"
  | "limit-not-met"
  | "unsupported-format"
  | "unpromoted-asset"
  | "compilation-error"
  | "pipeline-error"
  | "device-lost"
  | "activation-error"
  | "stale-evidence"
  | "incomplete-matrix"
  | "uncovered-fragment"
  | "timeout"
  | "runner-unavailable"
  | "adapter-unavailable";

export interface ShaderDiagnostic {
  readonly code: ShaderDiagnosticCode;
  readonly severity: ShaderDiagnosticSeverity;
  readonly message: string;
  readonly path?: string;
  readonly expected?: JsonValue;
  readonly actual?: JsonValue;
}

export type ShaderResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly diagnostics: readonly ShaderDiagnostic[] };

export type GpuScalarKind = "i32" | "u32" | "f32" | "f16" | "bool";
export type GpuHostAddressSpace = "uniform" | "storage";
export type GpuAddressSpace =
  | GpuHostAddressSpace
  | "function"
  | "private"
  | "workgroup";

export interface GpuScalarLayout {
  readonly kind: "scalar";
  readonly scalar: GpuScalarKind;
  readonly alignment: number;
  readonly byteSize: number;
}

export interface GpuAtomicLayout {
  readonly kind: "atomic";
  readonly scalar: "i32" | "u32";
  readonly alignment: number;
  readonly byteSize: number;
}

export interface GpuVectorLayout {
  readonly kind: "vector";
  readonly scalar: GpuScalarKind;
  readonly width: 2 | 3 | 4;
  readonly alignment: number;
  readonly byteSize: number;
}

export interface GpuMatrixLayout {
  readonly kind: "matrix";
  readonly scalar: "f32" | "f16";
  readonly columns: 2 | 3 | 4;
  readonly rows: 2 | 3 | 4;
  readonly columnStride: number;
  readonly alignment: number;
  readonly byteSize: number;
}

export interface GpuArrayLayout {
  readonly kind: "array";
  readonly element: GpuTypeLayout;
  /** Null represents a WGSL runtime-sized array. */
  readonly count: number | null;
  readonly stride: number;
  readonly alignment: number;
  readonly byteSize: number | null;
}

export interface GpuRecordReferenceLayout {
  readonly kind: "record";
  readonly recordName: string;
  readonly alignment: number;
  readonly byteSize: number | null;
}

export type GpuTypeLayout =
  | GpuScalarLayout
  | GpuAtomicLayout
  | GpuVectorLayout
  | GpuMatrixLayout
  | GpuArrayLayout
  | GpuRecordReferenceLayout;

export interface GpuRecordMemberLayout {
  readonly name: string;
  readonly offset: number;
  /** Effective alignment after applying an optional WGSL `@align`. */
  readonly alignment: number;
  /** Logical size of the value, excluding a member-level `@size`. */
  readonly valueByteSize: number | null;
  /** Occupied member span, including a member-level `@size`. */
  readonly occupiedByteSize: number | null;
  readonly explicitAlign: number | null;
  readonly explicitSize: number | null;
  readonly type: GpuTypeLayout;
}

export interface GpuRecordLayout {
  readonly name: string;
  readonly alignment: number;
  /** Null for records ending in a runtime-sized array. */
  readonly byteSize: number | null;
  /** Fixed prefix before any runtime-sized array. */
  readonly minimumByteSize: number;
  readonly runtimeArrayMember: string | null;
  readonly addressSpaces: readonly GpuAddressSpace[];
  /** WGSL declaration order; constructor and codec order depend on it. */
  readonly members: readonly GpuRecordMemberLayout[];
}

export type GpuShaderStage = "vertex" | "fragment" | "compute";
export type GpuBindingAccess = "read" | "write" | "read_write";

export type GpuBindingResourceLayout =
  | {
      readonly kind: "buffer";
      readonly addressSpace: GpuHostAddressSpace;
      readonly access: GpuBindingAccess;
      readonly recordName: string | null;
      readonly minimumBindingSize: number;
    }
  | {
      readonly kind: "sampler";
      readonly samplerType: "filtering" | "non-filtering" | "comparison";
    }
  | {
      readonly kind: "texture";
      readonly sampleType: "float" | "unfilterable-float" | "depth" | "sint" | "uint";
      readonly viewDimension: "1d" | "2d" | "2d-array" | "cube" | "cube-array" | "3d";
      readonly multisampled: boolean;
    }
  | {
      readonly kind: "storage-texture";
      readonly access: "write-only" | "read-only" | "read-write";
      readonly format: string;
      readonly viewDimension: "1d" | "2d" | "2d-array" | "3d";
    }
  | { readonly kind: "external-texture" };

export interface GpuBindingLayout {
  readonly moduleId: string;
  readonly variableName: string;
  readonly group: number;
  readonly binding: number;
  readonly resource: GpuBindingResourceLayout;
  readonly visibility: readonly GpuShaderStage[];
}

export interface GpuEntryPointIo {
  readonly name: string;
  readonly locationKind: "location" | "builtin";
  readonly location: number | string;
  readonly interpolation: string | null;
  readonly type: GpuTypeLayout;
}

export type GpuWorkgroupDimension =
  | { readonly kind: "literal"; readonly value: number }
  | { readonly kind: "override"; readonly name: string };

export interface GpuEntryPointInterface {
  readonly moduleId: string;
  readonly name: string;
  readonly stage: GpuShaderStage;
  readonly inputs: readonly GpuEntryPointIo[];
  readonly outputs: readonly GpuEntryPointIo[];
  readonly bindingKeys: readonly string[];
  readonly overrideNames: readonly string[];
  readonly workgroupSize: readonly [
    GpuWorkgroupDimension,
    GpuWorkgroupDimension,
    GpuWorkgroupDimension,
  ] | null;
  /**
   * WebGPU workgroup-storage bytes statically used by a compute entry point.
   * This is null for non-compute entry points.
   */
  readonly workgroupStorageSize: number | null;
}

export interface GpuVertexInputLayout {
  readonly pipelineId: string;
  readonly moduleId: string;
  readonly entryPoint: string;
  readonly shaderLocation: number;
  readonly shaderType: GpuTypeLayout;
  readonly bufferSlot: number;
  readonly format: string;
  readonly offset: number;
  readonly arrayStride: number;
  readonly stepMode: "vertex" | "instance";
  readonly semantic: string | null;
}

/** Shader-independent vertex bytes consumed from a model buffer. */
export interface GpuModelVertexInputLayout {
  readonly source: {
    readonly pipelineId: string;
    readonly shaderLocation: number;
  };
  readonly format: string;
  readonly offset: number;
  readonly arrayStride: number;
  readonly stepMode: "vertex" | "instance";
  readonly semantic: string;
}

/** A reflected model-facing resource projection; shader coordinates and visibility are excluded. */
export interface GpuModelBindingLayout {
  readonly source: {
    readonly moduleId: string;
    readonly group: number;
    readonly binding: number;
  };
  readonly resource: GpuBindingResourceLayout;
  readonly semantic: string | null;
}

export interface GpuOverrideLayout {
  readonly moduleId: string;
  readonly name: string;
  readonly id: number | null;
  readonly type: "bool" | "i32" | "u32" | "f32" | "f16";
  readonly defaultValue: boolean | number | null;
}

export type GpuSemanticSource =
  | {
      readonly kind: "record-member";
      readonly recordName: string;
      readonly memberPath: readonly string[];
    }
  | {
      readonly kind: "vertex-attribute";
      readonly pipelineId: string;
      readonly shaderLocation: number;
    }
  | {
      readonly kind: "binding";
      readonly moduleId: string;
      readonly group: number;
      readonly binding: number;
    };

export interface GpuSemanticProjection {
  readonly semantic: string;
  readonly source: GpuSemanticSource;
}

export interface GpuModelAbiProjection {
  readonly recordNames: readonly string[];
  readonly bindings: readonly GpuModelBindingLayout[];
  readonly vertexInputs: readonly GpuModelVertexInputLayout[];
  readonly semantics: readonly GpuSemanticProjection[];
}

export interface GpuInterfaceManifest {
  readonly contractVersion: typeof GPU_INTERFACE_MANIFEST_VERSION;
  readonly interfaceId: string;
  readonly interfaceVersion: string;
  readonly modules: readonly {
    readonly moduleId: string;
    readonly sha256: Sha256Hex;
  }[];
  readonly records: readonly GpuRecordLayout[];
  readonly bindings: readonly GpuBindingLayout[];
  readonly entryPoints: readonly GpuEntryPointInterface[];
  readonly vertexInputs: readonly GpuVertexInputLayout[];
  readonly overrides: readonly GpuOverrideLayout[];
  readonly modelAbi: GpuModelAbiProjection;
  readonly modelAbiHash: Sha256Hex;
  readonly interfaceAbiHash: Sha256Hex;
  readonly generatedBy: {
    readonly packageVersion: string;
    readonly reflector: "wgsl_reflect";
    readonly reflectorVersion: "1.5.0";
  };
}

export interface GpuInterfaceRef {
  readonly interfaceId: string;
  readonly interfaceVersion: string;
  readonly manifestUri: string;
  readonly manifestSha256: Sha256Hex;
  readonly interfaceAbiHash: Sha256Hex;
  readonly modelAbiHash: Sha256Hex;
}

export interface ShaderVersionRef {
  readonly shaderId: string;
  readonly version: string;
  readonly manifestUri: string;
  readonly manifestSha256: Sha256Hex;
}

export interface ShaderStyleProfileRef {
  readonly profileId: string;
  readonly version: string;
  readonly manifestUri: string;
  readonly manifestSha256: Sha256Hex;
}

export interface SerializableGpuProgrammableStage {
  readonly moduleId: string;
  readonly entryPoint: string;
  readonly constants: Readonly<Record<string, boolean | number>>;
}

export interface SerializableGpuBindGroupLayout {
  readonly group: number;
  readonly entries: readonly Omit<GpuBindingLayout, "moduleId" | "variableName">[];
}

export interface SerializableGpuPipelineLayout {
  readonly bindGroups: readonly SerializableGpuBindGroupLayout[];
}

export interface SerializableGpuComputePipelineDescriptor {
  readonly kind: "compute";
  readonly pipelineId: string;
  readonly layout: SerializableGpuPipelineLayout;
  readonly compute: SerializableGpuProgrammableStage;
}

export interface SerializableGpuRenderPipelineDescriptor {
  readonly kind: "render";
  readonly pipelineId: string;
  readonly layout: SerializableGpuPipelineLayout;
  readonly vertex: SerializableGpuProgrammableStage;
  readonly fragment: SerializableGpuProgrammableStage | null;
  readonly vertexBuffers: readonly {
    readonly arrayStride: number;
    readonly stepMode: "vertex" | "instance";
    readonly attributes: readonly {
      readonly format: string;
      readonly offset: number;
      readonly shaderLocation: number;
      readonly semantic: string | null;
    }[];
  }[];
  readonly primitive: {
    readonly topology: "point-list" | "line-list" | "line-strip" | "triangle-list" | "triangle-strip";
    readonly stripIndexFormat: "uint16" | "uint32" | null;
    readonly frontFace: "ccw" | "cw";
    readonly cullMode: "none" | "front" | "back";
    readonly unclippedDepth: boolean;
  };
  readonly colorTargets: readonly {
    readonly format: string;
    readonly blend: {
      readonly color: SerializableGpuBlendComponent;
      readonly alpha: SerializableGpuBlendComponent;
    } | null;
    readonly writeMask: number;
  }[];
  readonly depthStencil: {
    readonly format: string;
    readonly depthWriteEnabled: boolean;
    readonly depthCompare: GpuCompareFunction;
    readonly stencilFront: SerializableGpuStencilFaceState;
    readonly stencilBack: SerializableGpuStencilFaceState;
    readonly stencilReadMask: number;
    readonly stencilWriteMask: number;
    readonly depthBias: number;
    readonly depthBiasSlopeScale: number;
    readonly depthBiasClamp: number;
  } | null;
  readonly multisample: {
    readonly count: 1 | 4;
    readonly mask: number;
    readonly alphaToCoverageEnabled: boolean;
  };
}

export type GpuCompareFunction = "never" | "less" | "equal" | "less-equal" | "greater" | "not-equal" | "greater-equal" | "always";

export interface SerializableGpuBlendComponent {
  readonly operation: "add" | "subtract" | "reverse-subtract" | "min" | "max";
  readonly srcFactor: "zero" | "one" | "src" | "one-minus-src" | "src-alpha" | "one-minus-src-alpha" | "dst" | "one-minus-dst" | "dst-alpha" | "one-minus-dst-alpha" | "src-alpha-saturated" | "constant" | "one-minus-constant";
  readonly dstFactor: "zero" | "one" | "src" | "one-minus-src" | "src-alpha" | "one-minus-src-alpha" | "dst" | "one-minus-dst" | "dst-alpha" | "one-minus-dst-alpha" | "src-alpha-saturated" | "constant" | "one-minus-constant";
}

export interface SerializableGpuStencilFaceState {
  readonly compare: GpuCompareFunction;
  readonly failOp: "keep" | "zero" | "replace" | "invert" | "increment-clamp" | "decrement-clamp" | "increment-wrap" | "decrement-wrap";
  readonly depthFailOp: "keep" | "zero" | "replace" | "invert" | "increment-clamp" | "decrement-clamp" | "increment-wrap" | "decrement-wrap";
  readonly passOp: "keep" | "zero" | "replace" | "invert" | "increment-clamp" | "decrement-clamp" | "increment-wrap" | "decrement-wrap";
}

export type SerializableGpuPipelineDescriptor =
  | SerializableGpuComputePipelineDescriptor
  | SerializableGpuRenderPipelineDescriptor;

export interface GpuLimitRequirement {
  readonly name: string;
  readonly comparator: "at-least" | "at-most";
  readonly value: number;
}

export interface ShaderRequirements {
  readonly semantics: readonly string[];
  readonly features: readonly string[];
  readonly limits: readonly GpuLimitRequirement[];
  readonly formats: readonly string[];
}

export type ShaderRenderRole =
  | "material"
  | "lighting"
  | "outline"
  | "shadow"
  | "post-processing";

export interface ShaderValidationEvidenceRef {
  readonly evidenceId: string;
  readonly uri: string;
  readonly sha256: Sha256Hex;
  readonly matrixId: string;
  readonly matrixVersion: string;
  /** Digest of the exact versioned matrix-policy bytes used to produce the evidence. */
  readonly matrixSha256: Sha256Hex;
  /** Exact external GitHub build-provenance reference artifact for the evidence bytes. */
  readonly attestationRef: {
    readonly uri: string;
    readonly sha256: Sha256Hex;
  };
}

/** Additional qualification required beyond the stable universal matrix. */
export interface ScopedShaderValidationEvidenceRef {
  /** Stable, profile-selectable scope such as `xr`; `universal` is reserved. */
  readonly scope: string;
  readonly evidence: ShaderValidationEvidenceRef;
}

/** Exact supplemental matrix policy a style profile requires for every role. */
export interface ShaderValidationScopeRequirement {
  /** Stable policy scope such as `xr`; `universal` is reserved. */
  readonly scope: string;
  readonly matrixId: string;
  readonly matrixVersion: string;
  readonly matrixSha256: Sha256Hex;
}

export interface ShaderVersionManifest {
  readonly contractVersion: typeof SHADER_VERSION_MANIFEST_VERSION;
  readonly shaderId: string;
  readonly version: string;
  readonly modules: readonly {
    readonly moduleId: string;
    readonly uri: string;
    readonly byteLength: number;
    readonly sha256: Sha256Hex;
    readonly contentType: "text/wgsl; charset=utf-8";
  }[];
  readonly gpuInterface: GpuInterfaceRef;
  readonly pipelines: readonly SerializableGpuPipelineDescriptor[];
  readonly renderRoles: readonly {
    readonly role: ShaderRenderRole;
    readonly pipelineIds: readonly string[];
  }[];
  readonly compatibleModelInterfaces: readonly {
    readonly interfaceId: string;
    readonly interfaceVersion: string;
    readonly manifestSha256: Sha256Hex;
    readonly interfaceAbiHash: Sha256Hex;
    readonly modelAbiHash: Sha256Hex;
  }[];
  readonly requirements: ShaderRequirements;
  readonly shaderAbiHash: Sha256Hex;
  /** Passing evidence for the universal stable-WebGPU matrix. */
  readonly validationEvidence: ShaderValidationEvidenceRef;
  /** Passing evidence for additive matrices, for example XR device lanes. */
  readonly additionalValidationEvidence: readonly ScopedShaderValidationEvidenceRef[];
}

/** Immutable shader manifest fields qualified before external evidence is attached. */
export type ShaderVersionManifestCore = Omit<ShaderVersionManifest, "validationEvidence" | "additionalValidationEvidence">;

export interface ShaderStyleRoleBinding {
  readonly role: ShaderRenderRole;
  readonly shader: ShaderVersionRef;
}

export interface ShaderStyleProfileManifest {
  readonly contractVersion: typeof SHADER_STYLE_PROFILE_MANIFEST_VERSION;
  readonly profileId: string;
  readonly version: string;
  readonly style: string;
  readonly roles: readonly ShaderStyleRoleBinding[];
  readonly compatibleModelInterfaces: readonly {
    readonly interfaceId: string;
    readonly interfaceVersion: string;
    readonly manifestSha256: Sha256Hex;
    readonly interfaceAbiHash: Sha256Hex;
    readonly modelAbiHash: Sha256Hex;
  }[];
  readonly requiredSemantics: readonly string[];
  /** Exact supplemental matrix policies every referenced shader must provide. */
  readonly requiredValidationScopes: readonly ShaderValidationScopeRequirement[];
}

export interface ModelGpuCompatibilityDescriptor {
  readonly modelId: string;
  readonly version: string;
  readonly gpuInterface: GpuInterfaceRef;
  readonly modelAbiHash: Sha256Hex;
  readonly providedSemantics: readonly string[];
  readonly defaultStyleProfile: ShaderStyleProfileRef | null;
}

export interface GpuCapabilitySnapshot {
  readonly features: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
  readonly formats: readonly string[];
}

export interface ModelShaderCompatibility {
  readonly modelAbiHash: Sha256Hex;
  readonly shaderAbiHash: Sha256Hex;
  readonly matchedInterfaceId: string;
}

export type GpuScalarValue = number;
export type GpuVectorValue = readonly number[];
export type GpuMatrixValue = readonly (readonly number[])[];
export type GpuRecordValue = Readonly<Record<string, unknown>>;

export interface GpuRecordCodec<T = GpuRecordValue> {
  readonly record: GpuRecordLayout;
  readonly minimumByteLength: number;
  byteLength(value: T): number;
  encode(value: T): ArrayBuffer;
  encodeInto(
    value: T,
    destination: ArrayBuffer | ArrayBufferView,
    byteOffset?: number,
  ): number;
  decode(
    source: ArrayBuffer | ArrayBufferView,
    options?: { readonly byteOffset?: number; readonly byteLength?: number },
  ): T;
}

export interface PromotedShaderCatalogResolver {
  /** Must prove the URI belongs to the configured promoted catalog root and exact immutable identity. */
  isCatalogAssetUri(uri: string): boolean;
  loadProfile(
    ref: ShaderStyleProfileRef,
    signal?: AbortSignal,
  ): Promise<{ readonly bytes: Uint8Array; readonly promoted: boolean }>;
  loadShader(
    ref: ShaderVersionRef,
    signal?: AbortSignal,
  ): Promise<{ readonly bytes: Uint8Array; readonly promoted: boolean }>;
  loadInterface(
    ref: GpuInterfaceRef,
    signal?: AbortSignal,
  ): Promise<{ readonly bytes: Uint8Array; readonly promoted: boolean }>;
  loadModule(
    shader: ShaderVersionRef,
    moduleId: string,
    uri: string,
    signal?: AbortSignal,
  ): Promise<{ readonly bytes: Uint8Array; readonly promoted: boolean }>;
}

export interface LoadedShaderVersion {
  readonly ref: ShaderVersionRef;
  readonly manifest: ShaderVersionManifest;
  readonly gpuInterface: GpuInterfaceManifest;
  readonly modules: ReadonlyMap<string, Uint8Array>;
}

export interface LoadedShaderStyleProfile {
  readonly ref: ShaderStyleProfileRef;
  readonly manifest: ShaderStyleProfileManifest;
  readonly shaders: ReadonlyMap<ShaderRenderRole, LoadedShaderVersion>;
}

export interface GpuCompilationMessageLike {
  readonly type: "error" | "warning" | "info";
  readonly message: string;
  readonly lineNum?: number;
  readonly linePos?: number;
}

export interface GpuShaderModuleLike {
  getCompilationInfo(): Promise<{ readonly messages: readonly GpuCompilationMessageLike[] }>;
}

export interface GpuDeviceLike {
  readonly features: Iterable<string>;
  readonly limits: Readonly<Record<string, number>>;
  readonly lost?: Promise<{ readonly reason?: string; readonly message?: string }>;
  createShaderModule(descriptor: { readonly label?: string; readonly code: string }): GpuShaderModuleLike;
  createBindGroupLayout(descriptor: unknown): unknown;
  createPipelineLayout(descriptor: { readonly bindGroupLayouts: readonly unknown[] }): unknown;
  createComputePipelineAsync?(descriptor: unknown): Promise<unknown>;
  createRenderPipelineAsync?(descriptor: unknown): Promise<unknown>;
  createComputePipeline?(descriptor: unknown): unknown;
  createRenderPipeline?(descriptor: unknown): unknown;
  pushErrorScope?(filter: "validation"): void;
  popErrorScope?(): Promise<{ readonly message?: string } | null>;
}

export interface PreparedShaderStyleProfile {
  readonly loaded: LoadedShaderStyleProfile;
  readonly pipelines: ReadonlyMap<string, unknown>;
  readonly preparedAt: number;
  dispose(): void;
}

export interface ActiveShaderStyleProfile {
  readonly prepared: PreparedShaderStyleProfile;
  readonly activatedAt: number;
}

export interface FrameBoundaryScheduler {
  schedule(operation: () => void): Promise<void>;
}

export interface ShaderStyleController {
  readonly current: ActiveShaderStyleProfile | null;
}

export interface AssembledWgslModule {
  readonly moduleId: string;
  readonly source: string;
}

export type GpuSemanticSelector = GpuSemanticProjection;

/** Selects a reflected binding. Callers cannot supply its resource layout. */
export interface GpuModelBindingSelector {
  readonly moduleId: string;
  readonly group: number;
  readonly binding: number;
  readonly semantic?: string | null;
}

export interface ReflectGpuInterfaceInput {
  readonly interfaceId: string;
  readonly interfaceVersion: string;
  readonly modules: readonly AssembledWgslModule[];
  readonly pipelines: readonly SerializableGpuPipelineDescriptor[];
  readonly modelFacingRecordNames: readonly string[];
  readonly modelFacingBindings: readonly GpuModelBindingSelector[];
  readonly semantics: readonly GpuSemanticSelector[];
}

export interface GeneratedGpuInterfaceArtifacts {
  readonly manifestJson: string;
  readonly jsonSchemas: string;
  readonly typescriptTypes: string;
  readonly byteConstants: string;
  readonly codecs: string;
}

export interface ShaderCompileUnitManifest {
  readonly contractVersion: typeof SHADER_COMPILE_UNIT_VERSION;
  readonly compileUnitId: string;
  readonly fragmentIds: readonly string[];
  readonly modules: readonly {
    readonly moduleId: string;
    readonly sha256: Sha256Hex;
    readonly assembly: {
      /** UTF-8 fragment bytes joined by one LF byte, with no executable transforms. */
      readonly kind: "concat-v1";
      readonly fragmentIds: readonly string[];
    };
  }[];
  readonly entryPoints: readonly {
    readonly moduleId: string;
    readonly name: string;
    readonly stage: GpuShaderStage;
  }[];
  readonly pipelines: readonly SerializableGpuPipelineDescriptor[];
  readonly interfaceRef: GpuInterfaceRef;
  readonly overrideValues: Readonly<Record<string, boolean | number>>;
  readonly qualificationFixture: {
    readonly fixtureId: string;
    readonly path: string;
    readonly sha256: Sha256Hex;
  };
}

export interface ShaderCompileUnitInventory {
  readonly contractVersion: typeof SHADER_COMPILE_UNIT_VERSION;
  readonly fragments: readonly {
    readonly fragmentId: string;
    readonly path: string;
    readonly sha256: Sha256Hex;
  }[];
  readonly compileUnits: readonly ShaderCompileUnitManifest[];
}

export type ShaderMatrixBrowserName = "chromium" | "chrome" | "edge" | "firefox" | "safari";
export type ShaderMatrixOsName =
  | "ubuntu"
  | "windows"
  | "macos"
  | "chromeos"
  | "android"
  | "ios"
  | "ipados"
  | "visionos";

export interface StableWebGpuMatrixCell {
  readonly cellId: string;
  readonly runnerLabels: readonly string[];
  readonly browser: {
    readonly name: ShaderMatrixBrowserName;
    readonly channel: "stable" | "playwright-bundled";
  };
  readonly os: {
    readonly name: ShaderMatrixOsName;
    readonly versionRequirement:
      | { readonly kind: "exact"; readonly value: string }
      | { readonly kind: "major"; readonly value: number }
      | { readonly kind: "minimum-major"; readonly value: number }
      | { readonly kind: "stable-channel"; readonly channel: "stable" };
    readonly architecture: "x64" | "arm64";
  };
  readonly adapter: {
    readonly kind: "software" | "physical";
    readonly vendor: string;
    readonly family: string;
    readonly backend: "swiftshader" | "d3d12" | "metal" | "vulkan";
  };
  readonly automation: {
    readonly kind: "playwright" | "webdriver" | "device-farm" | "safari-webdriver";
  };
  readonly timeoutMs: number;
  readonly blocking: boolean;
  readonly countsTowardStableCoverage: boolean;
}

export interface StableWebGpuMatrixManifest {
  readonly contractVersion: typeof STABLE_WEBGPU_MATRIX_VERSION;
  readonly matrixId: string;
  readonly version: string;
  readonly policy: {
    readonly coverage: "all-cells-required";
    readonly unavailable: "fail";
    readonly skipped: "fail";
    readonly timeout: "fail";
    readonly deviceLoss: "fail";
    readonly requiredPhysicalCellCount: 15;
    readonly requiredBlockingCellCount: 16;
  };
  readonly cells: readonly StableWebGpuMatrixCell[];
}

export type ShaderQualificationStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "timeout"
  | "device-lost"
  | "runner-unavailable"
  | "adapter-unavailable";

export type ShaderQualificationPhaseName =
  | "assembly"
  | "reflection-schema"
  | "shader-compilation"
  | "pipeline-layout"
  | "pipeline-creation"
  | "bind-group-creation"
  | "cpu-to-gpu-layout"
  | "gpu-to-cpu-layout"
  | "bounded-execution"
  | "semantic-readback";

export type ShaderQualificationPhaseEvidence =
  | {
      readonly name: Exclude<ShaderQualificationPhaseName, "shader-compilation" | "semantic-readback">;
      readonly status: "passed" | "failed";
      readonly durationMs: number;
      readonly evidenceSha256: Sha256Hex;
    }
  | {
      readonly name: "shader-compilation";
      readonly status: "passed" | "failed";
      readonly durationMs: number;
      readonly compilationMessagesSha256: Sha256Hex;
      readonly errorCount: number;
    }
  | {
      readonly name: "semantic-readback";
      readonly status: "passed" | "failed";
      readonly durationMs: number;
      readonly expectedSha256: Sha256Hex;
      readonly actualSha256: Sha256Hex;
    };

export interface ShaderQualificationResult {
  readonly compileUnitId: string;
  readonly cellId: string;
  readonly status: ShaderQualificationStatus;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly observed: {
    readonly runner: { readonly id: string; readonly labels: readonly string[] };
    readonly os: { readonly name: string; readonly version: string; readonly channel: string | null; readonly architecture: string };
    readonly browser: { readonly name: string; readonly version: string; readonly channel: string };
    readonly adapter: {
      readonly physical: boolean;
      readonly vendor: string;
      readonly family: string;
      readonly architecture: string;
      readonly device: string;
      readonly description: string;
      readonly backend: string;
      readonly driver: string;
    };
    readonly features: readonly string[];
    readonly limits: Readonly<Record<string, number>>;
  };
  readonly phases: readonly ShaderQualificationPhaseEvidence[];
  readonly diagnostics: readonly ShaderDiagnostic[];
}

/** Candidate claims that can be serialized inside the candidate archive without a self-digest. */
export interface ShaderQualificationCandidateSubject {
  /** Digest of the ShaderVersionManifest projection with validationEvidence omitted. */
  readonly shaderManifestCore: {
    readonly shaderId: string;
    readonly version: string;
    readonly sha256: Sha256Hex;
  };
  readonly compileUnitInventorySha256: Sha256Hex;
  readonly shaderAbiHash: Sha256Hex;
  readonly interfaceManifestSha256: Sha256Hex;
  readonly modelAbiHashes: readonly Sha256Hex[];
  readonly modules: readonly { readonly moduleId: string; readonly sha256: Sha256Hex }[];
  readonly requiredCompileUnitIds: readonly string[];
  readonly requiredCellIds: readonly string[];
}

export interface ShaderValidationEvidenceSubject extends ShaderQualificationCandidateSubject {
  /** Verified externally over the complete immutable archive; never embedded in that archive. */
  readonly dataBundleSha256: Sha256Hex;
}

export interface ShaderTrustedWorkflowProvenance {
  readonly repository: string;
  readonly commit: GitObjectId;
  readonly ref: string;
  readonly workflowRef: string;
  readonly workflowSha: GitObjectId;
  readonly runId: string;
  readonly runAttempt: number;
  readonly job: string;
  readonly eventName: string;
  readonly oidcAttestation: {
    readonly issuer: "https://token.actions.githubusercontent.com";
    readonly subject: string;
    readonly audience: string;
    readonly verifiedClaimsSha256: Sha256Hex;
    readonly verifiedAt: string;
    readonly source: "trusted-runner-preflight";
  };
}

/** Identifies the workflow job and runner that produced a qualification-cell artifact. */
export interface ShaderQualificationExecutionProducer {
  readonly repository: string;
  readonly commit: GitObjectId;
  readonly ref: string;
  readonly runId: string;
  readonly runAttempt: number;
  readonly job: "swiftshader" | "physical" | "physical-runner-preflight";
  readonly trustedWorkflowRepository: "Plasius-LTD/gpu-shader";
  readonly trustedWorkflowRef: string;
  readonly trustedWorkflowSha: GitObjectId;
  readonly runner: {
    readonly name: string;
    readonly environment: "github-hosted" | "self-hosted" | "device-farm";
    readonly os: string;
    readonly architecture: string;
  };
}

export interface ShaderValidationEvidence {
  readonly contractVersion: typeof SHADER_VALIDATION_EVIDENCE_VERSION;
  readonly evidenceId: string;
  readonly status: "passed" | "failed";
  readonly generatedAt: string;
  readonly subjectBindingSha256: Sha256Hex;
  readonly subject: ShaderValidationEvidenceSubject;
  readonly matrixRef: {
    readonly matrixId: string;
    readonly version: string;
    readonly sha256: Sha256Hex;
  };
  readonly toolchain: {
    readonly packageVersion: string;
    readonly reflectorVersion: "1.5.0";
    readonly harness: {
      readonly id: string;
      readonly version: string;
      readonly sha256: Sha256Hex;
    };
  };
  readonly qualificationPreflightProvenance: ShaderTrustedWorkflowProvenance;
  readonly counts: {
    readonly compileUnits: number;
    readonly cells: number;
    readonly expectedResults: number;
    readonly passedResults: number;
  };
  readonly cellRuns: readonly ShaderValidationCellRun[];
  readonly results: readonly ShaderQualificationResult[];
}

export type ShaderQualificationResource =
  | {
      readonly kind: "buffer";
      readonly resourceId: string;
      readonly byteLength: number;
      readonly usage: readonly string[];
      readonly initialData: { readonly path: string; readonly sha256: Sha256Hex } | null;
    }
  | {
      readonly kind: "texture";
      readonly resourceId: string;
      readonly dimension: "1d" | "2d" | "3d";
      readonly size: readonly [number, number, number];
      readonly mipLevelCount: number;
      readonly sampleCount: 1 | 4;
      readonly format: string;
      readonly usage: readonly string[];
      readonly initialData: {
        readonly path: string;
        readonly sha256: Sha256Hex;
        readonly bytesPerRow: number;
        readonly rowsPerImage: number;
        readonly mipLevel: number;
        readonly origin: readonly [number, number, number];
        readonly aspect: "all" | "depth-only" | "stencil-only";
      } | null;
    }
  | {
      readonly kind: "sampler";
      readonly resourceId: string;
      readonly descriptor: Readonly<Record<string, JsonPrimitive>>;
    };

export type ShaderQualificationCommand =
  | {
      readonly kind: "dispatch";
      readonly pipelineId: string;
      readonly bindGroupIds: readonly string[];
      readonly workgroups: readonly [number, number, number];
    }
  | {
      readonly kind: "draw";
      readonly pipelineId: string;
      readonly bindGroupIds: readonly string[];
      readonly vertexBuffers: readonly {
        readonly slot: number;
        readonly resourceId: string;
        readonly offset: number;
        readonly size: number;
      }[];
      readonly colorAttachments: readonly {
        readonly resourceId: string;
        readonly view: ShaderQualificationTextureViewDescriptor;
        readonly clearValue: readonly [number, number, number, number];
        readonly loadOp: "clear" | "load";
        readonly storeOp: "store" | "discard";
      }[];
      readonly depthStencilAttachment: {
        readonly resourceId: string;
        readonly view: ShaderQualificationTextureViewDescriptor;
        readonly depthClearValue: number;
        readonly depthLoadOp: "clear" | "load";
        readonly depthStoreOp: "store" | "discard";
        readonly stencilClearValue: number;
        readonly stencilLoadOp: "clear" | "load" | null;
        readonly stencilStoreOp: "store" | "discard" | null;
      } | null;
      readonly vertexCount: number;
      readonly instanceCount: number;
      readonly firstVertex: number;
      readonly firstInstance: number;
    }
  | {
      readonly kind: "copy-buffer";
      readonly source: string;
      readonly destination: string;
      readonly byteLength: number;
    }
  | {
      readonly kind: "copy-texture-to-buffer";
      readonly source: {
        readonly resourceId: string;
        readonly mipLevel: number;
        readonly origin: readonly [number, number, number];
        readonly aspect: "all" | "depth-only" | "stencil-only";
      };
      readonly destination: {
        readonly resourceId: string;
        readonly offset: number;
        readonly bytesPerRow: number;
        readonly rowsPerImage: number;
      };
      readonly extent: readonly [number, number, number];
    };

export interface ShaderQualificationTextureViewDescriptor {
  readonly format: string | null;
  readonly dimension: "1d" | "2d" | "2d-array" | "cube" | "cube-array" | "3d" | null;
  readonly aspect: "all" | "depth-only" | "stencil-only";
  readonly baseMipLevel: number;
  readonly mipLevelCount: number | null;
  readonly baseArrayLayer: number;
  readonly arrayLayerCount: number | null;
}

export type ShaderQualificationBindGroupResource =
  | { readonly kind: "buffer"; readonly resourceId: string; readonly offset: number; readonly size: number }
  | { readonly kind: "texture-view"; readonly resourceId: string; readonly view: ShaderQualificationTextureViewDescriptor }
  | { readonly kind: "sampler"; readonly resourceId: string };

/** A declarative host-codec ↔ final-WGSL record-layout probe. */
export interface ShaderQualificationBufferRecordLayoutProbe {
  readonly kind: "buffer-record";
  readonly probeId: string;
  readonly source: {
    readonly moduleId: string;
    readonly group: number;
    readonly binding: number;
    readonly recordName: string;
  };
  readonly pipelineId: string;
  readonly commandIndex: number;
  readonly input: {
    readonly resourceId: string;
    readonly byteOffset: number;
    readonly byteLength: number;
    /** Encoded with createGpuRecordCodec and compared byte-for-byte with admitted initialData. */
    readonly value: JsonValue;
  };
  readonly output: {
    readonly readbackIndex: number;
    readonly recordName: string;
    /** GPU output is decoded with the reflected codec and compared to this value. */
    readonly expectedValue: JsonValue;
  };
}

/** A declarative host vertex-format encoder ↔ final-WGSL vertex-fetch probe. */
export interface ShaderQualificationVertexInputLayoutProbe {
  readonly kind: "vertex-input";
  readonly probeId: string;
  readonly source: {
    readonly pipelineId: string;
    readonly shaderLocation: number;
    readonly semantic: string;
  };
  readonly commandIndex: number;
  readonly input: {
    readonly resourceId: string;
    readonly vertexBufferSlot: number;
    /** Absolute vertex or instance element selected by the draw command. */
    readonly elementIndex: number;
    /** Encoded from the reflected GPUVertexFormat and compared with admitted bytes. */
    readonly value: JsonValue;
  };
  readonly output: {
    readonly readbackIndex: number;
    readonly recordName: string;
    /** GPU-observed vertex value encoded through this reflected output record. */
    readonly expectedValue: JsonValue;
  };
}

export type ShaderQualificationLayoutProbe =
  | ShaderQualificationBufferRecordLayoutProbe
  | ShaderQualificationVertexInputLayoutProbe;

export interface ShaderQualificationFixtureManifest {
  readonly contractVersion: typeof SHADER_QUALIFICATION_FIXTURE_VERSION;
  readonly fixtureId: string;
  readonly resources: readonly ShaderQualificationResource[];
  readonly bindGroups: readonly {
    readonly bindGroupId: string;
    readonly group: number;
    readonly entries: readonly { readonly binding: number; readonly resource: ShaderQualificationBindGroupResource }[];
  }[];
  readonly commands: readonly ShaderQualificationCommand[];
  readonly layoutProbes: readonly ShaderQualificationLayoutProbe[];
  readonly readbacks: readonly {
    readonly resourceId: string;
    readonly byteOffset: number;
    readonly byteLength: number;
    readonly expectedSha256: Sha256Hex;
  }[];
  readonly bounds: {
    readonly maxBufferBytes: number;
    readonly maxTextureTexels: number;
    readonly maxCommands: number;
    readonly timeoutMs: number;
  };
}

export interface ShaderQualificationBundleManifest {
  readonly contractVersion: typeof SHADER_QUALIFICATION_BUNDLE_VERSION;
  readonly inventory: ShaderCompileUnitInventory;
  readonly subject: ShaderQualificationCandidateSubject;
  readonly shaderManifestCorePath: string;
  readonly gpuInterfaceManifest: { readonly path: string; readonly sha256: Sha256Hex };
  readonly modelCompatibilityFixtures: readonly {
    readonly fixtureId: string;
    readonly path: string;
    readonly sha256: Sha256Hex;
  }[];
  readonly modules: readonly { readonly moduleId: string; readonly path: string; readonly sha256: Sha256Hex }[];
  readonly fixtures: readonly {
    readonly fixtureId: string;
    readonly path: string;
    readonly sha256: Sha256Hex;
    readonly kind: "qualification-fixture";
  }[];
}

export interface ShaderQualificationModelCompatibilityFixture {
  readonly contractVersion: typeof SHADER_QUALIFICATION_FIXTURE_VERSION;
  readonly fixtureId: string;
  readonly model: ModelGpuCompatibilityDescriptor;
}

export interface ShaderCellEvidence {
  readonly contractVersion: typeof SHADER_VALIDATION_EVIDENCE_VERSION;
  readonly qualificationId: string;
  readonly matrixId: string;
  readonly matrixVersion: string;
  readonly matrixSha256: Sha256Hex;
  readonly cellId: string;
  readonly dataBundleSha256: Sha256Hex;
  readonly compileUnitInventorySha256: Sha256Hex;
  readonly harness: {
    readonly id: string;
    readonly version: string;
    readonly sha256: Sha256Hex;
  };
  readonly automation: {
    readonly kind: "playwright" | "webdriver" | "device-farm" | "safari-webdriver";
    readonly driver: string;
    readonly version: string;
    readonly sha256: Sha256Hex;
  };
  /** `sha256("plasius.gpu.qualification-subject/v1\n" + canonical(subject,digests))`. */
  readonly subjectBindingSha256: Sha256Hex;
  readonly qualificationPreflightProvenance: ShaderTrustedWorkflowProvenance;
  readonly producer: ShaderQualificationExecutionProducer;
  readonly results: readonly ShaderQualificationResult[];
}

export interface ShaderRunnerCellPreflightEvidence {
  readonly contractVersion: typeof SHADER_VALIDATION_EVIDENCE_VERSION;
  readonly kind: "shader-runner-cell-preflight-evidence";
  readonly qualificationId: string;
  readonly cellId: string;
  readonly status: "available" | "runner-unavailable";
  readonly matrixSha256: Sha256Hex;
  readonly runnerLabels: readonly string[];
  /** API-observed self-hosted/device labels, or hosted image labels derived from the actual OS/architecture environment. */
  readonly matchedRunners: readonly {
    readonly name: string;
    readonly labels: readonly string[];
  }[];
  /** Independently verified adapter package/code identity, or null when inventory cannot observe it. */
  readonly adapterHarness: {
    readonly id: string;
    readonly version: string;
    readonly sha256: Sha256Hex;
  } | null;
  readonly qualificationPreflightProvenance: ShaderTrustedWorkflowProvenance;
  readonly producer: ShaderQualificationExecutionProducer;
}

export interface ShaderValidationCellRun {
  readonly cellId: string;
  readonly source: "cell-evidence" | "runner-preflight" | "workflow-diagnostic";
  readonly sourceArtifactSha256: Sha256Hex;
  readonly resultsSha256: Sha256Hex;
  readonly qualificationPreflightProvenance: ShaderTrustedWorkflowProvenance;
  readonly producer: ShaderQualificationExecutionProducer;
  readonly harness: {
    readonly id: string;
    readonly version: string;
    readonly sha256: Sha256Hex;
  };
  /** Null when no adapter actually executed (runner-unavailable/workflow diagnostic). */
  readonly automation: {
    readonly kind: "playwright" | "webdriver" | "device-farm" | "safari-webdriver";
    readonly driver: string;
    readonly version: string;
    readonly sha256: Sha256Hex;
  } | null;
  readonly resultCount: number;
  readonly status: ShaderQualificationStatus;
}

/** Non-secret claims emitted by the trusted prepare job after Blob version and OIDC verification. */
export interface ShaderQualificationPreflightManifest {
  readonly contractVersion: typeof SHADER_VALIDATION_EVIDENCE_VERSION;
  readonly kind: "shader-qualification-preflight";
  readonly qualificationId: string;
  readonly sourceBlob: {
    readonly host: string;
    readonly versionId: string;
    readonly uri: string;
  };
  readonly dataBundleSha256: Sha256Hex;
  readonly compileUnitInventorySha256: Sha256Hex;
  readonly matrixSha256: Sha256Hex;
  readonly harnessSha256: Sha256Hex;
  readonly subjectBindingSha256: Sha256Hex;
  readonly provenance: ShaderTrustedWorkflowProvenance;
}

export interface ShaderNonQualifyingWorkflowDiagnostic {
  readonly contractVersion: typeof SHADER_VALIDATION_EVIDENCE_VERSION;
  readonly kind: "non-qualifying-workflow-diagnostic";
  readonly qualificationId: string;
  readonly cellId: string;
  readonly status: "timeout" | "failed";
  readonly matrixSha256: Sha256Hex;
  readonly message: string;
  readonly qualificationPreflightProvenance: ShaderTrustedWorkflowProvenance;
  readonly producer: ShaderQualificationExecutionProducer;
}

/** External GitHub build-provenance reference; verified outside the evidence JSON digest. */
export interface ShaderValidationEvidenceAttestationRef {
  readonly contractVersion: typeof SHADER_VALIDATION_EVIDENCE_VERSION;
  readonly kind: "shader-validation-evidence-attestation-ref";
  readonly evidence: { readonly name: string; readonly sha256: Sha256Hex };
  readonly attestation: {
    readonly id: string;
    readonly url: string;
    readonly bundle: { readonly name: string; readonly sha256: Sha256Hex };
  };
  readonly producer: {
    readonly repository: string;
    readonly runId: string;
    readonly runAttempt: number;
    readonly trustedWorkflowRepository: "Plasius-LTD/gpu-shader";
    readonly trustedWorkflowRef: string;
    readonly trustedWorkflowSha: GitObjectId;
  };
}

export interface ShaderCompileFixture {
  /** Local/hosted testing only. Callback fixtures can never produce trusted physical evidence. */
  readonly qualificationEligible: false;
  readonly fixtureId: string;
  setup(context: ShaderCompileContext): Promise<void>;
  encode(context: ShaderCompileContext): Promise<void>;
  verify(context: ShaderCompileContext): Promise<void>;
  cleanup(context: ShaderCompileContext): Promise<void>;
}

export interface ShaderCompileContext {
  readonly device: GpuDeviceLike;
  readonly unit: ShaderCompileUnitManifest;
  readonly modules: ReadonlyMap<string, GpuShaderModuleLike>;
  readonly state: Map<string, unknown>;
}
