import type {
  ShaderDiagnostic,
  ShaderQualificationPhaseEvidence,
  ShaderQualificationStatus,
} from "../../contracts.js";
import type {
  TrustedAdapterUnitResult,
  TrustedBrowserUnitPayload,
  TrustedGpuObservation,
} from "./types.js";

/**
 * Fixed browser-side WebGPU executor. Playwright serializes this function; it
 * deliberately references no imported runtime values or candidate callbacks.
 */
export async function executeQualificationInBrowser(
  payload: TrustedBrowserUnitPayload,
): Promise<TrustedAdapterUnitResult> {
  const phases: ShaderQualificationPhaseEvidence[] = [];
  const diagnostics: ShaderDiagnostic[] = [];
  const resources = new Map<string, any>();
  const pipelineLayouts = new Map<string, { layout: any; bindGroupLayouts: Map<number, any> }>();
  const pipelines = new Map<string, any>();
  const bindGroups = new Map<string, any>();
  const created: { destroy?: () => void }[] = [];
  let observed: TrustedGpuObservation | null = null;
  let device: any = null;
  let completed = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let layoutProbeOutputs: { probeId: string; bytesBase64: string }[] = [];

  const milliseconds = (start: number): number => Math.max(0, Math.round(performance.now() - start));
  const message = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
  const tagged = (status: ShaderQualificationStatus, text: string): Error & { status: ShaderQualificationStatus } => {
    const error = new Error(text) as Error & { status: ShaderQualificationStatus };
    error.status = status;
    return error;
  };
  const bytesFromBase64 = (value: string): Uint8Array => {
    const decoded = atob(value);
    const result = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) result[index] = decoded.charCodeAt(index);
    return result;
  };
  const bytesToBase64 = (value: Uint8Array): string => {
    let binary = "";
    for (let index = 0; index < value.byteLength; index += 1) binary += String.fromCharCode(value[index]!);
    return btoa(binary);
  };
  const uncompressedTextureBytes = new Map<string, number>([
    ["r8unorm", 1], ["r8snorm", 1], ["r8uint", 1], ["r8sint", 1],
    ["r16unorm", 2], ["r16snorm", 2], ["r16uint", 2], ["r16sint", 2], ["r16float", 2],
    ["rg8unorm", 2], ["rg8snorm", 2], ["rg8uint", 2], ["rg8sint", 2],
    ["r32uint", 4], ["r32sint", 4], ["r32float", 4],
    ["rg16unorm", 4], ["rg16snorm", 4], ["rg16uint", 4], ["rg16sint", 4], ["rg16float", 4],
    ["rgba8unorm", 4], ["rgba8unorm-srgb", 4], ["rgba8snorm", 4], ["rgba8uint", 4], ["rgba8sint", 4],
    ["bgra8unorm", 4], ["bgra8unorm-srgb", 4], ["rgb9e5ufloat", 4], ["rgb10a2uint", 4], ["rgb10a2unorm", 4], ["rg11b10ufloat", 4],
    ["rg32uint", 8], ["rg32sint", 8], ["rg32float", 8],
    ["rgba16unorm", 8], ["rgba16snorm", 8], ["rgba16uint", 8], ["rgba16sint", 8], ["rgba16float", 8],
    ["rgba32uint", 16], ["rgba32sint", 16], ["rgba32float", 16],
  ]);
  const checkedProduct = (left: number, right: number, label: string): number => {
    const result = left * right;
    if (!Number.isSafeInteger(result)) throw new Error(`${label} exceeds the safe integer bound.`);
    return result;
  };
  const checkedSum = (left: number, right: number, label: string): number => {
    const result = left + right;
    if (!Number.isSafeInteger(result)) throw new Error(`${label} exceeds the safe integer bound.`);
    return result;
  };
  const textureDataBounds = (
    resource: any,
  ): { readonly minimum: number; readonly maximum: number } => {
    const initial = resource.initialData;
    const bytesPerTexel = uncompressedTextureBytes.get(resource.format);
    if (!bytesPerTexel || initial.aspect !== "all") throw new Error(`Texture ${resource.resourceId} initial data uses an unsupported fixture-v1 format/aspect.`);
    if (!resource.usage.includes("copy-dst") || resource.sampleCount !== 1) throw new Error(`Texture ${resource.resourceId} initial data requires single-sampled copy-dst usage.`);
    if (initial.mipLevel !== 0 || initial.origin.some((value: number) => value !== 0)) throw new Error("Qualification fixture v1 supports only full mip-zero texture initialization.");
    const rowBytes = checkedProduct(resource.size[0], bytesPerTexel, `Texture ${resource.resourceId} row byte length`);
    if (initial.bytesPerRow < rowBytes || initial.bytesPerRow % bytesPerTexel !== 0 || initial.rowsPerImage < resource.size[1]) {
      throw new Error(`Texture ${resource.resourceId} initial data row/image layout is too small or misaligned.`);
    }
    const imageStride = checkedProduct(initial.bytesPerRow, initial.rowsPerImage, `Texture ${resource.resourceId} image stride`);
    const priorImages = checkedProduct(imageStride, resource.size[2] - 1, `Texture ${resource.resourceId} prior-image byte length`);
    const priorRows = checkedProduct(initial.bytesPerRow, resource.size[1] - 1, `Texture ${resource.resourceId} prior-row byte length`);
    const minimum = checkedSum(priorImages, checkedSum(priorRows, rowBytes, `Texture ${resource.resourceId} final-image byte length`), `Texture ${resource.resourceId} required byte length`);
    return { minimum, maximum: checkedProduct(imageStride, resource.size[2], `Texture ${resource.resourceId} padded byte capacity`) };
  };
  const sha256 = async (value: string | Uint8Array): Promise<string> => {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    const owned = new Uint8Array(bytes);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", owned.buffer));
    return [...digest].map((item) => item.toString(16).padStart(2, "0")).join("");
  };
  const evidence = async (name: string, value: unknown): Promise<string> => sha256(`${name}\n${JSON.stringify(value)}`);
  const phase = async <T>(
    name: Exclude<ShaderQualificationPhaseEvidence["name"], "shader-compilation" | "semantic-readback">,
    operation: () => Promise<{ readonly value: T; readonly proof: unknown }>,
  ): Promise<T> => {
    const started = performance.now();
    try {
      const result = await operation();
      phases.push({ name, status: "passed", durationMs: milliseconds(started), evidenceSha256: await evidence(name, result.proof) as any });
      return result.value;
    } catch (cause) {
      phases.push({ name, status: "failed", durationMs: milliseconds(started), evidenceSha256: await evidence(name, { error: message(cause) }) as any });
      throw cause;
    }
  };
  const withValidationScope = async <T>(operation: () => Promise<T> | T): Promise<T> => {
    device.pushErrorScope("validation");
    let result: T;
    try {
      result = await operation();
    } catch (cause) {
      await device.popErrorScope().catch(() => null);
      throw cause;
    }
    const validationError = await device.popErrorScope();
    if (validationError) throw new Error(`WebGPU validation error: ${validationError.message}`);
    return result;
  };
  const viewDescriptor = (view: any): Record<string, unknown> => {
    const descriptor: Record<string, unknown> = {
      aspect: view.aspect,
      baseMipLevel: view.baseMipLevel,
      baseArrayLayer: view.baseArrayLayer,
    };
    if (view.format !== null) descriptor.format = view.format;
    if (view.dimension !== null) descriptor.dimension = view.dimension;
    if (view.mipLevelCount !== null) descriptor.mipLevelCount = view.mipLevelCount;
    if (view.arrayLayerCount !== null) descriptor.arrayLayerCount = view.arrayLayerCount;
    return descriptor;
  };
  const stageVisibility = (values: readonly string[]): number => values.reduce((mask, value) => mask | (
    value === "vertex" ? 0x1 : value === "fragment" ? 0x2 : value === "compute" ? 0x4 : 0
  ), 0);
  const bufferUsage = (values: readonly string[]): number => {
    const flags: Record<string, number> = {
      "map-read": 0x0001,
      "map-write": 0x0002,
      "copy-src": 0x0004,
      "copy-dst": 0x0008,
      index: 0x0010,
      vertex: 0x0020,
      uniform: 0x0040,
      storage: 0x0080,
      indirect: 0x0100,
      "query-resolve": 0x0200,
    };
    return values.reduce((mask, value) => mask | (flags[value] ?? 0), 0);
  };
  const textureUsage = (values: readonly string[]): number => {
    const flags: Record<string, number> = {
      "copy-src": 0x01,
      "copy-dst": 0x02,
      "texture-binding": 0x04,
      "storage-binding": 0x08,
      "render-attachment": 0x10,
    };
    return values.reduce((mask, value) => mask | (flags[value] ?? 0), 0);
  };
  const bindingLayoutEntry = (entry: any): Record<string, unknown> => {
    const result: Record<string, unknown> = {
      binding: entry.binding,
      visibility: stageVisibility(entry.visibility),
    };
    const resource = entry.resource;
    if (resource.kind === "buffer") {
      result.buffer = {
        type: resource.addressSpace === "uniform" ? "uniform" : resource.access === "read" ? "read-only-storage" : "storage",
        hasDynamicOffset: false,
        minBindingSize: resource.minimumBindingSize,
      };
    } else if (resource.kind === "sampler") {
      result.sampler = { type: resource.samplerType };
    } else if (resource.kind === "texture") {
      result.texture = {
        sampleType: resource.sampleType,
        viewDimension: resource.viewDimension,
        multisampled: resource.multisampled,
      };
    } else if (resource.kind === "storage-texture") {
      result.storageTexture = {
        access: resource.access,
        format: resource.format,
        viewDimension: resource.viewDimension,
      };
    } else if (resource.kind === "external-texture") {
      result.externalTexture = {};
    } else {
      throw new Error(`Unsupported binding resource kind ${String(resource.kind)}.`);
    }
    return result;
  };
  const constants = (values: Readonly<Record<string, boolean | number>>): Record<string, number> => {
    const result: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const [name, value] of Object.entries(values)) result[name] = typeof value === "boolean" ? (value ? 1 : 0) : value;
    return result;
  };
  const programmable = (stage: any, modules: Map<string, any>): Record<string, unknown> => {
    const module = modules.get(stage.moduleId);
    if (!module) throw new Error(`Missing shader module ${stage.moduleId}.`);
    return { module, entryPoint: stage.entryPoint, constants: constants(stage.constants) };
  };
  const blend = (value: any): Record<string, unknown> => ({
    operation: value.operation,
    srcFactor: value.srcFactor,
    dstFactor: value.dstFactor,
  });
  const textureDescriptor = (resource: any): Record<string, unknown> => {
    return {
      label: `qualification:${resource.resourceId}`,
      size: { width: resource.size[0], height: resource.size[1], depthOrArrayLayers: resource.size[2] },
      mipLevelCount: resource.mipLevelCount,
      sampleCount: resource.sampleCount,
      dimension: resource.dimension,
      format: resource.format,
      usage: textureUsage(resource.usage),
    };
  };
  const readLimits = (limits: any): Record<string, number> => {
    const names = new Set<string>();
    let current: any = limits;
    while (current && current !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(current)) names.add(name);
      current = Object.getPrototypeOf(current);
    }
    const result: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const name of names) {
      let value: unknown;
      try { value = limits[name]; } catch { continue; }
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) result[name] = value;
    }
    return result;
  };
  const adapterInfo = async (adapter: any): Promise<Record<string, unknown>> => {
    if (adapter.info && typeof adapter.info === "object") return adapter.info as Record<string, unknown>;
    if (typeof adapter.requestAdapterInfo === "function") return await adapter.requestAdapterInfo() as Record<string, unknown>;
    return {};
  };

  try {
    const gpu = (navigator as any).gpu;
    if (!gpu) throw tagged("adapter-unavailable", "navigator.gpu is unavailable in the trusted browser context.");
    const adapter = await gpu.requestAdapter({
      powerPreference: "low-power",
      forceFallbackAdapter: payload.cell.adapter.kind === "software",
    });
    if (!adapter) throw tagged("adapter-unavailable", "No WebGPU adapter matched the matrix cell.");
    const info = await adapterInfo(adapter);
    const infoText = [info.vendor, info.architecture, info.device, info.description, info.driver]
      .map((value) => String(value ?? ""))
      .join(" ")
      .toLowerCase();
    if (payload.cell.adapter.kind === "physical") {
      throw tagged(
        "adapter-unavailable",
        "The generic bundled-browser executor cannot attest physical backend/driver/device facts; a trusted fleet adapter must supply independently observed target evidence.",
      );
    }
    if (payload.cell.adapter.kind === "software") {
      if (!infoText.includes("swiftshader")) throw tagged("adapter-unavailable", "Bundled Chromium did not select SwiftShader.");
      if (!(infoText.includes("google") || infoText.includes("1ae0"))) throw tagged("adapter-unavailable", "SwiftShader vendor identity is not Google.");
    }
    const availableFeatures = [...adapter.features].map(String).sort();
    const availableFeatureSet = new Set(availableFeatures);
    for (const feature of payload.requirements.features) {
      if (!availableFeatureSet.has(feature)) throw tagged("adapter-unavailable", `Adapter lacks required feature ${feature}.`);
    }
    const availableLimits = readLimits(adapter.limits);
    const requiredLimits: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const requirement of payload.requirements.limits) {
      const available = availableLimits[requirement.name];
      if (available === undefined || (requirement.comparator === "at-least" ? available < requirement.value : available > requirement.value)) {
        throw tagged("adapter-unavailable", `Adapter limit ${requirement.name} does not satisfy ${requirement.comparator} ${requirement.value}.`);
      }
      if (requirement.comparator === "at-least") requiredLimits[requirement.name] = requirement.value;
    }
    device = await adapter.requestDevice({ requiredFeatures: payload.requirements.features, requiredLimits });
    const uncaptured: string[] = [];
    device.addEventListener("uncapturederror", (event: any) => uncaptured.push(String(event.error?.message ?? event.message ?? "Uncaptured WebGPU error")));
    const browserVersion = String((globalThis as any).__PLASIUS_BROWSER_VERSION__ ?? "unknown");
    const driver = String(info.driver ?? info.description ?? `${payload.cell.adapter.family} via ${browserVersion}`);
    observed = {
      ...payload.host,
      browser: { name: payload.cell.browser.name, version: browserVersion, channel: payload.cell.browser.channel },
      adapter: {
        physical: false,
        // Normalized only after the actual adapter info above proved the fixed
        // Google SwiftShader route. Physical adapters must supply their own
        // independently observed normalized values.
        vendor: "google",
        family: "swiftshader",
        architecture: String(info.architecture ?? "software"),
        device: String(info.device ?? "Google SwiftShader"),
        description: String(info.description ?? "Google SwiftShader fixed Vulkan route"),
        backend: "swiftshader",
        driver,
      },
      features: availableFeatures,
      limits: availableLimits,
    };

    const run = async (): Promise<void> => {
      const modules = new Map<string, any>();
      const compilationStarted = performance.now();
      const compilationMessages: unknown[] = [];
      for (const item of payload.modules) {
        const module = device.createShaderModule({ label: `qualification:${item.moduleId}`, code: item.source });
        modules.set(item.moduleId, module);
        const info = await module.getCompilationInfo();
        for (const entry of info.messages) compilationMessages.push({
          moduleId: item.moduleId,
          type: entry.type,
          message: entry.message,
          lineNum: entry.lineNum ?? null,
          linePos: entry.linePos ?? null,
          offset: entry.offset ?? null,
          length: entry.length ?? null,
        });
      }
      const errorCount = compilationMessages.filter((entry: any) => entry.type === "error").length;
      phases.push({
        name: "shader-compilation",
        status: errorCount === 0 ? "passed" : "failed",
        durationMs: milliseconds(compilationStarted),
        compilationMessagesSha256: await evidence("shader-compilation", compilationMessages) as any,
        errorCount,
      });
      if (errorCount > 0) throw new Error(`WGSL compilation produced ${errorCount} error message(s).`);

      await phase("pipeline-layout", async () => withValidationScope(async () => {
        for (const descriptor of payload.unit.pipelines) {
          const groups = new Map<number, any>();
          for (const group of descriptor.layout.bindGroups) {
            const layout = device.createBindGroupLayout({
              label: `qualification:${descriptor.pipelineId}:group-${group.group}`,
              entries: group.entries.map(bindingLayoutEntry),
            });
            groups.set(group.group, layout);
          }
          const ordered = [...groups.entries()].sort((left, right) => left[0] - right[0]);
          if (ordered.some(([group], index) => group !== index)) throw new Error(`Pipeline ${descriptor.pipelineId} bind-group layouts are not contiguous.`);
          const layout = device.createPipelineLayout({
            label: `qualification:${descriptor.pipelineId}:layout`,
            bindGroupLayouts: ordered.map(([, value]) => value),
          });
          pipelineLayouts.set(descriptor.pipelineId, { layout, bindGroupLayouts: groups });
        }
        return { value: undefined, proof: payload.unit.pipelines.map((item) => ({ pipelineId: item.pipelineId, layout: item.layout })) };
      }));

      await phase("pipeline-creation", async () => withValidationScope(async () => {
        for (const descriptor of payload.unit.pipelines) {
          const layout = pipelineLayouts.get(descriptor.pipelineId)?.layout;
          if (!layout) throw new Error(`Missing explicit pipeline layout ${descriptor.pipelineId}.`);
          let pipeline: any;
          if (descriptor.kind === "compute") {
            pipeline = await device.createComputePipelineAsync({
              label: `qualification:${descriptor.pipelineId}`,
              layout,
              compute: programmable(descriptor.compute, modules),
            });
          } else {
            const primitive: Record<string, unknown> = {
              topology: descriptor.primitive.topology,
              frontFace: descriptor.primitive.frontFace,
              cullMode: descriptor.primitive.cullMode,
              unclippedDepth: descriptor.primitive.unclippedDepth,
            };
            if (descriptor.primitive.stripIndexFormat !== null) primitive.stripIndexFormat = descriptor.primitive.stripIndexFormat;
            const render: Record<string, unknown> = {
              label: `qualification:${descriptor.pipelineId}`,
              layout,
              vertex: {
                ...programmable(descriptor.vertex, modules),
                buffers: descriptor.vertexBuffers.map((buffer) => ({
                  arrayStride: buffer.arrayStride,
                  stepMode: buffer.stepMode,
                  attributes: buffer.attributes.map((attribute) => ({
                    format: attribute.format,
                    offset: attribute.offset,
                    shaderLocation: attribute.shaderLocation,
                  })),
                })),
              },
              primitive,
              multisample: descriptor.multisample,
            };
            if (descriptor.fragment !== null) render.fragment = {
              ...programmable(descriptor.fragment, modules),
              targets: descriptor.colorTargets.map((target) => ({
                format: target.format,
                ...(target.blend === null ? {} : { blend: { color: blend(target.blend.color), alpha: blend(target.blend.alpha) } }),
                writeMask: target.writeMask,
              })),
            };
            if (descriptor.depthStencil !== null) render.depthStencil = {
              format: descriptor.depthStencil.format,
              depthWriteEnabled: descriptor.depthStencil.depthWriteEnabled,
              depthCompare: descriptor.depthStencil.depthCompare,
              stencilFront: descriptor.depthStencil.stencilFront,
              stencilBack: descriptor.depthStencil.stencilBack,
              stencilReadMask: descriptor.depthStencil.stencilReadMask,
              stencilWriteMask: descriptor.depthStencil.stencilWriteMask,
              depthBias: descriptor.depthStencil.depthBias,
              depthBiasSlopeScale: descriptor.depthStencil.depthBiasSlopeScale,
              depthBiasClamp: descriptor.depthStencil.depthBiasClamp,
            };
            pipeline = await device.createRenderPipelineAsync(render);
          }
          pipelines.set(descriptor.pipelineId, pipeline);
        }
        return { value: undefined, proof: payload.unit.pipelines.map((item) => ({ kind: item.kind, pipelineId: item.pipelineId })) };
      }));

      await phase("bind-group-creation", async () => withValidationScope(async () => {
        for (const resource of payload.fixture.resources) {
          if (resource.kind === "buffer") {
            if (resource.byteLength % 4 !== 0) throw new Error(`Buffer ${resource.resourceId} byteLength must be a multiple of four.`);
            const initial = resource.initialData ? bytesFromBase64(payload.fixtureData[resource.initialData.path] ?? "") : null;
            if (initial && initial.byteLength > resource.byteLength) throw new Error(`Initial bytes exceed buffer ${resource.resourceId}.`);
            const buffer = device.createBuffer({
              label: `qualification:${resource.resourceId}`,
              size: resource.byteLength,
              usage: bufferUsage(resource.usage),
              mappedAtCreation: initial !== null,
            });
            if (initial) {
              const range = new Uint8Array(buffer.getMappedRange());
              range.fill(0);
              range.set(initial);
              buffer.unmap();
            }
            resources.set(resource.resourceId, buffer);
            created.push(buffer);
          } else if (resource.kind === "texture") {
            const texture = device.createTexture(textureDescriptor(resource));
            resources.set(resource.resourceId, texture);
            created.push(texture);
            if (resource.initialData) {
              const initial = bytesFromBase64(payload.fixtureData[resource.initialData.path] ?? "");
              const capacity = textureDataBounds(resource);
              if (initial.byteLength < capacity.minimum || initial.byteLength > capacity.maximum) throw new Error(`Texture ${resource.resourceId} initial data does not satisfy its declared row/image capacity.`);
              device.queue.writeTexture(
                { texture, mipLevel: 0, origin: resource.initialData.origin, aspect: resource.initialData.aspect },
                initial,
                { offset: 0, bytesPerRow: resource.initialData.bytesPerRow, rowsPerImage: resource.initialData.rowsPerImage },
                { width: resource.size[0], height: resource.size[1], depthOrArrayLayers: resource.size[2] },
              );
            }
          } else {
            resources.set(resource.resourceId, device.createSampler({ label: `qualification:${resource.resourceId}`, ...resource.descriptor }));
          }
        }
        const referenced = new Set(payload.fixture.commands.flatMap((command) => command.kind === "dispatch" || command.kind === "draw" ? command.bindGroupIds : []));
        if (referenced.size !== payload.fixture.bindGroups.length || payload.fixture.bindGroups.some((group) => !referenced.has(group.bindGroupId))) {
          throw new Error("Every declarative bind group must be exercised by a dispatch or draw command.");
        }
        for (const command of payload.fixture.commands) {
          if (command.kind !== "dispatch" && command.kind !== "draw") continue;
          const descriptor = payload.unit.pipelines.find((item) => item.pipelineId === command.pipelineId);
          const layoutState = pipelineLayouts.get(command.pipelineId);
          if (!descriptor || !layoutState) throw new Error(`Missing pipeline layout for ${command.pipelineId}.`);
          const expectedGroups = new Set(descriptor.layout.bindGroups.map((group) => group.group));
          const actualGroups = new Set<number>();
          for (const bindGroupId of command.bindGroupIds) {
            const fixtureGroup = payload.fixture.bindGroups.find((group) => group.bindGroupId === bindGroupId);
            if (!fixtureGroup || actualGroups.has(fixtureGroup.group)) throw new Error(`Command ${command.pipelineId} has a missing or duplicate bind-group coordinate.`);
            actualGroups.add(fixtureGroup.group);
            const groupLayout = layoutState.bindGroupLayouts.get(fixtureGroup.group);
            if (!groupLayout) throw new Error(`Pipeline ${command.pipelineId} has no layout for group ${fixtureGroup.group}.`);
            const entries = fixtureGroup.entries.map((entry) => {
              const ref = entry.resource;
              const resource = resources.get(ref.resourceId);
              if (!resource) throw new Error(`Missing fixture resource ${ref.resourceId}.`);
              if (ref.kind === "buffer") return { binding: entry.binding, resource: { buffer: resource, offset: ref.offset, size: ref.size } };
              if (ref.kind === "texture-view") return { binding: entry.binding, resource: resource.createView(viewDescriptor(ref.view)) };
              return { binding: entry.binding, resource };
            });
            bindGroups.set(`${command.pipelineId}\u0000${bindGroupId}`, device.createBindGroup({
              label: `qualification:${command.pipelineId}:${bindGroupId}`,
              layout: groupLayout,
              entries,
            }));
          }
          if (actualGroups.size !== expectedGroups.size || [...expectedGroups].some((group) => !actualGroups.has(group))) {
            throw new Error(`Command ${command.pipelineId} does not bind every explicit pipeline group.`);
          }
        }
        return { value: undefined, proof: { resources: payload.fixture.resources.map((item) => item.resourceId), bindGroups: [...bindGroups.keys()].sort() } };
      }));

      await phase("cpu-to-gpu-layout", async () => {
        if (payload.layoutProbes.length === 0) throw new Error("Compile unit has no declarative reflected layout probe.");
        const proofs = [];
        for (const probe of payload.layoutProbes) {
          const resource = payload.fixture.resources.find((item) => item.resourceId === probe.inputResourceId);
          if (!resource || resource.kind !== "buffer" || !resource.initialData || resource.initialData.path !== probe.inputPath) {
            throw new Error(`Layout probe ${probe.probeId} does not resolve to an initialized GPU buffer.`);
          }
          const admitted = bytesFromBase64(payload.fixtureData[probe.inputPath] ?? "");
          const end = probe.inputByteOffset + probe.inputByteLength;
          if (end > admitted.byteLength) throw new Error(`Layout probe ${probe.probeId} input range exceeds admitted CPU bytes.`);
          const actualSha256 = await sha256(admitted.slice(probe.inputByteOffset, end));
          if (actualSha256 !== probe.inputSha256) throw new Error(`Layout probe ${probe.probeId} CPU codec/vertex bytes are stale.`);
          proofs.push({
            probeId: probe.probeId,
            kind: probe.kind,
            sourceIdentity: probe.sourceIdentity,
            resourceId: probe.inputResourceId,
            byteOffset: probe.inputByteOffset,
            byteLength: probe.inputByteLength,
            sha256: actualSha256,
          });
        }
        return { value: undefined, proof: { modelAbiHash: payload.modelAbiHash, probes: proofs } };
      });

      await phase("bounded-execution", async () => withValidationScope(async () => {
        const encoder = device.createCommandEncoder({ label: `qualification:${payload.unit.compileUnitId}` });
        let dispatchWorkgroups = 0;
        let drawInvocations = 0;
        for (const command of payload.fixture.commands) {
          if (command.kind === "dispatch") {
            const count = command.workgroups[0] * command.workgroups[1] * command.workgroups[2];
            dispatchWorkgroups += count;
            if (!Number.isSafeInteger(dispatchWorkgroups) || dispatchWorkgroups > 1_048_576) throw new Error("Dispatch exceeds the trusted workgroup bound.");
            const pass = encoder.beginComputePass({ label: `qualification:${command.pipelineId}` });
            const pipeline = pipelines.get(command.pipelineId);
            if (!pipeline) throw new Error(`Missing compute pipeline ${command.pipelineId}.`);
            pass.setPipeline(pipeline);
            for (const bindGroupId of command.bindGroupIds) {
              const fixtureGroup = payload.fixture.bindGroups.find((group) => group.bindGroupId === bindGroupId)!;
              pass.setBindGroup(fixtureGroup.group, bindGroups.get(`${command.pipelineId}\u0000${bindGroupId}`));
            }
            pass.dispatchWorkgroups(...command.workgroups);
            pass.end();
          } else if (command.kind === "draw") {
            const count = command.vertexCount * command.instanceCount;
            drawInvocations += count;
            if (!Number.isSafeInteger(drawInvocations) || drawInvocations > 16_777_216) throw new Error("Draw exceeds the trusted invocation bound.");
            const colorAttachments = command.colorAttachments.map((attachment) => ({
              view: resources.get(attachment.resourceId).createView(viewDescriptor(attachment.view)),
              clearValue: attachment.clearValue,
              loadOp: attachment.loadOp,
              storeOp: attachment.storeOp,
            }));
            const depthStencilAttachment = command.depthStencilAttachment === null ? undefined : {
              view: resources.get(command.depthStencilAttachment.resourceId).createView(viewDescriptor(command.depthStencilAttachment.view)),
              depthClearValue: command.depthStencilAttachment.depthClearValue,
              depthLoadOp: command.depthStencilAttachment.depthLoadOp,
              depthStoreOp: command.depthStencilAttachment.depthStoreOp,
              ...(command.depthStencilAttachment.stencilLoadOp === null ? {} : {
                stencilClearValue: command.depthStencilAttachment.stencilClearValue,
                stencilLoadOp: command.depthStencilAttachment.stencilLoadOp,
                stencilStoreOp: command.depthStencilAttachment.stencilStoreOp,
              }),
            };
            const pass = encoder.beginRenderPass({ label: `qualification:${command.pipelineId}`, colorAttachments, ...(depthStencilAttachment ? { depthStencilAttachment } : {}) });
            const pipeline = pipelines.get(command.pipelineId);
            if (!pipeline) throw new Error(`Missing render pipeline ${command.pipelineId}.`);
            pass.setPipeline(pipeline);
            for (const bindGroupId of command.bindGroupIds) {
              const fixtureGroup = payload.fixture.bindGroups.find((group) => group.bindGroupId === bindGroupId)!;
              pass.setBindGroup(fixtureGroup.group, bindGroups.get(`${command.pipelineId}\u0000${bindGroupId}`));
            }
            for (const vertex of command.vertexBuffers) pass.setVertexBuffer(vertex.slot, resources.get(vertex.resourceId), vertex.offset, vertex.size);
            pass.draw(command.vertexCount, command.instanceCount, command.firstVertex, command.firstInstance);
            pass.end();
          } else if (command.kind === "copy-buffer") {
            encoder.copyBufferToBuffer(resources.get(command.source), 0, resources.get(command.destination), 0, command.byteLength);
          } else {
            encoder.copyTextureToBuffer(
              { texture: resources.get(command.source.resourceId), mipLevel: command.source.mipLevel, origin: command.source.origin, aspect: command.source.aspect },
              { buffer: resources.get(command.destination.resourceId), offset: command.destination.offset, bytesPerRow: command.destination.bytesPerRow, rowsPerImage: command.destination.rowsPerImage },
              command.extent,
            );
          }
        }
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        if (uncaptured.length > 0) throw new Error(uncaptured.join("; "));
        return { value: undefined, proof: { commands: payload.fixture.commands.length, dispatchWorkgroups, drawInvocations } };
      }));

      const semanticStarted = performance.now();
      const expectedDigests: string[] = [];
      const actualDigests: string[] = [];
      const actualReadbacks: Uint8Array[] = [];
      try {
        for (const readback of payload.fixture.readbacks) {
          const source = resources.get(readback.resourceId);
          if (!source) throw new Error(`Missing readback resource ${readback.resourceId}.`);
          const declaration = payload.fixture.resources.find((resource) => resource.resourceId === readback.resourceId);
          if (!declaration || declaration.kind !== "buffer" || !declaration.usage.includes("map-read")) {
            throw new Error(`Readback ${readback.resourceId} is not an admitted map-read buffer.`);
          }
          await source.mapAsync(0x0001, 0, declaration.byteLength);
          const mapped = new Uint8Array(source.getMappedRange(0, declaration.byteLength));
          const actualBytes = mapped.slice(readback.byteOffset, readback.byteOffset + readback.byteLength);
          source.unmap();
          const actualSha256 = await sha256(actualBytes);
          actualReadbacks.push(actualBytes);
          expectedDigests.push(readback.expectedSha256);
          actualDigests.push(actualSha256);
          if (actualSha256 !== readback.expectedSha256) throw new Error(`Semantic readback ${readback.resourceId} differs from its expected digest.`);
        }
        await phase("gpu-to-cpu-layout", async () => {
          const proofs = payload.layoutProbes.map((probe) => {
            const readback = payload.fixture.readbacks[probe.outputReadbackIndex];
            const actualSha256 = actualDigests[probe.outputReadbackIndex];
            if (!readback || !actualSha256 || actualSha256 !== readback.expectedSha256) {
              throw new Error(`Layout probe ${probe.probeId} does not resolve to a passed semantic GPU readback.`);
            }
            return {
              probeId: probe.probeId,
              sourceIdentity: probe.sourceIdentity,
              inputSha256: probe.inputSha256,
              outputResourceId: readback.resourceId,
              outputByteOffset: readback.byteOffset,
              outputByteLength: readback.byteLength,
              outputSha256: actualSha256,
            };
          });
          return { value: undefined, proof: { modelAbiHash: payload.modelAbiHash, probes: proofs } };
        });
        const expectedSha256 = await evidence("semantic-readback-set", expectedDigests);
        const actualSha256 = await evidence("semantic-readback-set", actualDigests);
        phases.push({ name: "semantic-readback", status: "passed", durationMs: milliseconds(semanticStarted), expectedSha256: expectedSha256 as any, actualSha256: actualSha256 as any });
        layoutProbeOutputs = payload.layoutProbes.map((probe) => ({
          probeId: probe.probeId,
          bytesBase64: bytesToBase64(actualReadbacks[probe.outputReadbackIndex]!),
        }));
      } catch (cause) {
        phases.push({ name: "semantic-readback", status: "failed", durationMs: milliseconds(semanticStarted), expectedSha256: await evidence("semantic-readback-set", expectedDigests) as any, actualSha256: await evidence("semantic-readback-set", actualDigests) as any });
        throw cause;
      }
    };

    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(tagged("timeout", `Trusted WebGPU unit exceeded ${payload.timeoutMs} ms.`)), payload.timeoutMs);
    });
    const deviceLost = device.lost.then((loss: any) => {
      if (completed) return new Promise<never>(() => undefined);
      throw tagged("device-lost", `WebGPU device lost (${String(loss.reason ?? "unknown")}): ${String(loss.message ?? "no message")}`);
    });
    await Promise.race([run(), timeout, deviceLost]);
    completed = true;
    const order = ["assembly", "reflection-schema", "shader-compilation", "pipeline-layout", "pipeline-creation", "bind-group-creation", "cpu-to-gpu-layout", "gpu-to-cpu-layout", "bounded-execution", "semantic-readback"];
    phases.sort((left, right) => order.indexOf(left.name) - order.indexOf(right.name));
    return { status: "passed", observed, phases, diagnostics, layoutProbeOutputs };
  } catch (cause) {
    const status = typeof cause === "object" && cause !== null && "status" in cause
      ? String((cause as { status: unknown }).status) as ShaderQualificationStatus
      : "failed";
    diagnostics.push({
      code: status === "timeout" ? "timeout" : status === "device-lost" ? "device-lost" : status === "adapter-unavailable" ? "adapter-unavailable" : "pipeline-error",
      severity: "error",
      message: message(cause).slice(0, 4096),
    });
    const fallback: TrustedGpuObservation = observed ?? {
      runner: { id: payload.host.runner.id, labels: [] },
      os: { name: "unavailable", version: "unavailable", channel: null, architecture: "unavailable" },
      browser: { name: payload.cell.browser.name, version: "unavailable", channel: payload.cell.browser.channel },
      adapter: {
        physical: false,
        vendor: "unavailable",
        family: "unavailable",
        architecture: "unavailable",
        device: "unavailable",
        description: "adapter unavailable",
        backend: "unavailable",
        driver: "unavailable",
      },
      features: [],
      limits: {},
    };
    return { status, observed: fallback, phases, diagnostics, layoutProbeOutputs: [] };
  } finally {
    completed = true;
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    for (const resource of created.reverse()) {
      try { resource.destroy?.(); } catch { /* best-effort cleanup after evidence is decided */ }
    }
    try { device?.destroy(); } catch { /* best-effort cleanup after evidence is decided */ }
  }
}
