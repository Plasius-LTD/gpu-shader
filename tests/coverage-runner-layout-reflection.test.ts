import { describe, expect, it } from "vitest";

import { canonicalizeGpuContract } from "../src/canonical-json.js";
import { createGpuRecordCodec } from "../src/codec/codec.js";
import { encodeGpuVertexFormat } from "../src/codec/vertex-format.js";
import type {
  GpuInterfaceManifest,
  GpuRecordLayout,
  ShaderCompileUnitManifest,
  ShaderQualificationFixtureManifest,
  ShaderVersionManifestCore,
  StableWebGpuMatrixManifest,
} from "../src/contracts.js";
import { computeSha256 } from "../src/hash.js";
import type { AdmittedQualificationBundle } from "../src/node/bundle-admission.js";
import {
  prepareReflectedLayoutProbes,
  verifyReflectedLayoutProbeOutputs,
  type PreparedLayoutProbe,
} from "../src/testing/runner/layout-probes.js";
import {
  createTrustedReflectionProof,
  unitModuleSources,
} from "../src/testing/runner/reflection-proof.js";
import {
  clone,
  COMPUTE_WGSL,
  type DeepMutable,
  qualificationBundle,
  shaderAssets,
  validInventory,
  validQualificationFixture,
  validVertexInventory,
  validVertexQualificationFixture,
  ZERO_SHA,
} from "./fixtures.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const matrix: StableWebGpuMatrixManifest = {
  contractVersion: "1.0.0",
  matrixId: "coverage-matrix",
  version: "1.0.0",
  policy: {
    coverage: "all-cells-required",
    unavailable: "fail",
    skipped: "fail",
    timeout: "fail",
    deviceLoss: "fail",
    requiredPhysicalCellCount: 15,
    requiredBlockingCellCount: 16,
  },
  cells: [],
};

async function bindingAdmitted(): Promise<AdmittedQualificationBundle> {
  const assets = await shaderAssets();
  const inventory = clone(validInventory());
  const unit = inventory.compileUnits[0] as Mutable<ShaderCompileUnitManifest>;
  unit.interfaceRef = assets.interfaceRef;
  unit.modules = [{
    moduleId: "compute",
    sha256: assets.moduleSha256,
    assembly: { kind: "concat-v1", fragmentIds: ["fragment.main"] },
  }];
  (inventory.fragments[0] as Mutable<typeof inventory.fragments[number]>).sha256 = assets.moduleSha256;

  const manifest = clone(await qualificationBundle(matrix));
  (manifest as Mutable<typeof manifest>).inventory = inventory;
  (manifest as Mutable<typeof manifest>).modules = [{
    moduleId: "compute",
    path: "wgsl/main.wgsl",
    sha256: assets.moduleSha256,
  }];
  (manifest.subject as Mutable<typeof manifest.subject>).compileUnitInventorySha256 =
    await computeSha256(canonicalizeGpuContract(inventory));
  (manifest.subject as Mutable<typeof manifest.subject>).interfaceManifestSha256 =
    assets.interfaceRef.manifestSha256;
  (manifest.subject as Mutable<typeof manifest.subject>).modelAbiHashes = [assets.gpuInterface.modelAbiHash];
  (manifest.subject as Mutable<typeof manifest.subject>).modules = [{
    moduleId: "compute",
    sha256: assets.moduleSha256,
  }];
  (manifest.subject as Mutable<typeof manifest.subject>).requiredCellIds = [];

  const shader = clone(assets.shaderManifest);
  (shader as Mutable<typeof shader>).requirements = clone(assets.shaderManifest.requirements);
  const shaderManifestCore = Object.fromEntries(
    Object.entries(shader).filter(([key]) => key !== "validationEvidence" && key !== "additionalValidationEvidence"),
  ) as unknown as ShaderVersionManifestCore;
  const fixture = validQualificationFixture();
  const initial = new Uint8Array(112);
  return {
    root: "/trusted/fixture",
    manifest,
    shaderManifestCore,
    fixtures: new Map([[fixture.fixtureId, fixture]]),
    gpuInterface: assets.gpuInterface,
    modelFixtures: new Map([["model.fixture", assets.model]]),
    fileBytes: new Map([
      ["wgsl/main.wgsl", assets.moduleBytes],
      ["data/model.bin", initial],
    ]),
  };
}

function vertexReadbackRecord(): GpuRecordLayout {
  return {
    name: "VertexReadback",
    alignment: 16,
    byteSize: 16,
    minimumByteSize: 16,
    runtimeArrayMember: null,
    addressSpaces: ["storage"],
    members: [{
      name: "value",
      offset: 0,
      alignment: 16,
      valueByteSize: 16,
      occupiedByteSize: 16,
      explicitAlign: null,
      explicitSize: null,
      type: { kind: "vector", scalar: "f32", width: 4, alignment: 16, byteSize: 16 },
    }],
  };
}

async function vertexAdmitted(): Promise<{
  admitted: AdmittedQualificationBundle;
  unit: ShaderCompileUnitManifest;
  fixture: ShaderQualificationFixtureManifest;
}> {
  const admitted = await bindingAdmitted();
  const unit = validVertexInventory().compileUnits[0]!;
  const fixture = clone(validVertexQualificationFixture());
  const record = vertexReadbackRecord();
  const vertexInput = {
    pipelineId: "model.vertex",
    moduleId: "vertex",
    entryPoint: "vertexMain",
    shaderLocation: 0,
    shaderType: { kind: "vector", scalar: "f32", width: 4, alignment: 16, byteSize: 16 } as const,
    bufferSlot: 0,
    format: "float32x4",
    offset: 0,
    arrayStride: 16,
    stepMode: "vertex" as const,
    semantic: "model.position",
  };
  const gpuInterface: GpuInterfaceManifest = {
    ...admitted.gpuInterface,
    records: [record],
    bindings: [],
    vertexInputs: [vertexInput],
    modelAbi: {
      recordNames: [],
      bindings: [],
      vertexInputs: [{
        source: { pipelineId: "model.vertex", shaderLocation: 0 },
        format: "float32x4",
        offset: 0,
        arrayStride: 16,
        stepMode: "vertex",
        semantic: "model.position",
      }],
      semantics: [{
        semantic: "model.position",
        source: { kind: "vertex-attribute", pipelineId: "model.vertex", shaderLocation: 0 },
      }],
    },
  };
  const input = encodeGpuVertexFormat("float32x4", [1, 2, 3, 1]);
  const expected = new Uint8Array(createGpuRecordCodec(record, [record]).encode({ value: [1, 2, 3, 1] }));
  const initialData = fixture.resources[0];
  const readback = fixture.readbacks[0] as Mutable<typeof fixture.readbacks[number]>;
  if (initialData?.kind !== "buffer" || !initialData.initialData) throw new Error("Vertex fixture is malformed.");
  (initialData.initialData as Mutable<typeof initialData.initialData>).sha256 = await computeSha256(input);
  readback.expectedSha256 = await computeSha256(expected);
  return {
    admitted: {
      ...admitted,
      gpuInterface,
      fileBytes: new Map([[initialData.initialData.path, input]]),
    },
    unit,
    fixture,
  };
}

describe("reflected runner layout probes", () => {
  it("prepares and verifies exact reflected buffer-record bytes", async () => {
    const admitted = await bindingAdmitted();
    const unit = admitted.manifest.inventory.compileUnits[0]!;
    const fixture = admitted.fixtures.get("fixture.main")!;
    const prepared = await prepareReflectedLayoutProbes({ admitted, unit, fixture });

    expect(prepared).toHaveLength(1);
    expect(prepared[0]!.browser).toMatchObject({
      kind: "binding",
      sourceIdentity: "compute:0:0:ModelData",
      inputByteLength: 112,
    });
    expect(() => verifyReflectedLayoutProbeOutputs({
      prepared,
      outputs: [{
        probeId: prepared[0]!.browser.probeId,
        bytesBase64: Buffer.from(prepared[0]!.expectedOutput).toString("base64"),
      }],
    })).not.toThrow();
  });

  it("prepares and verifies an exact reflected vertex fetch", async () => {
    const { admitted, unit, fixture } = await vertexAdmitted();
    const prepared = await prepareReflectedLayoutProbes({ admitted, unit, fixture });

    expect(prepared[0]!.browser).toMatchObject({
      kind: "vertex-input",
      sourceIdentity: "model.vertex:0:model.position:float32x4",
      inputByteOffset: 0,
      inputByteLength: 16,
    });
    expect(() => verifyReflectedLayoutProbeOutputs({
      prepared,
      outputs: [{
        probeId: prepared[0]!.browser.probeId,
        bytesBase64: Buffer.from(prepared[0]!.expectedOutput).toString("base64"),
      }],
    })).not.toThrow();
  });

  it.each([
    ["an empty probe set", (fixture: DeepMutable<ShaderQualificationFixtureManifest>) => { fixture.layoutProbes = []; }, /requires a reflected layout probe/u],
    ["a module outside the unit", (fixture: DeepMutable<ShaderQualificationFixtureManifest>) => {
      const probe = fixture.layoutProbes[0];
      if (probe?.kind === "buffer-record") probe.source.moduleId = "other";
    }, /outside compile unit/u],
    ["a missing reflected record", (fixture: DeepMutable<ShaderQualificationFixtureManifest>) => {
      const probe = fixture.layoutProbes[0];
      if (probe?.kind === "buffer-record") probe.output.recordName = "Missing";
    }, /missing reflected record/u],
    ["a mismatched pipeline command", (fixture: DeepMutable<ShaderQualificationFixtureManifest>) => {
      const probe = fixture.layoutProbes[0];
      if (probe?.kind === "buffer-record") probe.commandIndex = 1;
    }, /exact dispatch\/draw pipeline command/u],
    ["an unbound input", (fixture: DeepMutable<ShaderQualificationFixtureManifest>) => { fixture.bindGroups = []; }, /input is not bound/u],
    ["an out-of-range input", (fixture: DeepMutable<ShaderQualificationFixtureManifest>) => {
      const probe = fixture.layoutProbes[0];
      if (probe?.kind === "buffer-record") probe.input.byteOffset = 1;
    }, /input range exceeds/u],
    ["a missing readback", (fixture: DeepMutable<ShaderQualificationFixtureManifest>) => { fixture.readbacks = []; }, /output readback is missing/u],
  ])("fails closed for %s", async (_label, mutate, expected) => {
    const admitted = await bindingAdmitted();
    const fixture = clone(admitted.fixtures.get("fixture.main")!) as DeepMutable<ShaderQualificationFixtureManifest>;
    mutate(fixture);
    await expect(prepareReflectedLayoutProbes({
      admitted,
      unit: admitted.manifest.inventory.compileUnits[0]!,
      fixture: fixture as unknown as ShaderQualificationFixtureManifest,
    })).rejects.toThrow(expected);
  });

  it("rejects admitted bytes and expected readback digests that differ from reflected codecs", async () => {
    const admitted = await bindingAdmitted();
    const unit = admitted.manifest.inventory.compileUnits[0]!;
    const fixture = admitted.fixtures.get("fixture.main")!;
    const changedBytes = new Map(admitted.fileBytes);
    changedBytes.set("data/model.bin", new Uint8Array(112).fill(1));
    await expect(prepareReflectedLayoutProbes({
      admitted: { ...admitted, fileBytes: changedBytes },
      unit,
      fixture,
    })).rejects.toThrow(/CPU codec output/u);

    const stale = clone(fixture);
    (stale.readbacks[0] as Mutable<typeof stale.readbacks[number]>).expectedSha256 = ZERO_SHA;
    await expect(prepareReflectedLayoutProbes({ admitted, unit, fixture: stale })).rejects.toThrow(/expected GPU output/u);
  });

  it("rejects incomplete, duplicate, missing, byte-different and decode-different outputs", async () => {
    const admitted = await bindingAdmitted();
    const prepared = await prepareReflectedLayoutProbes({
      admitted,
      unit: admitted.manifest.inventory.compileUnits[0]!,
      fixture: admitted.fixtures.get("fixture.main")!,
    });
    expect(() => verifyReflectedLayoutProbeOutputs({ prepared, outputs: [] })).toThrow(/incomplete/u);

    expect(() => verifyReflectedLayoutProbeOutputs({
      prepared: [prepared[0]!, prepared[0]!],
      outputs: [
        { probeId: "same", bytesBase64: "AA==" },
        { probeId: "same", bytesBase64: "AA==" },
      ],
    })).toThrow(/duplicates/u);
    expect(() => verifyReflectedLayoutProbeOutputs({
      prepared,
      outputs: [{ probeId: "other", bytesBase64: "AA==" }],
    })).toThrow(/output is missing/u);
    expect(() => verifyReflectedLayoutProbeOutputs({
      prepared,
      outputs: [{ probeId: prepared[0]!.browser.probeId, bytesBase64: Buffer.alloc(112, 1).toString("base64") }],
    })).toThrow(/output bytes differ/u);

    const decodeDifferent: PreparedLayoutProbe = {
      ...prepared[0]!,
      outputCodec: {
        ...prepared[0]!.outputCodec,
        decode: () => ({ counter: 99 }),
      },
    };
    expect(() => verifyReflectedLayoutProbeOutputs({
      prepared: [decodeDifferent],
      outputs: [{
        probeId: decodeDifferent.browser.probeId,
        bytesBase64: Buffer.from(decodeDifferent.expectedOutput).toString("base64"),
      }],
    })).toThrow(/decoded value differs/u);
  });

  it("fails closed for vertex ABI, draw, range, bytes and readback drift", async () => {
    const base = await vertexAdmitted();

    const abi = clone(base.admitted.gpuInterface);
    (abi.modelAbi.vertexInputs[0] as Mutable<typeof abi.modelAbi.vertexInputs[number]>).format = "float32x3";
    await expect(prepareReflectedLayoutProbes({
      admitted: { ...base.admitted, gpuInterface: abi },
      unit: base.unit,
      fixture: base.fixture,
    })).rejects.toThrow(/not an exact reflected model-facing vertex input/u);

    const draw = clone(base.fixture);
    const command = draw.commands[0];
    if (command?.kind !== "draw") throw new Error("Expected a draw fixture.");
    (command as Mutable<typeof command>).vertexCount = 0;
    await expect(prepareReflectedLayoutProbes({ ...base, fixture: draw })).rejects.toThrow(/not fetched/u);

    const range = clone(base.fixture);
    const rangeCommand = range.commands[0];
    if (rangeCommand?.kind !== "draw") throw new Error("Expected a draw fixture.");
    (rangeCommand.vertexBuffers[0] as Mutable<typeof rangeCommand.vertexBuffers[number]>).size = 8;
    await expect(prepareReflectedLayoutProbes({ ...base, fixture: range })).rejects.toThrow(/byte range exceeds/u);

    const changed = new Map(base.admitted.fileBytes);
    changed.set("data/vertex.bin", new Uint8Array(16));
    await expect(prepareReflectedLayoutProbes({
      admitted: { ...base.admitted, fileBytes: changed },
      unit: base.unit,
      fixture: base.fixture,
    })).rejects.toThrow(/GPUVertexFormat encoder/u);

    const stale = clone(base.fixture);
    (stale.readbacks[0] as Mutable<typeof stale.readbacks[number]>).expectedSha256 = ZERO_SHA;
    await expect(prepareReflectedLayoutProbes({ ...base, fixture: stale })).rejects.toThrow(/expected GPU-fetched value/u);
  });
});

describe("trusted final-WGSL reflection proof", () => {
  it("re-reflects exact modules, pipelines, overrides and compatible model fixtures", async () => {
    const admitted = await bindingAdmitted();
    const proof = await createTrustedReflectionProof(admitted);

    expect(proof.moduleSources.get("compute")).toBe(COMPUTE_WGSL);
    expect(proof.assemblySha256ByUnit.get("unit.main")).toMatch(/^[a-f0-9]{64}$/u);
    expect(proof.reflectionSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(unitModuleSources(admitted.manifest.inventory.compileUnits[0]!, proof)).toEqual([
      { moduleId: "compute", source: COMPUTE_WGSL },
    ]);
  });

  it("rejects missing and invalid final WGSL before producing proof", async () => {
    const admitted = await bindingAdmitted();
    const missing = new Map(admitted.fileBytes);
    missing.delete("wgsl/main.wgsl");
    await expect(createTrustedReflectionProof({ ...admitted, fileBytes: missing })).rejects.toThrow(/module compute is missing/u);

    const invalid = new Map(admitted.fileBytes);
    invalid.set("wgsl/main.wgsl", new TextEncoder().encode("not valid wgsl"));
    await expect(createTrustedReflectionProof({ ...admitted, fileBytes: invalid })).rejects.toThrow();
  });

  it("rejects compile-unit interface, pipeline, override and inventory drift", async () => {
    const admitted = await bindingAdmitted();

    const interfaceDrift = clone(admitted.manifest);
    (interfaceDrift.inventory.compileUnits[0] as Mutable<ShaderCompileUnitManifest>).interfaceRef = {
      ...admitted.shaderManifestCore.gpuInterface,
      interfaceVersion: "stale",
    };
    await expect(createTrustedReflectionProof({ ...admitted, manifest: interfaceDrift })).rejects.toThrow(/interface reference differs/u);

    const pipelineDrift = clone(admitted.manifest);
    const pipeline = pipelineDrift.inventory.compileUnits[0]!.pipelines[0];
    if (pipeline?.kind !== "compute") throw new Error("Expected compute pipeline.");
    (pipeline.compute as Mutable<typeof pipeline.compute>).entryPoint = "other";
    await expect(createTrustedReflectionProof({ ...admitted, manifest: pipelineDrift })).rejects.toThrow(/pipeline .* differs/u);

    const overrideDrift = clone(admitted.manifest);
    (overrideDrift.inventory.compileUnits[0] as Mutable<ShaderCompileUnitManifest>).overrideValues = { EXTRA: 1 };
    await expect(createTrustedReflectionProof({ ...admitted, manifest: overrideDrift })).rejects.toThrow(/override set differs/u);

    const missingUnit = clone(admitted.manifest);
    (missingUnit.inventory as Mutable<typeof missingUnit.inventory>).compileUnits = [];
    await expect(createTrustedReflectionProof({ ...admitted, manifest: missingUnit })).rejects.toThrow(/does not exercise every admitted shader pipeline/u);
  });

  it("rejects incompatible model fixtures and stale subject ABI sets", async () => {
    const admitted = await bindingAdmitted();
    const incompatible = clone([...admitted.modelFixtures.values()][0]!);
    (incompatible as Mutable<typeof incompatible>).providedSemantics = [];
    await expect(createTrustedReflectionProof({
      ...admitted,
      modelFixtures: new Map([["incompatible", incompatible]]),
    })).rejects.toThrow(/does not provide required semantic/u);

    const stale = clone(admitted.manifest);
    (stale.subject as Mutable<typeof stale.subject>).modelAbiHashes = [ZERO_SHA];
    await expect(createTrustedReflectionProof({ ...admitted, manifest: stale })).rejects.toThrow(/ABI set/u);
  });

  it("rejects a compile-unit module omitted from its reflected source map", async () => {
    const admitted = await bindingAdmitted();
    const unit = admitted.manifest.inventory.compileUnits[0]!;
    expect(() => unitModuleSources(unit, {
      moduleSources: new Map(),
      assemblySha256ByUnit: new Map(),
      reflectionSha256: ZERO_SHA,
      durationMs: 0,
    })).toThrow(/lacks reflected source/u);
  });
});
