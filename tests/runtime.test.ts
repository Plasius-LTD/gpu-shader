import { describe, expect, it, vi } from "vitest";

import { canonicalizeGpuContract } from "../src/canonical-json.js";
import { validateModelShaderCompatibility } from "../src/compatibility.js";
import type {
  FrameBoundaryScheduler,
  GpuDeviceLike,
  LoadedShaderStyleProfile,
  PreparedShaderStyleProfile,
  PromotedShaderCatalogResolver,
  ShaderStyleProfileRef,
  ShaderVersionManifest,
} from "../src/contracts.js";
import { computeSha256 } from "../src/hash.js";
import { loadShaderStyleProfile } from "../src/runtime/catalog-loader.js";
import { prepareStyleProfile } from "../src/runtime/profile-preparer.js";
import {
  activateStyleProfile,
  createShaderStyleController,
} from "../src/runtime/style-controller.js";
import {
  trustLoadedShaderStyleProfile,
  trustPreparedShaderStyleProfile,
} from "../src/runtime/trusted-values.js";
import {
  clone,
  loadedStyleProfile,
  mutableLoadedStyleProfile,
  ONE_SHA,
  promotedCatalog,
  shaderAssets,
  TWO_SHA,
} from "./fixtures.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const QUALIFIED_LIMITS = {
  maxBindGroups: 4,
  maxBindingsPerBindGroup: 8,
  maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupSizeY: 256,
  maxComputeWorkgroupSizeZ: 64,
  maxComputeInvocationsPerWorkgroup: 256,
  maxStorageBuffersPerShaderStage: 8,
  maxStorageBufferBindingSize: 134_217_728,
};

function capabilities() {
  return {
    features: ["shader-f16"],
    limits: QUALIFIED_LIMITS,
    formats: ["rgba8unorm"],
  };
}

function mockDevice(overrides: Partial<GpuDeviceLike> = {}) {
  const createBindGroupLayout = vi.fn((descriptor: unknown) => ({ descriptor }));
  const createPipelineLayout = vi.fn((descriptor: unknown) => ({ descriptor }));
  const getCompilationInfo = vi.fn(async () => ({ messages: [] }));
  const createShaderModule = vi.fn(() => ({ getCompilationInfo }));
  const createComputePipelineAsync = vi.fn(async (descriptor: unknown) => ({ descriptor }));
  const pushErrorScope = vi.fn();
  const popErrorScope = vi.fn(async () => null);
  const device: GpuDeviceLike = {
    features: ["shader-f16"],
    limits: QUALIFIED_LIMITS,
    createBindGroupLayout,
    createPipelineLayout,
    createShaderModule,
    createComputePipelineAsync,
    pushErrorScope,
    popErrorScope,
    ...overrides,
  };
  return {
    device,
    createBindGroupLayout,
    createPipelineLayout,
    getCompilationInfo,
    createShaderModule,
    createComputePipelineAsync,
    pushErrorScope,
    popErrorScope,
  };
}

describe("model/shader compatibility", () => {
  it("accepts exact model/profile/shader ABI and device requirements", async () => {
    const assets = await shaderAssets();
    const result = validateModelShaderCompatibility({
      model: assets.model,
      shader: assets.shaderManifest,
      gpuInterface: assets.gpuInterface,
      profile: assets.profileManifest,
      capabilities: capabilities(),
    });
    expect(result).toEqual({
      ok: true,
      value: {
        modelAbiHash: assets.model.modelAbiHash,
        shaderAbiHash: assets.shaderManifest.shaderAbiHash,
        matchedInterfaceId: assets.model.gpuInterface.interfaceId,
      },
    });
  });

  it("reports all missing semantics/features/formats/limits without short-circuiting", async () => {
    const assets = await shaderAssets();
    const model = clone(assets.model);
    (model as Mutable<typeof model>).providedSemantics = [];
    const result = validateModelShaderCompatibility({
      model,
      shader: assets.shaderManifest,
      gpuInterface: assets.gpuInterface,
      profile: assets.profileManifest,
      capabilities: { features: [], limits: {}, formats: [] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(new Set(result.diagnostics.map((diagnostic) => diagnostic.code))).toEqual(new Set([
        "missing-semantic",
        "missing-feature",
        "unsupported-format",
        "limit-not-met",
      ]));
    }
  });

  it("rejects disagreement among model ref, shader ref and declared compatible interfaces", async () => {
    const assets = await shaderAssets();
    const model = clone(assets.model);
    (model.gpuInterface as Mutable<typeof model.gpuInterface>).modelAbiHash = ONE_SHA;
    const shader = clone(assets.shaderManifest);
    (shader.gpuInterface as Mutable<typeof shader.gpuInterface>).modelAbiHash = TWO_SHA;
    (shader as Mutable<ShaderVersionManifest>).compatibleModelInterfaces = [];
    const result = validateModelShaderCompatibility({ model, shader, gpuInterface: assets.gpuInterface });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "model-abi-mismatch")).toHaveLength(2);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "incompatible-model-interface" }));
    }
  });

  it("requires the exact advertised model interface manifest and full interface ABI tuple", async () => {
    const assets = await shaderAssets();
    for (const field of ["manifestSha256", "interfaceAbiHash"] as const) {
      const shader = clone(assets.shaderManifest);
      (shader.compatibleModelInterfaces[0] as Mutable<typeof shader.compatibleModelInterfaces[number]>)[field] = ONE_SHA;
      const shaderResult = validateModelShaderCompatibility({ model: assets.model, shader, gpuInterface: assets.gpuInterface });
      expect(shaderResult.ok, `shader ${field}`).toBe(false);
      if (!shaderResult.ok) {
        expect(shaderResult.diagnostics).toContainEqual(expect.objectContaining({ code: "incompatible-model-interface" }));
      }

      const profile = clone(assets.profileManifest);
      (profile.compatibleModelInterfaces[0] as Mutable<typeof profile.compatibleModelInterfaces[number]>)[field] = ONE_SHA;
      const profileResult = validateModelShaderCompatibility({
        model: assets.model,
        shader: assets.shaderManifest,
        gpuInterface: assets.gpuInterface,
        profile,
      });
      expect(profileResult.ok, `profile ${field}`).toBe(false);
      if (!profileResult.ok) {
        expect(profileResult.diagnostics).toContainEqual(expect.objectContaining({ code: "incompatible-model-interface" }));
      }
    }
  });

  it("supports matching application-defined semantic tokens without a hard-coded semantic registry", async () => {
    const assets = await shaderAssets();
    const semantic = "custom:toon/rim-light";
    const model = clone(assets.model);
    (model as Mutable<typeof model>).providedSemantics = [...model.providedSemantics, semantic];
    const shader = clone(assets.shaderManifest);
    (shader.requirements as Mutable<typeof shader.requirements>).semantics = [...shader.requirements.semantics, semantic];
    const profile = clone(assets.profileManifest);
    (profile as Mutable<typeof profile>).requiredSemantics = [...profile.requiredSemantics, semantic];
    expect(validateModelShaderCompatibility({ model, shader, gpuInterface: assets.gpuInterface, profile }).ok).toBe(true);

    (model as Mutable<typeof model>).providedSemantics = model.providedSemantics.filter((item) => item !== semantic);
    const missing = validateModelShaderCompatibility({ model, shader, gpuInterface: assets.gpuInterface, profile });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.diagnostics.every((item) => item.code === "missing-semantic")).toBe(true);
  });

  it("honours both at-least and at-most limit comparators", async () => {
    const assets = await shaderAssets();
    const shader = clone(assets.shaderManifest);
    (shader.requirements as Mutable<typeof shader.requirements>).limits = [
      ...shader.requirements.limits,
      { name: "minimum", comparator: "at-least", value: 4 },
      { name: "maximum", comparator: "at-most", value: 8 },
    ];
    expect(validateModelShaderCompatibility({
      model: assets.model,
      shader,
      gpuInterface: assets.gpuInterface,
      capabilities: { features: ["shader-f16"], formats: ["rgba8unorm"], limits: { ...QUALIFIED_LIMITS, minimum: 3, maximum: 9 } },
    }).ok).toBe(false);
    expect(validateModelShaderCompatibility({
      model: assets.model,
      shader,
      gpuInterface: assets.gpuInterface,
      capabilities: { features: ["shader-f16"], formats: ["rgba8unorm"], limits: { ...QUALIFIED_LIMITS, minimum: 4, maximum: 8 } },
    }).ok).toBe(true);
  });
});

describe("promoted catalog loading", () => {
  it("loads exact promoted profile/shader/interface/module bytes and regenerates both ABI hashes", async () => {
    const assets = await shaderAssets();
    const catalog = await promotedCatalog();
    const result = await loadShaderStyleProfile({ ref: assets.profileRef, catalog });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifest).toEqual(assets.profileManifest);
      expect(result.value.shaders.get("material")?.manifest).toEqual(assets.shaderManifest);
      expect(result.value.shaders.get("material")?.modules.get("compute")).toEqual(assets.moduleBytes);
    }
  });

  it("fails closed for every unpromoted asset level", async () => {
    const assets = await shaderAssets();
    const cases: Partial<PromotedShaderCatalogResolver>[] = [
      { loadProfile: async () => ({ bytes: assets.profileBytes, promoted: false }) },
      { loadShader: async () => ({ bytes: assets.shaderBytes, promoted: false }) },
      { loadInterface: async () => ({ bytes: assets.interfaceBytes, promoted: false }) },
      { loadModule: async () => ({ bytes: assets.moduleBytes, promoted: false }) },
    ];
    for (const override of cases) {
      const result = await loadShaderStyleProfile({
        ref: assets.profileRef,
        catalog: await promotedCatalog(override),
      });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects profile, shader, interface and module digest/length tampering", async () => {
    const assets = await shaderAssets();
    const cases: [Partial<PromotedShaderCatalogResolver>, string][] = [
      [{ loadProfile: async () => ({ bytes: Uint8Array.of(1), promoted: true }) }, "digest-mismatch"],
      [{ loadShader: async () => ({ bytes: Uint8Array.of(1), promoted: true }) }, "digest-mismatch"],
      [{ loadInterface: async () => ({ bytes: Uint8Array.of(1), promoted: true }) }, "digest-mismatch"],
      [{ loadModule: async () => ({ bytes: Uint8Array.of(1), promoted: true }) }, "invalid-contract"],
    ];
    for (const [override, expectedCode] of cases) {
      const result = await loadShaderStyleProfile({ ref: assets.profileRef, catalog: await promotedCatalog(override) });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics[0]!.code).toBe(expectedCode);
    }
  });

  it("rejects arbitrary external URIs even when a resolver returns matching bytes", async () => {
    const assets = await shaderAssets();
    const profile = clone(assets.profileManifest);
    (profile.roles[0]!.shader as Mutable<typeof profile.roles[number]["shader"]>).manifestUri =
      "https://attacker.invalid/shader.json";
    const profileBytes = new TextEncoder().encode(canonicalizeGpuContract(profile));
    const ref: ShaderStyleProfileRef = {
      ...assets.profileRef,
      manifestSha256: await computeSha256(profileBytes),
    };
    const catalog = await promotedCatalog({ loadProfile: async () => ({ bytes: profileBytes, promoted: true }) });
    const result = await loadShaderStyleProfile({ ref, catalog });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]!.message).toMatch(/outside the promoted catalog/u);
  });

  it("rejects recomputed references around structurally forged interface and shader ABI claims", async () => {
    const assets = await shaderAssets();
    const forgedInterface = clone(assets.gpuInterface);
    (forgedInterface as Mutable<typeof forgedInterface>).modelAbiHash = ONE_SHA;
    const interfaceBytes = new TextEncoder().encode(canonicalizeGpuContract(forgedInterface));
    const shader = clone(assets.shaderManifest);
    (shader.gpuInterface as Mutable<typeof shader.gpuInterface>).manifestSha256 = await computeSha256(interfaceBytes);
    (shader.gpuInterface as Mutable<typeof shader.gpuInterface>).modelAbiHash = ONE_SHA;
    const shaderBytes = new TextEncoder().encode(canonicalizeGpuContract(shader));
    const profile = clone(assets.profileManifest);
    (profile.roles[0]!.shader as Mutable<typeof profile.roles[number]["shader"]>).manifestSha256 = await computeSha256(shaderBytes);
    const profileBytes = new TextEncoder().encode(canonicalizeGpuContract(profile));
    const profileRef = { ...assets.profileRef, manifestSha256: await computeSha256(profileBytes) };
    const result = await loadShaderStyleProfile({
      ref: profileRef,
      catalog: await promotedCatalog({
        loadProfile: async () => ({ bytes: profileBytes, promoted: true }),
        loadShader: async () => ({ bytes: shaderBytes, promoted: true }),
        loadInterface: async () => ({ bytes: interfaceBytes, promoted: true }),
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]!.message).toMatch(/ABI hashes|modelAbiHash|identity/u);
  });

  it("does not schedule catalog reads when aborted before or immediately after profile resolution", async () => {
    const assets = await shaderAssets();
    const preAborted = new AbortController();
    preAborted.abort(new DOMException("cancelled", "AbortError"));
    const firstProfile = vi.fn(async () => ({ bytes: assets.profileBytes, promoted: true }));
    await expect(loadShaderStyleProfile({
      ref: assets.profileRef,
      catalog: await promotedCatalog({ loadProfile: firstProfile }),
      signal: preAborted.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(firstProfile).not.toHaveBeenCalled();

    const betweenStages = new AbortController();
    const loadShader = vi.fn(async () => ({ bytes: assets.shaderBytes, promoted: true }));
    const catalog = await promotedCatalog({
      loadProfile: async () => {
        betweenStages.abort(new DOMException("cancelled", "AbortError"));
        return { bytes: assets.profileBytes, promoted: true };
      },
      loadShader,
    });
    await expect(loadShaderStyleProfile({
      ref: assets.profileRef,
      catalog,
      signal: betweenStages.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(loadShader).not.toHaveBeenCalled();
  });
});

describe("style profile preparation", () => {
  it("rejects structurally forged loaded profiles before creating GPU resources", async () => {
    const assets = await shaderAssets();
    const gpu = mockDevice();
    const forged = mutableLoadedStyleProfile(await loadedStyleProfile());
    await expect(prepareStyleProfile({
      loaded: forged,
      model: assets.model,
      capabilities: capabilities(),
      device: gpu.device,
    })).rejects.toThrow(/returned by loadShaderStyleProfile/u);
    expect(gpu.createShaderModule).not.toHaveBeenCalled();
  });

  it("compiles through getCompilationInfo and creates explicit layouts/pipelines under an error scope", async () => {
    const assets = await shaderAssets();
    const gpu = mockDevice();
    const result = await prepareStyleProfile({
      loaded: await loadedStyleProfile(),
      model: assets.model,
      capabilities: capabilities(),
      device: gpu.device,
      now: () => 123,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.preparedAt).toBe(123);
      expect(result.value.pipelines.has("material:model.compute")).toBe(true);
      expect(() => (result.value.pipelines as Map<string, unknown>).clear()).toThrow();
      result.value.dispose();
      result.value.dispose();
      expect(result.value.pipelines.size).toBe(0);
    }
    expect(gpu.createShaderModule).toHaveBeenCalledWith(expect.objectContaining({ code: expect.stringContaining("@compute") }));
    expect(gpu.getCompilationInfo).toHaveBeenCalledOnce();
    expect(gpu.createBindGroupLayout).toHaveBeenCalledOnce();
    expect(gpu.createPipelineLayout).toHaveBeenCalledOnce();
    expect(gpu.createComputePipelineAsync).toHaveBeenCalledOnce();
    expect(gpu.pushErrorScope).toHaveBeenCalledWith("validation");
    expect(gpu.popErrorScope).toHaveBeenCalledOnce();
  });

  it("does not create GPU resources when compatibility fails", async () => {
    const assets = await shaderAssets();
    const gpu = mockDevice({ features: [] });
    const result = await prepareStyleProfile({
      loaded: await loadedStyleProfile(),
      model: assets.model,
      capabilities: capabilities(),
      device: gpu.device,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "missing-feature" }));
    expect(gpu.createShaderModule).not.toHaveBeenCalled();
  });

  it("classifies compilation, pipeline validation, device loss and timeout failures", async () => {
    const assets = await shaderAssets();
    const compile = mockDevice({
      createShaderModule: () => ({
        getCompilationInfo: async () => ({ messages: [{ type: "error", message: "invalid WGSL" }] }),
      }),
    });
    const compilation = await prepareStyleProfile({
      loaded: await loadedStyleProfile(), model: assets.model, capabilities: capabilities(), device: compile.device,
    });
    expect(compilation.ok).toBe(false);
    if (!compilation.ok) expect(compilation.diagnostics[0]!.code).toBe("compilation-error");

    const pipeline = mockDevice({ createComputePipelineAsync: async () => { throw new Error("pipeline rejected"); } });
    const pipelineResult = await prepareStyleProfile({
      loaded: await loadedStyleProfile(), model: assets.model, capabilities: capabilities(), device: pipeline.device,
    });
    expect(pipelineResult.ok).toBe(false);
    if (!pipelineResult.ok) expect(pipelineResult.diagnostics[0]!.code).toBe("pipeline-error");

    const lost = mockDevice({
      lost: Promise.resolve({ reason: "destroyed", message: "device disappeared" }),
      createComputePipelineAsync: async () => new Promise(() => undefined),
    });
    const lostResult = await prepareStyleProfile({
      loaded: await loadedStyleProfile(), model: assets.model, capabilities: capabilities(), device: lost.device,
    });
    expect(lostResult.ok).toBe(false);
    if (!lostResult.ok) expect(lostResult.diagnostics[0]!.code).toBe("device-lost");

    const timeout = mockDevice({ createComputePipelineAsync: async () => new Promise(() => undefined) });
    const timeoutResult = await prepareStyleProfile({
      loaded: await loadedStyleProfile(), model: assets.model, capabilities: capabilities(), device: timeout.device, timeoutMs: 1,
    });
    expect(timeoutResult.ok).toBe(false);
    if (!timeoutResult.ok) expect(timeoutResult.diagnostics[0]!.code).toBe("timeout");
  });

  it("rejects non-contiguous bind groups and scoped GPU validation errors", async () => {
    const assets = await shaderAssets();
    const loaded = mutableLoadedStyleProfile(await loadedStyleProfile());
    const shader = loaded.shaders.get("material")!;
    const compute = shader.manifest.pipelines[0];
    if (compute?.kind !== "compute") throw new Error("Fixture pipeline must be compute.");
    (compute.layout as Mutable<typeof compute.layout>).bindGroups = [{ ...compute.layout.bindGroups[0]!, group: 1 }];
    const layout = await prepareStyleProfile({
      loaded: trustLoadedShaderStyleProfile(loaded), model: assets.model, capabilities: capabilities(), device: mockDevice().device,
    });
    expect(layout.ok).toBe(false);

    const scoped = mockDevice({ popErrorScope: async () => ({ message: "scoped validation failure" }) });
    const scopedResult = await prepareStyleProfile({
      loaded: await loadedStyleProfile(), model: assets.model, capabilities: capabilities(), device: scoped.device,
    });
    expect(scopedResult.ok).toBe(false);
    if (!scopedResult.ok) expect(scopedResult.diagnostics[0]!.message).toContain("scoped validation failure");
  });

  it("isolates verified module bytes and maps from caller mutation before preparation", async () => {
    const assets = await shaderAssets();
    const loaded = await loadedStyleProfile();
    const shader = loaded.shaders.get("material")!;
    shader.modules.get("compute")!.fill(0);
    expect(() => (shader.modules as Map<string, Uint8Array>).clear()).toThrow();
    const gpu = mockDevice();
    const result = await prepareStyleProfile({
      loaded,
      model: assets.model,
      capabilities: capabilities(),
      device: gpu.device,
    });
    expect(result.ok).toBe(true);
    expect(gpu.createShaderModule).toHaveBeenCalledWith(expect.objectContaining({
      code: expect.stringContaining("@compute"),
    }));
  });

  it("normalizes boolean pipeline constants to WebGPU numeric descriptor values", async () => {
    const assets = await shaderAssets();
    const loaded = mutableLoadedStyleProfile(await loadedStyleProfile());
    const pipeline = loaded.shaders.get("material")!.manifest.pipelines[0];
    if (pipeline?.kind !== "compute") throw new Error("Fixture pipeline must be compute.");
    (pipeline.compute.constants as Record<string, boolean | number>).ENABLE_OUTLINE = true;
    const gpu = mockDevice();
    const result = await prepareStyleProfile({
      loaded: trustLoadedShaderStyleProfile(loaded),
      model: assets.model,
      capabilities: capabilities(),
      device: gpu.device,
    });
    expect(result.ok).toBe(true);
    expect(gpu.createComputePipelineAsync).toHaveBeenCalledWith(expect.objectContaining({
      compute: expect.objectContaining({ constants: { ENABLE_OUTLINE: 1 } }),
    }));
  });
});

function prepared(id: string) {
  const dispose = vi.fn();
  const value = {
    loaded: { manifest: { profileId: id } } as unknown as LoadedShaderStyleProfile,
    pipelines: new Map(),
    preparedAt: 0,
    dispose,
  } satisfies PreparedShaderStyleProfile;
  return { value: trustPreparedShaderStyleProfile(value), dispose };
}

describe("atomic style activation", () => {
  it("rejects structurally forged prepared profiles and forged initial state", async () => {
    const forged = {
      loaded: (await loadedStyleProfile()),
      pipelines: new Map(),
      preparedAt: 0,
      dispose: vi.fn(),
    } satisfies PreparedShaderStyleProfile;
    const scheduler: FrameBoundaryScheduler = { schedule: async (operation) => { operation(); } };
    const controller = createShaderStyleController({ scheduler });
    await expect(activateStyleProfile({ controller, prepared: forged })).rejects.toThrow(
      /returned by prepareStyleProfile/u,
    );
    expect(() => createShaderStyleController({ scheduler, initial: forged })).toThrow(
      /returned by prepareStyleProfile/u,
    );
  });

  it("switches only inside a frame boundary and retires the previous profile", async () => {
    const initial = prepared("initial");
    const next = prepared("next");
    let scheduled: (() => void) | undefined;
    const scheduler: FrameBoundaryScheduler = {
      schedule: async (operation) => new Promise<void>((resolve) => {
        scheduled = () => { operation(); resolve(); };
      }),
    };
    const controller = createShaderStyleController({ scheduler, initial: initial.value, now: () => 10 });
    const activation = activateStyleProfile({ controller, prepared: next.value });
    await Promise.resolve();
    expect(controller.current?.prepared).toBe(initial.value);
    scheduled!();
    const result = await activation;
    expect(result.ok).toBe(true);
    expect(controller.current?.prepared).toBe(next.value);
    expect(initial.dispose).toHaveBeenCalledOnce();
    expect(next.dispose).not.toHaveBeenCalled();
  });

  it("does not expose mutable active-profile state through the controller facade", () => {
    const initial = prepared("initial");
    const replacement = prepared("replacement");
    const controller = createShaderStyleController({
      scheduler: { schedule: async (operation) => { operation(); } },
      initial: initial.value,
    });
    expect(() => Object.assign(controller.current!, { prepared: replacement.value })).toThrow();
    expect(controller.current?.prepared).toBe(initial.value);
  });

  it("serializes concurrent switches in request order", async () => {
    const first = prepared("first");
    const second = prepared("second");
    const callbacks: (() => void)[] = [];
    const scheduler: FrameBoundaryScheduler = {
      schedule: async (operation) => new Promise<void>((resolve) => {
        callbacks.push(() => { operation(); resolve(); });
      }),
    };
    const controller = createShaderStyleController({ scheduler });
    const firstActivation = activateStyleProfile({ controller, prepared: first.value });
    const secondActivation = activateStyleProfile({ controller, prepared: second.value });
    await Promise.resolve();
    expect(callbacks).toHaveLength(1);
    callbacks.shift()!();
    await firstActivation;
    await Promise.resolve();
    await Promise.resolve();
    expect(callbacks).toHaveLength(1);
    callbacks.shift()!();
    await secondActivation;
    expect(controller.current?.prepared).toBe(second.value);
    expect(first.dispose).toHaveBeenCalledOnce();
  });

  it("preserves the active profile and disposes the candidate on boundary failure", async () => {
    const initial = prepared("initial");
    const candidate = prepared("candidate");
    const controller = createShaderStyleController({
      initial: initial.value,
      scheduler: { schedule: async () => { throw new Error("frame unavailable"); } },
    });
    const result = await activateStyleProfile({ controller, prepared: candidate.value });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]!.code).toBe("activation-error");
    expect(controller.current?.prepared).toBe(initial.value);
    expect(initial.dispose).not.toHaveBeenCalled();
    expect(candidate.dispose).toHaveBeenCalledOnce();
  });

  it("does not dispose the active profile when reactivation of the same prepared value fails", async () => {
    const active = prepared("active");
    const controller = createShaderStyleController({
      initial: active.value,
      scheduler: { schedule: async () => { throw new Error("frame unavailable"); } },
    });
    const result = await activateStyleProfile({ controller, prepared: active.value });
    expect(result.ok).toBe(false);
    expect(controller.current?.prepared).toBe(active.value);
    expect(active.dispose).not.toHaveBeenCalled();
  });

  it("rolls back a boundary callback that ran before its scheduler promise rejected", async () => {
    const initial = prepared("initial");
    const candidate = prepared("candidate");
    const controller = createShaderStyleController({
      initial: initial.value,
      scheduler: {
        schedule: async (operation) => {
          operation();
          throw new Error("frame commit rejected");
        },
      },
    });
    const result = await activateStyleProfile({ controller, prepared: candidate.value });
    expect(result.ok).toBe(false);
    expect(controller.current?.prepared).toBe(initial.value);
    expect(initial.dispose).not.toHaveBeenCalled();
    expect(candidate.dispose).toHaveBeenCalledOnce();
  });

  it.each(["resolve", "reject"] as const)("fails closed when a scheduler invokes the frame callback twice then %ss", async (outcome) => {
    const initial = prepared("initial");
    const candidate = prepared("candidate");
    const controller = createShaderStyleController({
      initial: initial.value,
      scheduler: {
        schedule: async (operation) => {
          operation();
          operation();
          if (outcome === "reject") throw new Error("duplicate callback scheduler rejected");
        },
      },
    });
    const result = await activateStyleProfile({ controller, prepared: candidate.value });
    expect(result.ok).toBe(false);
    expect(controller.current?.prepared).toBe(initial.value);
    expect(initial.dispose).not.toHaveBeenCalled();
    expect(candidate.dispose).toHaveBeenCalledOnce();
  });

  it("rejects forged controller objects", async () => {
    await expect(activateStyleProfile({
      controller: { current: null },
      prepared: prepared("candidate").value,
    })).rejects.toThrow(/created by createShaderStyleController/u);
  });
});
