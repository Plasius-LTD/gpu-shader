import type {
  GpuInterfaceManifest,
  ShaderCompileUnitManifest,
  ShaderDiagnostic,
  ShaderQualificationFixtureManifest,
  ShaderQualificationPhaseEvidence,
  ShaderQualificationStatus,
  ShaderRequirements,
  StableWebGpuMatrixCell,
} from "../../contracts.js";

/** Host facts captured by trusted runner code rather than candidate data. */
export interface TrustedRunnerHostObservation {
  readonly runner: { readonly id: string; readonly labels: readonly string[] };
  readonly os: { readonly name: string; readonly version: string; readonly channel: string | null; readonly architecture: string };
}

/** Browser/device facts observed by the fixed automation adapter. */
export interface TrustedGpuObservation extends TrustedRunnerHostObservation {
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
}

export interface TrustedBrowserUnitPayload {
  readonly cell: StableWebGpuMatrixCell;
  readonly unit: ShaderCompileUnitManifest;
  readonly modules: readonly { readonly moduleId: string; readonly source: string }[];
  readonly fixture: ShaderQualificationFixtureManifest;
  /** Base64-encoded bytes, keyed only by exact admitted `.bin` paths. */
  readonly fixtureData: Readonly<Record<string, string>>;
  readonly requirements: ShaderRequirements;
  readonly modelAbiHash: string;
  /** Node-side reflection/codec validation reduces declarative probes to these exact byte identities. */
  readonly layoutProbes: readonly {
    readonly probeId: string;
    readonly kind: "binding" | "vertex-input";
    readonly sourceIdentity: string;
    readonly inputResourceId: string;
    readonly inputPath: string;
    readonly inputByteOffset: number;
    readonly inputByteLength: number;
    readonly inputSha256: string;
    readonly outputReadbackIndex: number;
  }[];
  readonly host: TrustedRunnerHostObservation;
  readonly timeoutMs: number;
}

export interface TrustedAdapterUnitResult {
  readonly status: ShaderQualificationStatus;
  readonly observed: TrustedGpuObservation;
  readonly phases: readonly ShaderQualificationPhaseEvidence[];
  readonly diagnostics: readonly ShaderDiagnostic[];
  /** Exact mapped GPU bytes; Node decodes these again with reflected CPU codecs. */
  readonly layoutProbeOutputs: readonly { readonly probeId: string; readonly bytesBase64: string }[];
}

export interface TrustedQualificationAdapter {
  readonly automation: {
    readonly kind: StableWebGpuMatrixCell["automation"]["kind"];
    readonly driver: string;
    readonly version: string;
    /** Digest of the independently verified executable adapter package/code. */
    readonly sha256: string;
  };
  /** Executes only the fixed trusted harness. Payload fields remain inert data. */
  runUnit(payload: TrustedBrowserUnitPayload): Promise<TrustedAdapterUnitResult>;
  close(): Promise<void>;
}

export interface TrustedQualificationAdapterFactory {
  create(cell: StableWebGpuMatrixCell): Promise<TrustedQualificationAdapter>;
}

export interface ReflectionQualificationProof {
  readonly manifest: GpuInterfaceManifest;
  readonly durationMs: number;
  readonly sha256: string;
}
