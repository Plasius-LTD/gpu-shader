import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SHADER_COMPILE_UNIT_VERSION,
  SHADER_QUALIFICATION_FIXTURE_VERSION,
  type SerializableGpuComputePipelineDescriptor,
  type ShaderCompileUnitManifest,
  type ShaderQualificationFixtureManifest,
  type StableWebGpuMatrixCell,
} from "../src/contracts.js";
import { computeSha256 } from "../src/hash.js";
import { executeQualificationInBrowser } from "../src/testing/runner/browser-executor.js";
import type { TrustedBrowserUnitPayload } from "../src/testing/runner/types.js";

class FakeBuffer {
  readonly bytes: Uint8Array<ArrayBuffer>;
  constructor(size: number) { this.bytes = new Uint8Array(new ArrayBuffer(size)); }
  getMappedRange(offset = 0, size = this.bytes.byteLength - offset): ArrayBuffer {
    return offset === 0 && size === this.bytes.byteLength
      ? this.bytes.buffer
      : this.bytes.buffer.slice(offset, offset + size);
  }
  async mapAsync(): Promise<void> { return undefined; }
  unmap(): void {}
  destroy(): void {}
}

type Action = () => void;

class FakeEncoder {
  readonly actions: Action[] = [];
  copyBufferToBuffer(source: FakeBuffer, sourceOffset: number, destination: FakeBuffer, destinationOffset: number, size: number): void {
    this.actions.push(() => destination.bytes.set(source.bytes.slice(sourceOffset, sourceOffset + size), destinationOffset));
  }
  beginComputePass(): any {
    let group: any;
    return {
      setPipeline: () => undefined,
      setBindGroup: (_index: number, value: any) => { group = value; },
      dispatchWorkgroups: () => this.actions.push(() => {
        const buffer = group.entries[0].resource.buffer as FakeBuffer;
        const view = new DataView(buffer.bytes.buffer);
        view.setUint32(0, view.getUint32(0, true) + 1, true);
      }),
      end: () => undefined,
    };
  }
  finish(): { readonly actions: readonly Action[] } { return { actions: this.actions }; }
}

function fakeDevice(options: {
  readonly compilationMessages?: readonly Record<string, unknown>[];
  readonly compilationNeverCompletes?: boolean;
  readonly lost?: Promise<unknown>;
  readonly writeTexture?: (...args: any[]) => void;
} = {}): any {
  const queue = {
    submit: (commands: { actions: readonly Action[] }[]) => commands.forEach((command) => command.actions.forEach((action) => action())),
    onSubmittedWorkDone: async () => undefined,
    writeBuffer: (buffer: FakeBuffer, offset: number, bytes: Uint8Array) => buffer.bytes.set(bytes, offset),
    writeTexture: options.writeTexture ?? (() => undefined),
  };
  return {
    queue,
    lost: options.lost ?? new Promise(() => undefined),
    addEventListener: () => undefined,
    pushErrorScope: () => undefined,
    popErrorScope: async () => null,
    createShaderModule: () => ({
      getCompilationInfo: options.compilationNeverCompletes
        ? () => new Promise(() => undefined)
        : async () => ({ messages: options.compilationMessages ?? [] }),
    }),
    createBindGroupLayout: (descriptor: unknown) => descriptor,
    createPipelineLayout: (descriptor: unknown) => descriptor,
    createComputePipelineAsync: async (descriptor: unknown) => descriptor,
    createBuffer: (descriptor: { size: number }) => new FakeBuffer(descriptor.size),
    createBindGroup: (descriptor: unknown) => descriptor,
    createCommandEncoder: () => new FakeEncoder(),
    createSampler: (descriptor: unknown) => descriptor,
    createTexture: () => ({ createView: () => ({}), destroy: () => undefined }),
    destroy: () => undefined,
  };
}

const cell: StableWebGpuMatrixCell = {
  cellId: "swiftshader.chromium.ubuntu-x64",
  runnerLabels: ["ubuntu-24.04"],
  browser: { name: "chromium", channel: "playwright-bundled" },
  os: { name: "ubuntu", versionRequirement: { kind: "exact", value: "24.04" }, architecture: "x64" },
  adapter: { kind: "software", vendor: "google", family: "swiftshader", backend: "swiftshader" },
  automation: { kind: "playwright" },
  timeoutMs: 10_000,
  blocking: true,
  countsTowardStableCoverage: false,
};

const pipeline: SerializableGpuComputePipelineDescriptor = {
  kind: "compute",
  pipelineId: "probe.compute",
  layout: {
    bindGroups: [{
      group: 0,
      entries: [{
        group: 0,
        binding: 0,
        resource: { kind: "buffer", addressSpace: "storage", access: "read_write", recordName: "Probe", minimumBindingSize: 4 },
        visibility: ["compute"],
      }],
    }],
  },
  compute: { moduleId: "probe", entryPoint: "main", constants: {} },
};

const unit: ShaderCompileUnitManifest = {
  contractVersion: SHADER_COMPILE_UNIT_VERSION,
  compileUnitId: "probe.unit",
  fragmentIds: ["probe.fragment"],
  modules: [{ moduleId: "probe", sha256: "0".repeat(64) as any, assembly: { kind: "concat-v1", fragmentIds: ["probe.fragment"] } }],
  entryPoints: [{ moduleId: "probe", name: "main", stage: "compute" }],
  pipelines: [pipeline],
  interfaceRef: {
    interfaceId: "probe.interface",
    interfaceVersion: "1.0.0",
    manifestUri: "https://account.blob.core.windows.net/assets/interface.json?versionid=one",
    manifestSha256: "0".repeat(64) as any,
    interfaceAbiHash: "0".repeat(64) as any,
    modelAbiHash: "0".repeat(64) as any,
  },
  overrideValues: {},
  qualificationFixture: { fixtureId: "probe.fixture", path: "fixtures/probe.json", sha256: "0".repeat(64) as any },
};

async function payload(timeoutMs = 1_000): Promise<TrustedBrowserUnitPayload> {
  const input = new Uint8Array([1, 0, 0, 0]);
  const expected = new Uint8Array([2, 0, 0, 0]);
  const inputSha256 = await computeSha256(input);
  const expectedSha256 = await computeSha256(expected);
  const fixture: ShaderQualificationFixtureManifest = {
    contractVersion: SHADER_QUALIFICATION_FIXTURE_VERSION,
    fixtureId: "probe.fixture",
    resources: [
      { kind: "buffer", resourceId: "model", byteLength: 4, usage: ["storage", "copy-src"], initialData: { path: "data/model.bin", sha256: inputSha256 } },
      { kind: "buffer", resourceId: "readback", byteLength: 4, usage: ["copy-dst", "copy-src", "map-read"], initialData: null },
    ],
    bindGroups: [{ bindGroupId: "group.0", group: 0, entries: [{ binding: 0, resource: { kind: "buffer", resourceId: "model", offset: 0, size: 4 } }] }],
    commands: [
      { kind: "dispatch", pipelineId: "probe.compute", bindGroupIds: ["group.0"], workgroups: [1, 1, 1] },
      { kind: "copy-buffer", source: "model", destination: "readback", byteLength: 4 },
    ],
    layoutProbes: [{
      kind: "buffer-record",
      probeId: "probe.binding",
      source: { moduleId: "probe", group: 0, binding: 0, recordName: "Probe" },
      pipelineId: "probe.compute",
      commandIndex: 0,
      input: { resourceId: "model", byteOffset: 0, byteLength: 4, value: { value: 1 } },
      output: { readbackIndex: 0, recordName: "Probe", expectedValue: { value: 2 } },
    }],
    readbacks: [{ resourceId: "readback", byteOffset: 0, byteLength: 4, expectedSha256 }],
    bounds: { maxBufferBytes: 8, maxTextureTexels: 1, maxCommands: 2, timeoutMs },
  };
  return {
    cell,
    unit,
    modules: [{ moduleId: "probe", source: "@compute @workgroup_size(1) fn main() {}" }],
    fixture,
    fixtureData: { "data/model.bin": Buffer.from(input).toString("base64") },
    requirements: { semantics: [], features: [], limits: [], formats: [] },
    modelAbiHash: unit.interfaceRef.modelAbiHash,
    layoutProbes: [{
      probeId: "probe.binding",
      kind: "binding",
      sourceIdentity: "probe:0:0:Probe",
      inputResourceId: "model",
      inputPath: "data/model.bin",
      inputByteOffset: 0,
      inputByteLength: 4,
      inputSha256,
      outputReadbackIndex: 0,
    }],
    host: { runner: { id: "runner-1", labels: cell.runnerLabels }, os: { name: "ubuntu", version: "24.04", channel: null, architecture: "x64" } },
    timeoutMs,
  };
}

async function payloadWithTextureUpload(byteLength: number): Promise<TrustedBrowserUnitPayload> {
  const base = await payload();
  const path = "data/color.bin";
  const texture = {
    kind: "texture" as const,
    resourceId: "color",
    dimension: "2d" as const,
    size: [4, 2, 2] as const,
    mipLevelCount: 1,
    sampleCount: 1 as const,
    format: "rgba8unorm",
    usage: ["copy-dst"],
    initialData: {
      path,
      sha256: "0".repeat(64) as any,
      bytesPerRow: 256,
      rowsPerImage: 3,
      mipLevel: 0,
      origin: [0, 0, 0] as const,
      aspect: "all" as const,
    },
  };
  return {
    ...base,
    fixture: {
      ...base.fixture,
      resources: [...base.fixture.resources, texture],
      bounds: { ...base.fixture.bounds, maxTextureTexels: 16 },
    },
    fixtureData: { ...base.fixtureData, [path]: Buffer.alloc(byteLength).toString("base64") },
  };
}

function installGpu(device: any, info: Record<string, unknown> = {}): void {
  vi.stubGlobal("__PLASIUS_BROWSER_VERSION__", "123.4.5.6");
  vi.stubGlobal("navigator", {
    gpu: {
      requestAdapter: async () => ({
        info: {
          vendor: "Google Inc.",
          architecture: "SwiftShader",
          device: "SwiftShader Device (Subzero)",
          description: "Vulkan SwiftShader",
          driver: "Dawn SwiftShader 1",
          ...info,
        },
        features: new Set<string>(),
        limits: { maxStorageBuffersPerShaderStage: 8 },
        requestDevice: async () => device,
      }),
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("fixed browser WebGPU executor", () => {
  it("compiles with getCompilationInfo and executes the declarative reflected layout probe", async () => {
    installGpu(fakeDevice());
    const result = await executeQualificationInBrowser(await payload());
    expect(result.status).toBe("passed");
    expect(result.phases.map((phase) => phase.name)).toEqual([
      "shader-compilation",
      "pipeline-layout",
      "pipeline-creation",
      "bind-group-creation",
      "cpu-to-gpu-layout",
      "gpu-to-cpu-layout",
      "bounded-execution",
      "semantic-readback",
    ]);
    expect(result.observed.adapter).toMatchObject({ vendor: "google", family: "swiftshader", backend: "swiftshader" });
  });

  it("checks actual texture bytes against last-row and last-image capacity before writeTexture", async () => {
    const writeTexture = vi.fn();
    installGpu(fakeDevice({ writeTexture }));
    const accepted = await executeQualificationInBrowser(await payloadWithTextureUpload(1040));
    expect(accepted.status).toBe("passed");
    expect(writeTexture).toHaveBeenCalledOnce();

    installGpu(fakeDevice());
    const truncated = await executeQualificationInBrowser(await payloadWithTextureUpload(1039));
    expect(truncated.status).toBe("failed");
    expect(truncated.diagnostics[0]?.message).toMatch(/row\/image capacity/u);
  });

  it("fails on a real WGSL compilation error before creating pipelines", async () => {
    installGpu(fakeDevice({ compilationMessages: [{ type: "error", message: "invalid WGSL" }] }));
    const result = await executeQualificationInBrowser(await payload());
    expect(result.status).toBe("failed");
    expect(result.phases).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toMatch(/compilation produced 1 error/u);
  });

  it("regresses gpu-worker process_job hook signature differences at compilation", async () => {
    installGpu(fakeDevice({
      compilationMessages: [{
        type: "error",
        message: "no matching call to process_job(job_index, job_type, payload_words)",
      }],
    }));
    const worker = await payload();
    const result = await executeQualificationInBrowser({
      ...worker,
      modules: [{
        moduleId: "probe",
        source: "fn process_job() {} @compute @workgroup_size(1) fn main() { process_job(0u, 0u, 0u); }",
      }],
    });
    expect(result.status).toBe("failed");
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]).toMatchObject({ name: "shader-compilation", status: "failed", errorCount: 1 });
  });

  it("fails closed when the actual adapter is not SwiftShader", async () => {
    installGpu(fakeDevice(), {
      vendor: "Intel",
      architecture: "Xe",
      device: "physical",
      description: "Vulkan Intel",
      driver: "physical-driver",
    });
    const result = await executeQualificationInBrowser(await payload());
    expect(result.status).toBe("adapter-unavailable");
    expect(result.observed.adapter.vendor).toBe("unavailable");
    expect(result.observed.runner.labels).toEqual([]);
  });

  it("never copies requested physical backend or family into observed evidence", async () => {
    const physical = await payload();
    installGpu(fakeDevice(), {
      vendor: "Intel",
      architecture: "Xe-LPG",
      device: "8086:7d55",
      description: "Actual Intel adapter",
      driver: "31.0.101.5590",
    });
    const result = await executeQualificationInBrowser({
      ...physical,
      cell: {
        ...cell,
        cellId: "ubuntu-intel-chrome-vulkan",
        browser: { name: "chrome", channel: "stable" },
        adapter: { kind: "physical", vendor: "intel", family: "qualified-intel", backend: "vulkan" },
        countsTowardStableCoverage: true,
      },
    });
    expect(result.status).toBe("adapter-unavailable");
    expect(result.observed.adapter).toMatchObject({
      vendor: "unavailable",
      family: "unavailable",
      backend: "unavailable",
      driver: "unavailable",
    });
  });

  it("reports and clears the per-unit timeout", async () => {
    installGpu(fakeDevice({ compilationNeverCompletes: true }));
    const result = await executeQualificationInBrowser(await payload(5));
    expect(result.status).toBe("timeout");
    expect(result.diagnostics[0]?.code).toBe("timeout");
  });

  it("reports actual device loss as release-blocking", async () => {
    installGpu(fakeDevice({ lost: Promise.resolve({ reason: "unknown", message: "test loss" }) }));
    const result = await executeQualificationInBrowser(await payload());
    expect(result.status).toBe("device-lost");
    expect(result.diagnostics[0]?.code).toBe("device-lost");
  });
});
