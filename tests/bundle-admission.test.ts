import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalizeGpuContract } from "../src/canonical-json.js";
import {
  SHADER_COMPILE_UNIT_VERSION,
  SHADER_QUALIFICATION_BUNDLE_VERSION,
  SHADER_QUALIFICATION_FIXTURE_VERSION,
  type GpuInterfaceManifest,
  type ShaderQualificationBundleManifest,
  type ShaderQualificationFixtureManifest,
  type ShaderVersionManifestCore,
  type ShaderVersionManifest,
  type StableWebGpuMatrixManifest,
} from "../src/contracts.js";
import {
  computeGpuAbiHash,
  computeShaderManifestCoreSha256,
  computeSha256,
} from "../src/hash.js";
import { admitQualificationBundle } from "../src/node/bundle-admission.js";
import {
  clone,
  COMPUTE_WGSL,
  computePipeline,
  shaderAssets,
  validQualificationFixture,
  ZERO_SHA,
} from "./fixtures.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeBytes(root: string, path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), bytes);
}

async function writeJson(root: string, path: string, value: unknown): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(canonicalizeGpuContract(value));
  await writeBytes(root, path, bytes);
  return bytes;
}

async function matrix(): Promise<StableWebGpuMatrixManifest> {
  return JSON.parse(await readFile(
    new URL("../matrices/stable-webgpu-2026-07-13.json", import.meta.url),
    "utf8",
  )) as StableWebGpuMatrixManifest;
}

async function createBundleDirectory() {
  const root = await mkdtemp(join(tmpdir(), "gpu-shader-bundle-"));
  roots.push(root);
  const assets = await shaderAssets();
  const moduleBytes = new TextEncoder().encode(COMPUTE_WGSL);
  const moduleSha = await computeSha256(moduleBytes);
  await writeBytes(root, "fragments/main.wgsl", moduleBytes);
  await writeBytes(root, "modules/compute.wgsl", moduleBytes);

  const dataBytes = new Uint8Array(112);
  const dataSha = await computeSha256(dataBytes);
  await writeBytes(root, "data/model.bin", dataBytes);
  const fixture = clone(validQualificationFixture());
  const firstResource = fixture.resources[0];
  if (firstResource?.kind !== "buffer" || !firstResource.initialData) throw new Error("Fixture initial data missing.");
  (firstResource.initialData as Mutable<typeof firstResource.initialData>).sha256 = dataSha;
  const fixtureBytes = await writeJson(root, "fixtures/main.json", fixture);
  const fixtureSha = await computeSha256(fixtureBytes);

  const interfaceBytes = await writeJson(root, "manifests/interface.json", assets.gpuInterface);
  const interfaceSha = await computeSha256(interfaceBytes);
  const modelFixture = {
    contractVersion: SHADER_QUALIFICATION_FIXTURE_VERSION,
    fixtureId: "model.fixture",
    model: assets.model,
  };
  const modelBytes = await writeJson(root, "fixtures/model.json", modelFixture);
  const modelSha = await computeSha256(modelBytes);

  const shaderCore: Omit<ShaderVersionManifest, "validationEvidence" | "additionalValidationEvidence"> = {
    contractVersion: assets.shaderManifest.contractVersion,
    shaderId: assets.shaderManifest.shaderId,
    version: assets.shaderManifest.version,
    modules: assets.shaderManifest.modules,
    gpuInterface: assets.shaderManifest.gpuInterface,
    pipelines: assets.shaderManifest.pipelines,
    renderRoles: assets.shaderManifest.renderRoles,
    compatibleModelInterfaces: assets.shaderManifest.compatibleModelInterfaces,
    requirements: assets.shaderManifest.requirements,
    shaderAbiHash: assets.shaderManifest.shaderAbiHash,
  };
  await writeJson(root, "manifests/shader-core.json", shaderCore);
  const coreSha = await computeShaderManifestCoreSha256(assets.shaderManifest);

  const inventory = {
    contractVersion: SHADER_COMPILE_UNIT_VERSION,
    fragments: [{ fragmentId: "fragment.main", path: "fragments/main.wgsl", sha256: moduleSha }],
    compileUnits: [{
      contractVersion: SHADER_COMPILE_UNIT_VERSION,
      compileUnitId: "unit.main",
      fragmentIds: ["fragment.main"],
      modules: [{
        moduleId: "compute",
        sha256: moduleSha,
        assembly: { kind: "concat-v1" as const, fragmentIds: ["fragment.main"] },
      }],
      entryPoints: [{ moduleId: "compute", name: "main", stage: "compute" as const }],
      pipelines: [computePipeline()],
      interfaceRef: assets.interfaceRef,
      overrideValues: {},
      qualificationFixture: { fixtureId: "fixture.main", path: "fixtures/main.json", sha256: fixtureSha },
    }],
  };
  const inventorySha = await computeSha256(canonicalizeGpuContract(inventory));
  const stable = await matrix();
  const manifest: ShaderQualificationBundleManifest = {
    contractVersion: SHADER_QUALIFICATION_BUNDLE_VERSION,
    inventory,
    subject: {
      shaderManifestCore: { shaderId: assets.shaderManifest.shaderId, version: assets.shaderManifest.version, sha256: coreSha },
      compileUnitInventorySha256: inventorySha,
      shaderAbiHash: assets.shaderManifest.shaderAbiHash,
      interfaceManifestSha256: interfaceSha,
      modelAbiHashes: [assets.model.modelAbiHash],
      modules: [{ moduleId: "compute", sha256: moduleSha }],
      requiredCompileUnitIds: ["unit.main"],
      requiredCellIds: stable.cells.map((cell) => cell.cellId),
    },
    shaderManifestCorePath: "manifests/shader-core.json",
    gpuInterfaceManifest: { path: "manifests/interface.json", sha256: interfaceSha },
    modelCompatibilityFixtures: [{ fixtureId: "model.fixture", path: "fixtures/model.json", sha256: modelSha }],
    modules: [{ moduleId: "compute", path: "modules/compute.wgsl", sha256: moduleSha }],
    fixtures: [{ fixtureId: "fixture.main", path: "fixtures/main.json", sha256: fixtureSha, kind: "qualification-fixture" }],
  };
  await writeJson(root, "qualification.json", manifest);
  return { root, manifest, assets, fixture, modelFixture, shaderCore };
}

async function addPaddedTextureUpload(
  bundle: Awaited<ReturnType<typeof createBundleDirectory>>,
  byteLength: number,
): Promise<void> {
  const textureBytes = new Uint8Array(byteLength);
  const textureSha = await computeSha256(textureBytes);
  await writeBytes(bundle.root, "data/color.bin", textureBytes);
  const fixture = clone(bundle.fixture) as Mutable<ShaderQualificationFixtureManifest>;
  fixture.resources = [
    ...fixture.resources,
    {
      kind: "texture",
      resourceId: "color",
      dimension: "2d",
      size: [4, 2, 2],
      mipLevelCount: 1,
      sampleCount: 1,
      format: "rgba8unorm",
      usage: ["copy-dst"],
      initialData: {
        path: "data/color.bin",
        sha256: textureSha,
        bytesPerRow: 256,
        rowsPerImage: 3,
        mipLevel: 0,
        origin: [0, 0, 0],
        aspect: "all",
      },
    },
  ];
  fixture.bounds = { ...fixture.bounds, maxTextureTexels: 16 };
  const fixtureBytes = await writeJson(bundle.root, "fixtures/main.json", fixture);
  const fixtureSha = await computeSha256(fixtureBytes);
  const manifest = clone(bundle.manifest) as Mutable<ShaderQualificationBundleManifest>;
  const unit = manifest.inventory.compileUnits[0];
  const fixtureRef = manifest.fixtures[0];
  if (!unit || !fixtureRef) throw new Error("Bundle fixture references are missing.");
  (unit.qualificationFixture as Mutable<typeof unit.qualificationFixture>).sha256 = fixtureSha;
  (fixtureRef as Mutable<typeof fixtureRef>).sha256 = fixtureSha;
  (manifest.subject as Mutable<typeof manifest.subject>).compileUnitInventorySha256 = await computeSha256(canonicalizeGpuContract(manifest.inventory));
  await writeJson(bundle.root, "qualification.json", manifest);
}

async function replaceInterfaceClaim(
  bundle: Awaited<ReturnType<typeof createBundleDirectory>>,
  forgedInterface: GpuInterfaceManifest,
): Promise<void> {
  const interfaceBytes = await writeJson(bundle.root, "manifests/interface.json", forgedInterface);
  const interfaceSha = await computeSha256(interfaceBytes);
  const interfaceRef = {
    ...bundle.assets.interfaceRef,
    manifestSha256: interfaceSha,
    interfaceAbiHash: forgedInterface.interfaceAbiHash,
    modelAbiHash: forgedInterface.modelAbiHash,
  };
  const shaderCore = clone(bundle.shaderCore) as Mutable<ShaderVersionManifestCore>;
  shaderCore.gpuInterface = interfaceRef;
  shaderCore.compatibleModelInterfaces = shaderCore.compatibleModelInterfaces.map((compatible) => ({
    ...compatible,
    manifestSha256: interfaceSha,
    interfaceAbiHash: forgedInterface.interfaceAbiHash,
    modelAbiHash: forgedInterface.modelAbiHash,
  }));
  shaderCore.shaderAbiHash = await computeGpuAbiHash({
    kind: "shader",
    interface: forgedInterface,
    pipelines: shaderCore.pipelines,
    requirements: shaderCore.requirements,
  });
  await writeJson(bundle.root, "manifests/shader-core.json", shaderCore);

  const modelFixture = clone(bundle.modelFixture);
  (modelFixture.model as Mutable<typeof modelFixture.model>).gpuInterface = interfaceRef;
  (modelFixture.model as Mutable<typeof modelFixture.model>).modelAbiHash = forgedInterface.modelAbiHash;
  const modelBytes = await writeJson(bundle.root, "fixtures/model.json", modelFixture);
  const modelSha = await computeSha256(modelBytes);

  const qualification = clone(bundle.manifest) as Mutable<ShaderQualificationBundleManifest>;
  qualification.gpuInterfaceManifest = {
    ...qualification.gpuInterfaceManifest,
    sha256: interfaceSha,
  };
  qualification.modelCompatibilityFixtures = qualification.modelCompatibilityFixtures.map((fixture) => ({
    ...fixture,
    sha256: fixture.fixtureId === modelFixture.fixtureId ? modelSha : fixture.sha256,
  }));
  qualification.inventory = {
    ...qualification.inventory,
    compileUnits: qualification.inventory.compileUnits.map((unit) => ({
      ...unit,
      interfaceRef,
    })),
  };
  qualification.subject = {
    ...qualification.subject,
    shaderManifestCore: {
      ...qualification.subject.shaderManifestCore,
      sha256: await computeShaderManifestCoreSha256(shaderCore),
    },
    compileUnitInventorySha256: await computeSha256(canonicalizeGpuContract(qualification.inventory)),
    shaderAbiHash: shaderCore.shaderAbiHash,
    interfaceManifestSha256: interfaceSha,
    modelAbiHashes: [forgedInterface.modelAbiHash],
  };
  await writeJson(bundle.root, "qualification.json", qualification);
}

describe("data-only qualification bundle admission", () => {
  it("recomputes complete file closure, deterministic assembly and manifest/model identities", async () => {
    const fixture = await createBundleDirectory();
    const admitted = await admitQualificationBundle(fixture.root);
    expect(admitted.root).toBe(fixture.root);
    expect(admitted.manifest).toEqual(fixture.manifest);
    expect(admitted.shaderManifestCore.shaderId).toBe(fixture.assets.shaderManifest.shaderId);
    expect(admitted.shaderManifestCore).not.toHaveProperty("validationEvidence");
    expect(admitted.gpuInterface).toEqual(fixture.assets.gpuInterface);
    expect(admitted.fixtures.get("fixture.main")).toEqual(fixture.fixture);
    expect(admitted.modelFixtures.get("model.fixture")).toEqual(fixture.assets.model);
    expect(admitted.fileBytes.size).toBe(8);
  });

  it("rejects modified/missing module and fixture bytes", async () => {
    const modified = await createBundleDirectory();
    await writeFile(join(modified.root, "modules/compute.wgsl"), "modified");
    await expect(admitQualificationBundle(modified.root)).rejects.toThrow(/module.*differs|digest differs/u);

    const missing = await createBundleDirectory();
    await rm(join(missing.root, "fixtures/main.json"));
    await expect(admitQualificationBundle(missing.root)).rejects.toThrow(/missing/u);
  });

  it("admits padded texture data within the WebGPU last-row/last-image capacity bounds", async () => {
    const minimallyCovered = await createBundleDirectory();
    await addPaddedTextureUpload(minimallyCovered, 1040);
    await expect(admitQualificationBundle(minimallyCovered.root)).resolves.toMatchObject({ root: minimallyCovered.root });

    const fullyPadded = await createBundleDirectory();
    await addPaddedTextureUpload(fullyPadded, 1536);
    await expect(admitQualificationBundle(fullyPadded.root)).resolves.toMatchObject({ root: fullyPadded.root });
  });

  it("rejects texture data below required capacity or beyond its declared padded layout", async () => {
    const truncated = await createBundleDirectory();
    await addPaddedTextureUpload(truncated, 1039);
    await expect(admitQualificationBundle(truncated.root)).rejects.toThrow(/outside.*row\/image capacity/u);

    const oversized = await createBundleDirectory();
    await addPaddedTextureUpload(oversized, 1537);
    await expect(admitQualificationBundle(oversized.root)).rejects.toThrow(/outside.*row\/image capacity/u);
  });

  it("rejects undeclared, executable and symbolic-link files", async () => {
    const undeclared = await createBundleDirectory();
    await writeFile(join(undeclared.root, "surprise.txt"), "surprise");
    await expect(admitQualificationBundle(undeclared.root)).rejects.toThrow(/undeclared files/u);

    const executable = await createBundleDirectory();
    await chmod(join(executable.root, "modules/compute.wgsl"), 0o755);
    await expect(admitQualificationBundle(executable.root)).rejects.toThrow(/executable/u);

    const linked = await createBundleDirectory();
    await symlink("modules/compute.wgsl", join(linked.root, "linked.wgsl"));
    await expect(admitQualificationBundle(linked.root)).rejects.toThrow(/symbolic link/u);
  });

  it("rejects a shader core containing evidence or a stale core identity", async () => {
    const embedded = await createBundleDirectory();
    await writeJson(embedded.root, "manifests/shader-core.json", {
      ...embedded.shaderCore,
      validationEvidence: embedded.assets.shaderManifest.validationEvidence,
    });
    await expect(admitQualificationBundle(embedded.root)).rejects.toThrow(/not contain validationEvidence/u);

    const stale = await createBundleDirectory();
    const qualification = clone(stale.manifest);
    (qualification.subject.shaderManifestCore as Mutable<typeof qualification.subject.shaderManifestCore>).sha256 = ZERO_SHA;
    await writeJson(stale.root, "qualification.json", qualification);
    await expect(admitQualificationBundle(stale.root)).rejects.toThrow(/core identity|digest differs/u);
  });

  it("rejects a fully rehashed interface claim that differs from exact final WGSL reflection", async () => {
    const bundle = await createBundleDirectory();
    const forged = clone(bundle.assets.gpuInterface) as Mutable<GpuInterfaceManifest>;
    const record = forged.records.find((candidate) => candidate.name === "ModelData");
    if (!record) throw new Error("ModelData reflection fixture is missing.");
    (record as Mutable<typeof record>).addressSpaces = [...record.addressSpaces, "uniform"];
    forged.modelAbiHash = await computeGpuAbiHash({ kind: "model", interface: forged });
    forged.interfaceAbiHash = await computeGpuAbiHash({ kind: "interface", interface: forged });
    await replaceInterfaceClaim(bundle, forged);

    await expect(admitQualificationBundle(bundle.root)).rejects.toThrow(/regenerated final WGSL reflection/u);
  });

  it("rejects a self-consistent shader ABI hash not regenerated from the exact interface and pipelines", async () => {
    const bundle = await createBundleDirectory();
    const shaderCore = clone(bundle.shaderCore) as Mutable<ShaderVersionManifestCore>;
    shaderCore.shaderAbiHash = ZERO_SHA;
    await writeJson(bundle.root, "manifests/shader-core.json", shaderCore);
    const qualification = clone(bundle.manifest) as Mutable<ShaderQualificationBundleManifest>;
    qualification.subject = {
      ...qualification.subject,
      shaderAbiHash: ZERO_SHA,
      shaderManifestCore: {
        ...qualification.subject.shaderManifestCore,
        sha256: await computeShaderManifestCoreSha256(shaderCore),
      },
    };
    await writeJson(bundle.root, "qualification.json", qualification);

    await expect(admitQualificationBundle(bundle.root)).rejects.toThrow(/shader ABI hash differs from regenerated/iu);
  });

  it("rejects compile-unit pipeline data that differs from the ABI-hashed shader pipeline", async () => {
    const bundle = await createBundleDirectory();
    const qualification = clone(bundle.manifest) as Mutable<ShaderQualificationBundleManifest>;
    const unit = clone(qualification.inventory.compileUnits[0]!);
    const pipeline = unit.pipelines[0];
    if (pipeline?.kind !== "compute") throw new Error("Compute pipeline fixture is missing.");
    (pipeline.compute as Mutable<typeof pipeline.compute>).constants = { WORKGROUP_X: 1 };
    (unit as Mutable<typeof unit>).overrideValues = { WORKGROUP_X: 1 };
    qualification.inventory = {
      ...qualification.inventory,
      compileUnits: [unit],
    };
    qualification.subject = {
      ...qualification.subject,
      compileUnitInventorySha256: await computeSha256(canonicalizeGpuContract(qualification.inventory)),
    };
    await writeJson(bundle.root, "qualification.json", qualification);

    await expect(admitQualificationBundle(bundle.root)).rejects.toThrow(/pipeline .* differs from the shader manifest core/u);
  });

  it("rejects compile-unit interface drift and ABI-hashed pipelines omitted from qualification", async () => {
    const interfaceDrift = await createBundleDirectory();
    const interfaceQualification = clone(interfaceDrift.manifest) as Mutable<ShaderQualificationBundleManifest>;
    const interfaceUnit = clone(interfaceQualification.inventory.compileUnits[0]!);
    (interfaceUnit as Mutable<typeof interfaceUnit>).interfaceRef = {
      ...interfaceUnit.interfaceRef,
      interfaceVersion: "stale",
    };
    interfaceQualification.inventory = {
      ...interfaceQualification.inventory,
      compileUnits: [interfaceUnit],
    };
    interfaceQualification.subject = {
      ...interfaceQualification.subject,
      compileUnitInventorySha256: await computeSha256(canonicalizeGpuContract(interfaceQualification.inventory)),
    };
    await writeJson(interfaceDrift.root, "qualification.json", interfaceQualification);
    await expect(admitQualificationBundle(interfaceDrift.root)).rejects.toThrow(/interface reference differs from the shader manifest core/u);

    const omittedPipeline = await createBundleDirectory();
    const shaderCore = clone(omittedPipeline.shaderCore) as Mutable<ShaderVersionManifestCore>;
    const secondPipeline = clone(shaderCore.pipelines[0]!);
    (secondPipeline as Mutable<typeof secondPipeline>).pipelineId = "model.compute.secondary";
    shaderCore.pipelines = [...shaderCore.pipelines, secondPipeline];
    shaderCore.renderRoles = shaderCore.renderRoles.map((role) => ({
      ...role,
      pipelineIds: [...role.pipelineIds, secondPipeline.pipelineId],
    }));
    shaderCore.shaderAbiHash = await computeGpuAbiHash({
      kind: "shader",
      interface: omittedPipeline.assets.gpuInterface,
      pipelines: shaderCore.pipelines,
      requirements: shaderCore.requirements,
    });
    await writeJson(omittedPipeline.root, "manifests/shader-core.json", shaderCore);
    const omittedQualification = clone(omittedPipeline.manifest) as Mutable<ShaderQualificationBundleManifest>;
    omittedQualification.subject = {
      ...omittedQualification.subject,
      shaderAbiHash: shaderCore.shaderAbiHash,
      shaderManifestCore: {
        ...omittedQualification.subject.shaderManifestCore,
        sha256: await computeShaderManifestCoreSha256(shaderCore),
      },
    };
    await writeJson(omittedPipeline.root, "qualification.json", omittedQualification);
    await expect(admitQualificationBundle(omittedPipeline.root)).rejects.toThrow(/does not exercise every shader manifest core pipeline/u);
  });

  it("rejects model fixtures that disagree with the reflected interface", async () => {
    const fixture = await createBundleDirectory();
    const modelFixture = clone(fixture.modelFixture);
    (modelFixture.model as Mutable<typeof modelFixture.model>).modelAbiHash = ZERO_SHA;
    const bytes = await writeJson(fixture.root, "fixtures/model.json", modelFixture);
    const qualification = clone(fixture.manifest);
    (qualification.modelCompatibilityFixtures[0] as Mutable<typeof qualification.modelCompatibilityFixtures[number]>).sha256 = await computeSha256(bytes);
    await writeJson(fixture.root, "qualification.json", qualification);
    await expect(admitQualificationBundle(fixture.root)).rejects.toThrow(/differs from (?:modelAbiHash|GPU interface)/u);
  });

  it("strictly rejects unknown model-fixture fields and forged nested interface claims", async () => {
    const cases: ((fixture: Awaited<ReturnType<typeof createBundleDirectory>>["modelFixture"]) => void)[] = [
      (fixture) => { (fixture as unknown as Record<string, unknown>).manualLayout = { offset: 0 }; },
      (fixture) => {
        (fixture.model as Mutable<typeof fixture.model>).providedSemantics = [
          ...fixture.model.providedSemantics,
          fixture.model.providedSemantics[0]!,
        ];
      },
      (fixture) => { (fixture.model.gpuInterface as Mutable<typeof fixture.model.gpuInterface>).modelAbiHash = ZERO_SHA; },
      (fixture) => { (fixture.model.gpuInterface as Mutable<typeof fixture.model.gpuInterface>).interfaceId = "interface.unadvertised"; },
    ];
    for (const mutate of cases) {
      const bundle = await createBundleDirectory();
      const modelFixture = clone(bundle.modelFixture);
      mutate(modelFixture);
      const bytes = await writeJson(bundle.root, "fixtures/model.json", modelFixture);
      const qualification = clone(bundle.manifest);
      (qualification.modelCompatibilityFixtures[0] as Mutable<typeof qualification.modelCompatibilityFixtures[number]>).sha256 = await computeSha256(bytes);
      await writeJson(bundle.root, "qualification.json", qualification);
      await expect(admitQualificationBundle(bundle.root)).rejects.toThrow(/model compatibility fixture|GPU interface|not part|duplicate|modelAbiHash|compatible model interface/u);
    }
  });

  it("requires an extracted regular directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "gpu-shader-file-"));
    roots.push(root);
    const file = join(root, "bundle.tar");
    await writeFile(file, "not a directory");
    await expect(admitQualificationBundle(file)).rejects.toThrow(/regular directory/u);
  });
});
