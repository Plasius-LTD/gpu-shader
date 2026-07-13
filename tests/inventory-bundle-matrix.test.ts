import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import type {
  ShaderCompileUnitInventory,
  ShaderQualificationBundleManifest,
  ShaderQualificationFixtureManifest,
  StableWebGpuMatrixManifest,
} from "../src/contracts.js";
import {
  SUPPORTED_ADDITIVE_WEBGPU_MATRIX_POLICIES,
  SUPPORTED_STABLE_WEBGPU_MATRIX_POLICIES,
} from "../src/contracts.js";
import { canonicalizeGpuContract } from "../src/canonical-json.js";
import { computeSha256 } from "../src/hash.js";
import { validateCompileUnitInventory } from "../src/testing/inventory.js";
import { validateStableWebGpuMatrix } from "../src/testing/matrix.js";
import {
  validateQualificationBundleManifest,
  validateQualificationFixture,
} from "../src/testing/qualification-bundle.js";
import { createQualificationPreflight } from "../src/testing/evidence.js";
import {
  clone,
  qualificationBundle,
  ONE_SHA,
  provenance,
  validInventory,
  validQualificationFixture,
  validVertexInventory,
  validVertexQualificationFixture,
  ZERO_SHA,
} from "./fixtures.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

async function stableMatrix(): Promise<StableWebGpuMatrixManifest> {
  return JSON.parse(await readFile(
    new URL("../matrices/stable-webgpu-2026-07-13.json", import.meta.url),
    "utf8",
  )) as StableWebGpuMatrixManifest;
}

async function stableMatrixBytes(): Promise<Uint8Array> {
  return new Uint8Array(await readFile(
    new URL("../matrices/stable-webgpu-2026-07-13.json", import.meta.url),
  ));
}

describe("compile-unit inventory", () => {
  it("accepts a complete deterministic assembly inventory", () => {
    const result = validateCompileUnitInventory(validInventory());
    expect(result.ok).toBe(true);
  });

  it("fails every uncovered or mismatched WGSL fragment", () => {
    const uncovered = clone(validInventory());
    (uncovered as Mutable<ShaderCompileUnitInventory>).fragments = [
      ...uncovered.fragments,
      { fragmentId: "fragment.orphan", path: "wgsl/orphan.wgsl", sha256: ZERO_SHA },
    ];
    const result = validateCompileUnitInventory(uncovered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "uncovered-fragment" }));

    const mismatched = clone(validInventory());
    const assembly = mismatched.compileUnits[0]!.modules[0]!.assembly;
    (assembly as Mutable<typeof assembly>).fragmentIds = ["fragment.missing"];
    expect(validateCompileUnitInventory(mismatched).ok).toBe(false);
  });

  it.each([
    "/absolute/main.wgsl",
    "../escape.wgsl",
    "wgsl/../../escape.wgsl",
    "wgsl/executable.js",
  ])("rejects unsafe/non-WGSL fragment path %s", (path) => {
    const inventory = clone(validInventory());
    (inventory.fragments[0] as Mutable<typeof inventory.fragments[number]>).path = path;
    expect(validateCompileUnitInventory(inventory).ok).toBe(false);
  });

  it("requires every declared entry point to be used by an explicit valid pipeline", () => {
    const orphan = clone(validInventory());
    (orphan.compileUnits[0] as Mutable<typeof orphan.compileUnits[number]>).entryPoints = [
      ...orphan.compileUnits[0]!.entryPoints,
      { moduleId: "compute", name: "orphan", stage: "compute" },
    ];
    expect(validateCompileUnitInventory(orphan).ok).toBe(false);

    const missing = clone(validInventory());
    const pipeline = missing.compileUnits[0]!.pipelines[0]!;
    if (pipeline.kind !== "compute") throw new Error("Fixture pipeline must be compute.");
    (pipeline.compute as Mutable<typeof pipeline.compute>).entryPoint = "missing";
    expect(validateCompileUnitInventory(missing).ok).toBe(false);
  });

  it("rejects non-finite overrides, weak interface refs and unknown fields", () => {
    const override = clone(validInventory());
    (override.compileUnits[0]!.overrideValues as Record<string, number>).WORKGROUP_X = Number.NaN;
    expect(validateCompileUnitInventory(override).ok).toBe(false);

    const interfaceRef = clone(validInventory());
    (interfaceRef.compileUnits[0]!.interfaceRef as Mutable<typeof interfaceRef.compileUnits[number]["interfaceRef"]>).manifestUri = "http://not-secure.invalid/interface.json";
    expect(validateCompileUnitInventory(interfaceRef).ok).toBe(false);

    const extra = clone(validInventory()) as unknown as Record<string, unknown>;
    extra.manualLayout = { offset: 0 };
    expect(validateCompileUnitInventory(extra).ok).toBe(false);
  });
});

describe("declarative qualification fixture", () => {
  it("accepts a bounded dispatch, copy and semantic readback", () => {
    const fixture = validQualificationFixture();
    expect(validateQualificationFixture(fixture, validInventory().compileUnits[0]).ok).toBe(true);
  });

  it("accepts a schema-driven vertex-input byte-stream probe", () => {
    const fixture = validVertexQualificationFixture();
    const unit = validVertexInventory().compileUnits[0];
    expect(validateQualificationFixture(fixture, unit).ok).toBe(true);

    const staleSemantic = clone(fixture);
    const probe = staleSemantic.layoutProbes[0];
    if (probe?.kind !== "vertex-input") throw new Error("Fixture must contain a vertex-input probe.");
    (probe.source as Mutable<typeof probe.source>).semantic = "model.normal";
    expect(validateQualificationFixture(staleSemantic, unit).ok).toBe(false);
  });

  it("rejects vacuous fixtures without bounded execution or semantic readback", () => {
    const noCommands = clone(validQualificationFixture());
    (noCommands as Mutable<ShaderQualificationFixtureManifest>).commands = [];
    expect(validateQualificationFixture(noCommands, validInventory().compileUnits[0]).ok).toBe(false);

    const noReadback = clone(validQualificationFixture());
    (noReadback as Mutable<ShaderQualificationFixtureManifest>).readbacks = [];
    expect(validateQualificationFixture(noReadback, validInventory().compileUnits[0]).ok).toBe(false);

    const copiesOnly = clone(validQualificationFixture());
    (copiesOnly as Mutable<ShaderQualificationFixtureManifest>).commands = [copiesOnly.commands[1]!];
    expect(validateQualificationFixture(copiesOnly, validInventory().compileUnits[0]).ok).toBe(false);
  });

  it("rejects executable callbacks, unsupported operations and unknown fields", () => {
    const callback = { ...validQualificationFixture(), setup: "candidate.js" };
    expect(validateQualificationFixture(callback).ok).toBe(false);

    const operation = clone(validQualificationFixture()) as unknown as Record<string, unknown>;
    operation.commands = [{ kind: "execute-script", path: "candidate.js" }];
    expect(validateQualificationFixture(operation).ok).toBe(false);
  });

  it("cross-checks pipeline IDs, resource types, ranges and declared aggregate bounds", () => {
    const pipeline = clone(validQualificationFixture());
    const dispatch = pipeline.commands[0]!;
    if (dispatch.kind !== "dispatch") throw new Error("Fixture command must dispatch.");
    (dispatch as Mutable<typeof dispatch>).pipelineId = "missing";
    expect(validateQualificationFixture(pipeline, validInventory().compileUnits[0]).ok).toBe(false);

    const range = clone(validQualificationFixture());
    const entry = range.bindGroups[0]!.entries[0]!.resource;
    if (entry.kind !== "buffer") throw new Error("Fixture binding must be a buffer.");
    (entry as Mutable<typeof entry>).size = 113;
    expect(validateQualificationFixture(range).ok).toBe(false);

    const aggregate = clone(validQualificationFixture());
    (aggregate.bounds as Mutable<typeof aggregate.bounds>).maxBufferBytes = 112;
    expect(validateQualificationFixture(aggregate).ok).toBe(false);
  });

  it("rejects unsafe initial-data paths and candidate-provided code extensions", () => {
    for (const path of ["../model.bin", "/model.bin", "data/model.js", "data/model.sh"]) {
      const fixture = clone(validQualificationFixture());
      const buffer = fixture.resources[0];
      if (buffer?.kind !== "buffer" || !buffer.initialData) throw new Error("Fixture data missing.");
      (buffer.initialData as Mutable<typeof buffer.initialData>).path = path;
      expect(validateQualificationFixture(fixture).ok, path).toBe(false);
    }
  });
});

describe("qualification bundle closure", () => {
  it("accepts a data-only bundle with exact inventory/module/fixture identities", async () => {
    const bundle = await qualificationBundle(await stableMatrix());
    expect(validateQualificationBundleManifest(bundle).ok).toBe(true);
  });

  it("requires exact module closure across subject, bundle and compile units", async () => {
    const matrix = await stableMatrix();
    const missing = await qualificationBundle(matrix);
    (missing as Mutable<ShaderQualificationBundleManifest>).modules = [];
    expect(validateQualificationBundleManifest(missing).ok).toBe(false);

    const extra = await qualificationBundle(matrix);
    (extra as Mutable<ShaderQualificationBundleManifest>).modules = [
      ...extra.modules,
      { moduleId: "extra", path: "wgsl/extra.wgsl", sha256: ZERO_SHA },
    ];
    expect(validateQualificationBundleManifest(extra).ok).toBe(false);

    const subjectExtra = await qualificationBundle(matrix);
    (subjectExtra.subject as Mutable<typeof subjectExtra.subject>).modules = [
      ...subjectExtra.subject.modules,
      { moduleId: "extra", sha256: ZERO_SHA },
    ];
    expect(validateQualificationBundleManifest(subjectExtra).ok).toBe(false);
  });

  it("rejects stale fixtures, unsafe manifest paths and incomplete matrix cell claims", async () => {
    const matrix = await stableMatrix();
    const stale = await qualificationBundle(matrix);
    (stale.fixtures[0] as Mutable<typeof stale.fixtures[number]>).sha256 = ZERO_SHA;
    expect(validateQualificationBundleManifest(stale).ok).toBe(false);

    const executable = await qualificationBundle(matrix);
    (executable as Mutable<ShaderQualificationBundleManifest>).shaderManifestCorePath = "candidate.js";
    expect(validateQualificationBundleManifest(executable).ok).toBe(false);

    const cells = await qualificationBundle(matrix);
    (cells.subject as Mutable<typeof cells.subject>).requiredCellIds = cells.subject.requiredCellIds.slice(1);
    expect(validateQualificationBundleManifest(cells).ok).toBe(true);
    const matrixBytes = await stableMatrixBytes();
    await expect(createQualificationPreflight({
      qualificationId: "qualification.cells",
      bundle: cells,
      matrix,
      matrixBytes,
      sourceUri: "https://account.blob.core.windows.net/candidates/candidate.tar?versionid=one",
      dataBundleSha256: ZERO_SHA,
      matrixSha256: await computeSha256(matrixBytes),
      harnessSha256: ONE_SHA,
      provenance: provenance(),
    })).rejects.toThrow(/cell set differs/u);
  });
});

describe("stable WebGPU support matrix", () => {
  it("accepts the exact versioned 15-physical + SwiftShader baseline", async () => {
    const matrix = await stableMatrix();
    const matrixBytes = await stableMatrixBytes();
    const policy = SUPPORTED_STABLE_WEBGPU_MATRIX_POLICIES[0];
    const result = validateStableWebGpuMatrix(matrix);
    expect(result.ok).toBe(true);
    expect(new TextDecoder().decode(matrixBytes)).toBe(canonicalizeGpuContract(matrix));
    expect({
      matrixId: matrix.matrixId,
      matrixVersion: matrix.version,
      matrixSha256: await computeSha256(matrixBytes),
    }).toEqual(policy);
    expect(matrix.cells.filter((cell) => cell.adapter.kind === "physical")).toHaveLength(15);
    expect(matrix.cells.filter((cell) => cell.adapter.kind === "software")).toHaveLength(1);
    expect(matrix.cells.every((cell) => cell.blocking)).toBe(true);
  });

  it("keeps the parser's accepted universal matrix policy immutable at runtime", () => {
    const policies = SUPPORTED_STABLE_WEBGPU_MATRIX_POLICIES as unknown as Array<{
      matrixId: string;
      matrixVersion: string;
      matrixSha256: string;
    }>;
    expect(Object.isFrozen(policies)).toBe(true);
    expect(Object.isFrozen(policies[0])).toBe(true);
    expect(() => { policies[0]!.matrixSha256 = ZERO_SHA; }).toThrow(TypeError);
    expect(() => { policies.push({ matrixId: "forged", matrixVersion: "1", matrixSha256: ZERO_SHA }); }).toThrow(TypeError);
    expect(SUPPORTED_STABLE_WEBGPU_MATRIX_POLICIES[0]!.matrixSha256).toBe(
      "4620eca44fd03004ee7650cfe9fcf42934493611a5097da5525f71578980b016",
    );
  });

  it("fails closed with an immutable empty additive-policy registry", () => {
    expect(SUPPORTED_ADDITIVE_WEBGPU_MATRIX_POLICIES).toEqual([]);
    expect(Object.isFrozen(SUPPORTED_ADDITIVE_WEBGPU_MATRIX_POLICIES)).toBe(true);
    expect(() => {
      (SUPPORTED_ADDITIVE_WEBGPU_MATRIX_POLICIES as unknown[]).push({
        scope: "forged",
        matrixId: "forged",
        matrixVersion: "1",
        matrixSha256: ZERO_SHA,
      });
    }).toThrow(TypeError);
  });

  it("fails closed for missing/reordered/duplicated cells and weakened policy", async () => {
    const relabelled = clone(await stableMatrix());
    (relabelled as Mutable<StableWebGpuMatrixManifest>).matrixId = "webgpu-xr";
    expect(validateStableWebGpuMatrix(relabelled).ok).toBe(false);

    const missing = clone(await stableMatrix());
    (missing as Mutable<StableWebGpuMatrixManifest>).cells = missing.cells.slice(1);
    expect(validateStableWebGpuMatrix(missing).ok).toBe(false);

    const reordered = clone(await stableMatrix());
    (reordered as Mutable<StableWebGpuMatrixManifest>).cells = [
      reordered.cells[1]!,
      reordered.cells[0]!,
      ...reordered.cells.slice(2),
    ];
    expect(validateStableWebGpuMatrix(reordered).ok).toBe(false);

    const weakened = clone(await stableMatrix());
    (weakened.policy as Mutable<typeof weakened.policy>).unavailable = "fail";
    (weakened.cells[0] as Mutable<typeof weakened.cells[number]>).blocking = false;
    expect(validateStableWebGpuMatrix(weakened).ok).toBe(false);
  });

  it("rejects runner-label substitution and software lanes masquerading as physical support", async () => {
    const labels = clone(await stableMatrix());
    (labels.cells[0] as Mutable<typeof labels.cells[number]>).runnerLabels = ["ubuntu-latest"];
    expect(validateStableWebGpuMatrix(labels).ok).toBe(false);

    const swift = clone(await stableMatrix());
    const software = swift.cells.find((cell) => cell.adapter.kind === "software")!;
    (software as Mutable<typeof software>).countsTowardStableCoverage = true;
    expect(validateStableWebGpuMatrix(swift).ok).toBe(false);
  });
});
