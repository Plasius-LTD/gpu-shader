import type {
  GpuCapabilitySnapshot,
  GpuDeviceLike,
  LoadedShaderStyleProfile,
  ModelGpuCompatibilityDescriptor,
  PreparedShaderStyleProfile,
  SerializableGpuBindGroupLayout,
  SerializableGpuPipelineDescriptor,
  ShaderDiagnostic,
  ShaderResult,
} from "../contracts.js";
import { validateModelShaderCompatibility } from "../compatibility.js";
import { computeSha256 } from "../hash.js";
import {
  readonlyMapView,
  requireTrustedLoadedShaderStyleProfile,
  trustPreparedShaderStyleProfile,
} from "./trusted-values.js";

function error(code: ShaderDiagnostic["code"], message: string): ShaderDiagnostic {
  return { code, severity: "error", message };
}

class DeviceLostError extends Error {}

async function boundedGpuWait<T>(
  promise: Promise<T>,
  device: GpuDeviceLike,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("GPU operation timed out.")), timeoutMs); });
  const lost = device.lost?.then((info) => { throw new DeviceLostError(info.message ?? info.reason ?? "GPU device was lost."); });
  const aborted = signal ? new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  }) : undefined;
  try { return await Promise.race([promise, timeout, ...(lost ? [lost] : []), ...(aborted ? [aborted] : [])]); }
  finally { if (timer) clearTimeout(timer); if (abort && signal) signal.removeEventListener("abort", abort); }
}

function closeErrorScopeBestEffort(device: GpuDeviceLike, timeoutMs: number): void {
  if (!device.popErrorScope) return;
  const cleanupTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, 1_000)
    : 1_000;
  try {
    const pending = device.popErrorScope();
    void boundedGpuWait(pending, device, cleanupTimeout).catch(() => undefined);
  } catch {
    // A cleanup failure cannot replace or indefinitely delay the primary diagnostic.
  }
}

function visibilityMask(stages: readonly string[]): number {
  return stages.reduce((mask, stage) => mask | (stage === "vertex" ? 1 : stage === "fragment" ? 2 : 4), 0);
}

function bindGroupEntry(entry: SerializableGpuBindGroupLayout["entries"][number]): unknown {
  const common = { binding: entry.binding, visibility: visibilityMask(entry.visibility) };
  switch (entry.resource.kind) {
    case "buffer":
      return {
        ...common,
        buffer: {
          type: entry.resource.addressSpace === "uniform"
            ? "uniform"
            : entry.resource.access === "read" ? "read-only-storage" : "storage",
          minBindingSize: entry.resource.minimumBindingSize,
        },
      };
    case "sampler":
      return { ...common, sampler: { type: entry.resource.samplerType } };
    case "texture":
      return {
        ...common,
        texture: {
          sampleType: entry.resource.sampleType,
          viewDimension: entry.resource.viewDimension,
          multisampled: entry.resource.multisampled,
        },
      };
    case "storage-texture":
      return {
        ...common,
        storageTexture: {
          access: entry.resource.access,
          format: entry.resource.format,
          viewDimension: entry.resource.viewDimension,
        },
      };
    case "external-texture":
      return { ...common, externalTexture: {} };
  }
}

function pipelineLayout(device: GpuDeviceLike, pipeline: SerializableGpuPipelineDescriptor): unknown {
  const ordered = [...pipeline.layout.bindGroups].sort((left, right) => left.group - right.group);
  ordered.forEach((group, index) => {
    if (group.group !== index) throw new TypeError(`Pipeline ${pipeline.pipelineId} bind groups must be contiguous from zero.`);
  });
  const groups = ordered.map((group) => device.createBindGroupLayout({
      entries: group.entries.map(bindGroupEntry),
    }));
  return device.createPipelineLayout({ bindGroupLayouts: groups });
}

async function createPipeline(
  device: GpuDeviceLike,
  pipeline: SerializableGpuPipelineDescriptor,
  modules: ReadonlyMap<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const layout = pipelineLayout(device, pipeline);
  const module = (moduleId: string): unknown => { const resolved = modules.get(moduleId); if (!resolved) throw new TypeError(`Pipeline ${pipeline.pipelineId} references missing module ${moduleId}.`); return resolved; };
  const constants = (values: Readonly<Record<string, boolean | number>>): Readonly<Record<string, number>> => Object.fromEntries(Object.entries(values).map(([name, value]) => [name, typeof value === "boolean" ? Number(value) : value]));
  if (pipeline.kind === "compute") {
    const descriptor = {
      label: pipeline.pipelineId,
      layout,
      compute: {
        module: module(pipeline.compute.moduleId),
        entryPoint: pipeline.compute.entryPoint,
        constants: constants(pipeline.compute.constants),
      },
    };
    return device.createComputePipelineAsync
      ? boundedGpuWait(device.createComputePipelineAsync(descriptor), device, timeoutMs, signal)
      : device.createComputePipeline?.(descriptor);
  }
  const descriptor = {
    label: pipeline.pipelineId,
    layout,
    vertex: {
      module: module(pipeline.vertex.moduleId),
      entryPoint: pipeline.vertex.entryPoint,
      constants: constants(pipeline.vertex.constants),
      buffers: pipeline.vertexBuffers.map((buffer) => ({
        arrayStride: buffer.arrayStride,
        stepMode: buffer.stepMode,
        attributes: buffer.attributes.map((attribute) => ({ format: attribute.format, offset: attribute.offset, shaderLocation: attribute.shaderLocation })),
      })),
    },
    fragment: pipeline.fragment ? {
      module: module(pipeline.fragment.moduleId),
      entryPoint: pipeline.fragment.entryPoint,
      constants: constants(pipeline.fragment.constants),
      targets: pipeline.colorTargets,
    } : undefined,
    primitive: {
      topology: pipeline.primitive.topology,
      ...(pipeline.primitive.stripIndexFormat ? { stripIndexFormat: pipeline.primitive.stripIndexFormat } : {}),
      frontFace: pipeline.primitive.frontFace,
      cullMode: pipeline.primitive.cullMode,
      unclippedDepth: pipeline.primitive.unclippedDepth,
    },
    depthStencil: pipeline.depthStencil ?? undefined,
    multisample: pipeline.multisample,
  };
  return device.createRenderPipelineAsync
    ? boundedGpuWait(device.createRenderPipelineAsync(descriptor), device, timeoutMs, signal)
    : device.createRenderPipeline?.(descriptor);
}

/** Validates, compiles, and creates every replacement pipeline before activation. */
export async function prepareStyleProfile(input: {
  readonly loaded: LoadedShaderStyleProfile;
  readonly model: ModelGpuCompatibilityDescriptor;
  readonly capabilities: GpuCapabilitySnapshot;
  readonly device: GpuDeviceLike;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<ShaderResult<PreparedShaderStyleProfile>> {
  const loaded = requireTrustedLoadedShaderStyleProfile(input.loaded);
  const diagnostics: ShaderDiagnostic[] = [];
  const actualCapabilities: GpuCapabilitySnapshot = {
    features: [...input.device.features],
    limits: input.device.limits,
    formats: input.capabilities.formats,
  };
  for (const shader of loaded.shaders.values()) {
    const compatibility = validateModelShaderCompatibility({
      model: input.model,
      shader: shader.manifest,
      gpuInterface: shader.gpuInterface,
      profile: loaded.manifest,
      capabilities: actualCapabilities,
    });
    if (!compatibility.ok) diagnostics.push(...compatibility.diagnostics);
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const modules = new Map<string, unknown>();
  const pipelines = new Map<string, unknown>();
  let errorScopeOpen = false;
  try {
    if (input.device.pushErrorScope && input.device.popErrorScope) {
      input.device.pushErrorScope("validation");
      errorScopeOpen = true;
    }
    for (const [role, shader] of loaded.shaders) {
      const shaderModules = new Map<string, unknown>();
      for (const moduleManifest of shader.manifest.modules) {
        const bytes = shader.modules.get(moduleManifest.moduleId);
        if (!bytes) throw new TypeError(`Module ${moduleManifest.moduleId} is missing after verified loading.`);
        if (bytes.byteLength !== moduleManifest.byteLength) {
          throw new TypeError(`Module ${moduleManifest.moduleId} byte length changed after verified loading.`);
        }
        if (await computeSha256(bytes) !== moduleManifest.sha256) {
          throw new TypeError(`Module ${moduleManifest.moduleId} digest changed after verified loading.`);
        }
        const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const module = input.device.createShaderModule({
          label: `${shader.manifest.shaderId}:${moduleManifest.moduleId}`,
          code: source,
        });
        const information = await boundedGpuWait(module.getCompilationInfo(), input.device, input.timeoutMs ?? 30_000, input.signal);
        const failures = information.messages.filter((message) => message.type === "error");
        if (failures.length > 0) {
          throw new TypeError(`WGSL compilation failed for ${shader.manifest.shaderId}:${moduleManifest.moduleId}: ${failures[0]?.message ?? "unknown error"}`);
        }
        modules.set(`${role}:${moduleManifest.moduleId}`, module);
        shaderModules.set(moduleManifest.moduleId, module);
      }
      const roleManifest = shader.manifest.renderRoles.find((item) => item.role === role);
      if (!roleManifest) throw new TypeError(`Shader role ${role} disappeared during preparation.`);
      for (const pipelineId of roleManifest.pipelineIds) {
        const descriptor = shader.manifest.pipelines.find((item) => item.pipelineId === pipelineId);
        if (!descriptor) throw new TypeError(`Pipeline ${pipelineId} is missing from its shader manifest.`);
        const pipeline = await createPipeline(input.device, descriptor, shaderModules, input.timeoutMs ?? 30_000, input.signal);
        if (!pipeline) throw new TypeError(`GPU implementation did not create pipeline ${pipelineId}.`);
        pipelines.set(`${role}:${pipelineId}`, pipeline);
      }
    }
    let scopedError: { readonly message?: string } | null = null;
    if (input.device.popErrorScope) {
      errorScopeOpen = false;
      scopedError = await boundedGpuWait(input.device.popErrorScope(), input.device, input.timeoutMs ?? 30_000, input.signal);
    }
    if (scopedError) throw new TypeError(scopedError.message ?? "GPU validation error while preparing style profile.");
    let disposed = false;
    const publicPipelines = readonlyMapView(pipelines);
    const prepared = trustPreparedShaderStyleProfile({
      loaded: loaded.publicValue,
      pipelines: publicPipelines,
      preparedAt: (input.now ?? Date.now)(),
      dispose() {
        if (disposed) return;
        disposed = true;
        pipelines.clear();
        modules.clear();
      },
    });
    return {
      ok: true,
      value: prepared,
    };
  } catch (cause) {
    pipelines.clear();
    modules.clear();
    if (errorScopeOpen) {
      closeErrorScopeBestEffort(input.device, input.timeoutMs ?? 30_000);
    }
    return {
      ok: false,
      diagnostics: [error(
        cause instanceof DeviceLostError ? "device-lost"
          : cause instanceof TypeError && /digest|byte length/u.test(cause.message) ? "digest-mismatch"
          : cause instanceof TypeError && /compilation/u.test(cause.message) ? "compilation-error"
          : cause instanceof Error && /timed out/u.test(cause.message) ? "timeout" : "pipeline-error",
        cause instanceof Error ? cause.message : "Style profile preparation failed.",
      )],
    };
  }
}
