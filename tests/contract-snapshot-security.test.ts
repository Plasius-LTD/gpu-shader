import { inspect } from "node:util";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import {
  canonicalizeGpuContract,
  GPU_CONTRACT_SNAPSHOT_LIMITS,
  parseCanonicalJson,
  type GpuContractSnapshotLimits,
  snapshotGpuContract,
  snapshotUint8Array,
} from "../src/canonical-json.js";
import {
  SHADER_QUALIFICATION_FIXTURE_VERSION,
  SHADER_VALIDATION_EVIDENCE_VERSION,
  type ShaderValidationEvidenceAttestationRef,
  type StableWebGpuMatrixManifest,
} from "../src/contracts.js";
import {
  parseGpuInterfaceManifest,
  parseJsonBytes,
  parseModelGpuCompatibilityDescriptor,
  parseSerializableGpuPipelineDescriptors,
  parseShaderQualificationModelCompatibilityFixture,
  parseShaderStyleProfileManifest,
  parseShaderVersionManifest,
  parseShaderVersionManifestCore,
} from "../src/manifest-validation.js";
import {
  aggregateShaderValidationEvidence,
  parseQualificationExecutionProducer,
  parseShaderValidationEvidenceAttestationRef,
  parseTrustedWorkflowProvenance,
  validateShaderValidationEvidence,
} from "../src/testing/evidence.js";
import { validateCompileUnitInventory } from "../src/testing/inventory.js";
import { validateStableWebGpuMatrix } from "../src/testing/matrix.js";
import {
  validateQualificationBundleManifest,
  validateQualificationFixture,
} from "../src/testing/qualification-bundle.js";
import {
  clone,
  evidenceScenario,
  executionProducer,
  provenance,
  qualificationBundle,
  shaderAssets,
  validInventory,
  validQualificationFixture,
} from "./fixtures.js";

function capture(operation: () => unknown): Error {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error) return error;
    // eslint-disable-next-line preserve-caught-error -- the helper must not retain an arbitrary thrown test value
    throw new Error("Contract rejection did not use an Error instance.");
  }
  throw new Error("Expected contract parsing to fail closed.");
}

function limits(overrides: Partial<GpuContractSnapshotLimits>): GpuContractSnapshotLimits {
  return { ...GPU_CONTRACT_SNAPSHOT_LIMITS, ...overrides };
}

function accessorAt(value: object, key: PropertyKey, returned: unknown): () => number {
  let reads = 0;
  Object.defineProperty(value, key, {
    configurable: true,
    enumerable: true,
    get() {
      reads += 1;
      return returned;
    },
  });
  return () => reads;
}

function firstNestedTarget(value: object): { readonly target: object; readonly key: PropertyKey; readonly returned: unknown } {
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    const child = descriptor?.value;
    if (typeof child !== "object" || child === null) continue;
    const childKey = Reflect.ownKeys(child)[0];
    if (childKey === undefined) continue;
    return {
      target: child,
      key: childKey,
      returned: Reflect.getOwnPropertyDescriptor(child, childKey)?.value,
    };
  }
  throw new Error("Fixture does not contain a nested snapshot target.");
}

async function stableMatrix(): Promise<StableWebGpuMatrixManifest> {
  return JSON.parse(await readFile(
    new URL("../matrices/stable-webgpu-2026-07-13.json", import.meta.url),
    "utf8",
  )) as StableWebGpuMatrixManifest;
}

describe("bounded own-data contract snapshots", () => {
  it("rejects a returning nested accessor without invoking it", async () => {
    const { model } = await shaderAssets();
    const input = clone(model);
    let reads = 0;
    Object.defineProperty(input.gpuInterface, "interfaceId", {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return model.gpuInterface.interfaceId;
      },
    });

    const error = capture(() => parseModelGpuCompatibilityDescriptor(input));

    expect(reads).toBe(0);
    expect(error.message).toBe("ModelGpuCompatibilityDescriptor must contain bounded detached JSON contract data. GPU contract snapshot requires plain JSON objects with own enumerable data properties and dense arrays.");
    expect(Object.hasOwn(error, "cause")).toBe(false);
  });

  it("redacts a throwing nested accessor from every public error representation", async () => {
    const secret = "provider-secret-that-must-not-leak";
    const { model } = await shaderAssets();
    const input = clone(model);
    let reads = 0;
    Object.defineProperty(input.gpuInterface, "interfaceId", {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        throw new Error(secret);
      },
    });

    const error = capture(() => parseModelGpuCompatibilityDescriptor(input));
    const representations = [
      error.message,
      String(error),
      error.stack ?? "",
      inspect(error),
      JSON.stringify(error),
    ];

    expect(reads).toBe(0);
    expect(representations.every((value) => !value.includes(secret))).toBe(true);
    expect(Object.hasOwn(error, "cause")).toBe(false);
  });

  it("never invokes a proxy get trap and sanitizes unavoidable reflection traps", () => {
    let gets = 0;
    const plain = new Proxy({ value: 1 }, {
      get() {
        gets += 1;
        throw new Error("get-trap-secret");
      },
    });
    expect(snapshotGpuContract(plain)).toEqual({ value: 1 });
    expect(gets).toBe(0);

    for (const trap of ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"] as const) {
      const secret = `proxy-${trap}-secret`;
      const proxy = new Proxy({ value: 1 }, {
        [trap]() {
          throw new Error(secret);
        },
      });
      const error = capture(() => snapshotGpuContract(proxy));
      expect(error.message).toBe("GPU contract snapshot rejected unsafe object inspection.");
      expect(inspect(error)).not.toContain(secret);
      expect(Object.hasOwn(error, "cause")).toBe(false);
    }

    const nonErrorSecret = "proxy-non-error-secret";
    const nonErrorProxy = new Proxy({}, { ownKeys: () => { throw nonErrorSecret; } });
    expect(inspect(capture(() => snapshotGpuContract(nonErrorProxy)))).not.toContain(nonErrorSecret);

    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expect(() => snapshotGpuContract(revocable.proxy)).toThrow("GPU contract snapshot rejected unsafe object inspection.");
  });

  it("rejects accessors, non-enumerable/symbol fields, sparse arrays, and custom array fields", () => {
    const accessor = { value: 1 };
    const reads = accessorAt(accessor, "value", 1);
    expect(() => snapshotGpuContract(accessor)).toThrow(/own enumerable data properties/u);
    expect(reads()).toBe(0);

    const hidden = {};
    Object.defineProperty(hidden, "value", { enumerable: false, value: 1 });
    expect(() => snapshotGpuContract(hidden)).toThrow(/own enumerable data properties/u);

    expect(() => snapshotGpuContract({ [Symbol("hidden")]: true })).toThrow(/own enumerable data properties/u);
    expect(() => snapshotGpuContract(new Array(2))).toThrow(/dense arrays/u);

    const custom = [1];
    Object.defineProperty(custom, "metadata", { enumerable: true, value: true });
    expect(() => snapshotGpuContract(custom)).toThrow(/dense arrays/u);

    const arrayAccessor = [1];
    const arrayReads = accessorAt(arrayAccessor, 0, 1);
    expect(() => snapshotGpuContract(arrayAccessor)).toThrow(/dense arrays/u);
    expect(arrayReads()).toBe(0);

    class BehavioralArray extends Array<number> {}
    expect(() => snapshotGpuContract(new BehavioralArray(1))).toThrow(/plain JSON objects/u);

    let inheritedReads = 0;
    class BehavioralObject {
      get value(): number {
        inheritedReads += 1;
        return 1;
      }
    }
    expect(() => snapshotGpuContract(new BehavioralObject())).toThrow(/plain JSON objects/u);
    expect(inheritedReads).toBe(0);
  });

  it("enforces every structural and byte counter with fixed diagnostics", () => {
    const cases: readonly [unknown, Partial<GpuContractSnapshotLimits>, string][] = [
      [{ child: { child: null } }, { maximumDepth: 1 }, "GPU contract snapshot exceeds the nesting-depth limit."],
      [[null, null], { maximumNodes: 2 }, "GPU contract snapshot exceeds the total node limit."],
      [{ first: null, second: null }, { maximumProperties: 1 }, "GPU contract snapshot exceeds the total property limit."],
      [[null, null], { maximumElements: 1 }, "GPU contract snapshot exceeds the total element limit."],
      [[null, null], { maximumArrayLength: 1 }, "GPU contract snapshot exceeds the single-array element limit."],
      ["rocket-🚀", { maximumStringBytes: 8 }, "GPU contract snapshot exceeds the individual string byte limit."],
      [["aa", "bb"], { maximumAggregateStringBytes: 3 }, "GPU contract snapshot exceeds the aggregate string byte limit."],
      [[null], { maximumAggregateBytes: 5 }, "GPU contract snapshot exceeds the aggregate byte limit."],
    ];
    for (const [value, override, message] of cases) {
      const error = capture(() => snapshotGpuContract(value, limits(override)));
      expect(error.message).toBe(message);
      expect(Object.hasOwn(error, "cause")).toBe(false);
    }
  });

  it("fails an oversized or deep unknown field before invoking a later getter", async () => {
    const { model } = await shaderAssets();
    const oversized = {
      ...clone(model),
      unknown: new Array(GPU_CONTRACT_SNAPSHOT_LIMITS.maximumArrayLength + 1).fill(null),
    } as Record<string, unknown>;
    const reads = accessorAt(oversized, "later", "secret");
    const oversizedError = capture(() => parseModelGpuCompatibilityDescriptor(oversized));
    expect(oversizedError.message).toContain("single-array element limit");
    expect(reads()).toBe(0);

    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let index = 0; index <= GPU_CONTRACT_SNAPSHOT_LIMITS.maximumDepth; index += 1) {
      const next: Record<string, unknown> = {};
      deep.child = next;
      deep = next;
    }
    const deepError = capture(() => parseModelGpuCompatibilityDescriptor({ ...clone(model), unknown: root }));
    expect(deepError.message).toContain("nesting-depth limit");
  });

  it("preserves canonical output and duplicates shared JSON subgraphs by value", () => {
    const shared = { z: -0, a: "🚀" };
    expect(canonicalizeGpuContract({ right: shared, left: shared })).toBe(
      '{"left":{"a":"🚀","z":0},"right":{"a":"🚀","z":0}}',
    );
  });

  it("bounds canonical JSON input before parsing and never retains syntax details", () => {
    const error = capture(() => parseCanonicalJson(
      "x".repeat(GPU_CONTRACT_SNAPSHOT_LIMITS.maximumInputBytes + 1),
    ));
    expect(error.message).toBe("Canonical GPU contract JSON is invalid or exceeds its input bound.");
    expect(Object.hasOwn(error, "cause")).toBe(false);

    const syntax = capture(() => parseCanonicalJson('{"provider-secret":'));
    expect(syntax.message).toBe("Canonical GPU contract JSON is invalid or exceeds its input bound.");
    expect(Object.hasOwn(syntax, "cause")).toBe(false);
  });

  it("copies Uint8Array bytes without getters while accepting Buffer, subclasses, and cross-realm values", () => {
    let constructorReads = 0;
    const bytes = Uint8Array.of(1, 2, 3);
    Object.defineProperty(bytes, "constructor", {
      configurable: true,
      get() {
        constructorReads += 1;
        throw new Error("typed-array-constructor-secret");
      },
    });
    expect(snapshotUint8Array(bytes, 3)).toEqual(Uint8Array.of(1, 2, 3));
    expect(constructorReads).toBe(0);

    class ByteSubclass extends Uint8Array {}
    expect(snapshotUint8Array(new ByteSubclass([4, 5]), 2)).toEqual(Uint8Array.of(4, 5));
    expect(snapshotUint8Array(Buffer.from([6, 7]), 2)).toEqual(Uint8Array.of(6, 7));
    const crossRealm = runInNewContext("new Uint8Array([8, 9])") as unknown;
    expect(snapshotUint8Array(crossRealm, 2)).toEqual(Uint8Array.of(8, 9));
  });

  it("rejects Proxy-backed byte input without invoking or leaking its get trap", () => {
    const secret = "typed-array-proxy-secret";
    let gets = 0;
    const bytes = new Proxy(Uint8Array.of(123, 125), {
      get() {
        gets += 1;
        throw new Error(secret);
      },
    });
    const error = capture(() => parseJsonBytes(bytes, "GPU manifest"));
    expect(gets).toBe(0);
    expect(error.message).toBe("GPU manifest is not bounded UTF-8 JSON.");
    expect(inspect(error)).not.toContain(secret);
    expect(Object.hasOwn(error, "cause")).toBe(false);
  });

  it("checks an oversized array length before requesting its complete key set", () => {
    let ownKeyReads = 0;
    const oversized = new Proxy(
      new Array(GPU_CONTRACT_SNAPSHOT_LIMITS.maximumArrayLength + 1),
      {
        ownKeys() {
          ownKeyReads += 1;
          throw new Error("oversized-array-ownkeys-secret");
        },
      },
    );
    expect(() => snapshotGpuContract(oversized)).toThrow("single-array element limit");
    expect(ownKeyReads).toBe(0);
  });
});

describe("manifest parser snapshot coverage", () => {
  it("routes every root manifest family through the accessor-safe boundary", async () => {
    const assets = await shaderAssets();
    const shaderCore = clone(assets.shaderManifest) as unknown as Record<string, unknown>;
    delete shaderCore.validationEvidence;
    delete shaderCore.additionalValidationEvidence;
    const modelFixture = {
      contractVersion: SHADER_QUALIFICATION_FIXTURE_VERSION,
      fixtureId: "fixture.model",
      model: assets.model,
    };
    const cases: readonly [string, unknown, (value: unknown) => unknown][] = [
      ["interface", assets.gpuInterface, parseGpuInterfaceManifest],
      ["shader", assets.shaderManifest, parseShaderVersionManifest],
      ["shader core", shaderCore, parseShaderVersionManifestCore],
      ["style profile", assets.profileManifest, parseShaderStyleProfileManifest],
      ["model", assets.model, parseModelGpuCompatibilityDescriptor],
      ["model fixture", modelFixture, parseShaderQualificationModelCompatibilityFixture],
      ["pipeline descriptors", assets.shaderManifest.pipelines, (value) => parseSerializableGpuPipelineDescriptors(value, assets.shaderManifest.modules.map((module) => module.moduleId))],
    ];

    for (const [label, original, parse] of cases) {
      const input = clone(original);
      const nested = firstNestedTarget(input as object);
      const reads = accessorAt(nested.target, nested.key, nested.returned);
      const error = capture(() => parse(input));
      expect(error.message, label).toContain("bounded detached JSON contract data");
      expect(reads(), label).toBe(0);
      expect(Object.hasOwn(error, "cause"), label).toBe(false);
    }
  });
});

describe("qualification parser snapshot coverage", () => {
  it("rejects accessors across inventory, matrix, fixture, bundle, provenance, and producer parsers", async () => {
    const matrix = await stableMatrix();
    const bundle = await qualificationBundle(matrix);
    const cases: readonly [string, unknown, (value: unknown) => unknown, "result" | "throw"][] = [
      ["inventory", validInventory(), validateCompileUnitInventory, "result"],
      ["matrix", matrix, validateStableWebGpuMatrix, "result"],
      ["fixture", validQualificationFixture(), (value) => validateQualificationFixture(value, validInventory().compileUnits[0]), "result"],
      ["bundle", bundle, validateQualificationBundleManifest, "result"],
      ["provenance", provenance(), parseTrustedWorkflowProvenance, "throw"],
      ["producer", executionProducer(matrix.cells[0]!), parseQualificationExecutionProducer, "throw"],
    ];

    for (const [label, original, parse, kind] of cases) {
      const input = clone(original) as object;
      const nested = firstNestedTarget(input);
      const reads = accessorAt(nested.target, nested.key, nested.returned);
      if (kind === "throw") {
        const error = capture(() => parse(input));
        expect(error.message, label).toContain("bounded detached JSON contract data");
        expect(Object.hasOwn(error, "cause"), label).toBe(false);
      } else {
        const result = parse(input) as { readonly ok: boolean; readonly diagnostics?: readonly { readonly message: string }[] };
        expect(result.ok, label).toBe(false);
        expect(result.diagnostics?.[0]?.message, label).toContain("bounded detached JSON contract data");
      }
      expect(reads(), label).toBe(0);
    }
  });

  it("rejects accessor-backed aggregate evidence and attestation refs without leakage", async () => {
    const matrixBytes = new Uint8Array(await readFile(
      new URL("../matrices/stable-webgpu-2026-07-13.json", import.meta.url),
    ));
    const matrix = JSON.parse(new TextDecoder().decode(matrixBytes)) as StableWebGpuMatrixManifest;
    const scenario = await evidenceScenario(matrix, matrixBytes);
    const evidence = await aggregateShaderValidationEvidence({
      bundle: scenario.bundle,
      matrix,
      matrixBytes,
      preflight: scenario.preflightArtifact,
      cellEvidence: scenario.cellEvidence,
      runnerPreflights: scenario.runnerPreflights,
      workflowDiagnostics: [],
      harness: scenario.harness,
      packageVersion: "0.1.2",
      generatedAt: "2026-07-13T12:10:00.000Z",
    });
    const hostileEvidence = clone(evidence) as object;
    const evidenceReads = accessorAt(hostileEvidence, "status", "passed");
    const evidenceResult = await validateShaderValidationEvidence({
      evidence: hostileEvidence,
      bundle: scenario.bundle,
      matrix,
      matrixBytes,
    });
    expect(evidenceResult.ok).toBe(false);
    expect(evidenceReads()).toBe(0);
    if (!evidenceResult.ok) expect(evidenceResult.diagnostics[0]?.message).not.toContain("provider-secret");

    const byteSecret = "qualification-byte-proxy-secret";
    let byteGets = 0;
    const hostileMatrixBytes = new Proxy(matrixBytes, {
      get() {
        byteGets += 1;
        throw new Error(byteSecret);
      },
    });
    const byteResult = await validateShaderValidationEvidence({
      evidence,
      bundle: scenario.bundle,
      matrix,
      matrixBytes: hostileMatrixBytes,
    });
    expect(byteResult.ok).toBe(false);
    expect(byteGets).toBe(0);
    expect(JSON.stringify(byteResult)).not.toContain(byteSecret);

    const attestationRef: ShaderValidationEvidenceAttestationRef = {
      contractVersion: SHADER_VALIDATION_EVIDENCE_VERSION,
      kind: "shader-validation-evidence-attestation-ref",
      evidence: { name: "evidence.json", sha256: "1".repeat(64) as ShaderValidationEvidenceAttestationRef["evidence"]["sha256"] },
      attestation: {
        id: "attestation-1",
        url: "https://github.com/Plasius-LTD/model-store/attestations/1",
        bundle: { name: "attestation.json", sha256: "2".repeat(64) as ShaderValidationEvidenceAttestationRef["attestation"]["bundle"]["sha256"] },
      },
      producer: {
        repository: "Plasius-LTD/model-store",
        runId: "123",
        runAttempt: 1,
        trustedWorkflowRepository: "Plasius-LTD/gpu-shader",
        trustedWorkflowRef: "Plasius-LTD/gpu-shader/.github/workflows/shader-qualification.yml@refs/heads/main",
        trustedWorkflowSha: { algorithm: "sha1", hex: "b".repeat(40) },
      },
    };
    const hostileRef = clone(attestationRef) as object;
    const refReads = accessorAt(hostileRef, "kind", attestationRef.kind);
    const refError = capture(() => parseShaderValidationEvidenceAttestationRef(hostileRef));
    expect(refError.message).toContain("bounded detached JSON contract data");
    expect(refReads()).toBe(0);
    expect(Object.hasOwn(refError, "cause")).toBe(false);
  });
});
