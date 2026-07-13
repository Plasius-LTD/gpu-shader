import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canonicalizeGpuContract,
  parseCanonicalJson,
} from "../src/canonical-json.js";
import type { GpuInterfaceManifest } from "../src/contracts.js";
import {
  computeGpuAbiHash,
  computeSha256,
} from "../src/hash.js";
import { clone, computePipeline, reflectedInterface } from "./fixtures.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("canonical contract coverage boundaries", () => {
  it("accepts the complete JSON primitive/object surface and valid Unicode scalars", () => {
    const objectWithNullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, {
      z: null,
      a: [true, false, 1.25, "\ud83d\ude80"],
    });

    expect(canonicalizeGpuContract(objectWithNullPrototype)).toBe(
      '{"a":[true,false,1.25,"\ud83d\ude80"],"z":null}',
    );
    expect(parseCanonicalJson('{"a":[true,false,1.25,"\ud83d\ude80"],"z":null}')).toEqual({
      a: [true, false, 1.25, "\ud83d\ude80"],
      z: null,
    });
  });

  it.each([
    ["trailing high surrogate", "\ud800"],
    ["high surrogate followed by a scalar", "\ud800x"],
    ["unpaired low surrogate", "\udc00"],
  ])("rejects an invalid Unicode scalar in a %s", (_label, value) => {
    expect(() => canonicalizeGpuContract(value)).toThrow("unpaired UTF-16 surrogate");
    expect(() => canonicalizeGpuContract({ [value]: true })).toThrow("unpaired UTF-16 surrogate");
  });

  it.each([
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["NaN", Number.NaN],
  ])("rejects the non-finite number %s", (_label, value) => {
    expect(() => canonicalizeGpuContract(value)).toThrow("non-finite number");
  });

  it.each([
    ["undefined", undefined],
    ["bigint", 1n],
    ["symbol", Symbol("contract")],
    ["function", () => undefined],
  ])("rejects the non-JSON JavaScript value %s", (_label, value) => {
    expect(() => canonicalizeGpuContract(value)).toThrow("JSON cannot represent");
  });

  it("rejects objects with behavior and non-canonical but otherwise valid JSON", () => {
    expect(() => canonicalizeGpuContract(new Date(0))).toThrow("plain JSON objects");
    expect(() => parseCanonicalJson('{"b":1,"a":2}')).toThrow("not in canonical form");
    expect(() => parseCanonicalJson("-0")).toThrow("not in canonical form");
  });
});

describe("ABI hashing coverage boundaries", () => {
  it("hashes byte inputs and fails closed without Web Crypto", async () => {
    const text = "binary input";
    expect(await computeSha256(new TextEncoder().encode(text))).toBe(await computeSha256(text));

    vi.stubGlobal("crypto", undefined);
    await expect(computeSha256(text)).rejects.toThrow("Web Crypto SHA-256 support is required");
  });

  it("rejects model ABI projections that reference an absent record", async () => {
    const manifest = clone(await reflectedInterface());
    (manifest.modelAbi as Mutable<typeof manifest.modelAbi>).recordNames = ["MissingRecord"];

    await expect(computeGpuAbiHash({ kind: "model", interface: manifest })).rejects.toThrow(
      "Model ABI references missing record MissingRecord",
    );
  });

  it("hashes record-member semantics and normalizes model projection selector ordering", async () => {
    const manifest = clone(await reflectedInterface());
    (manifest.modelAbi as Mutable<typeof manifest.modelAbi>).semantics = [
      ...manifest.modelAbi.semantics,
      {
        semantic: "model.radius",
        source: {
          kind: "record-member",
          recordName: "ModelData",
          memberPath: ["radius"],
        },
      },
    ];

    const reordered = clone(manifest);
    (reordered.modelAbi as Mutable<typeof reordered.modelAbi>).semantics = [
      ...reordered.modelAbi.semantics,
    ].reverse();
    (reordered.modelAbi as Mutable<typeof reordered.modelAbi>).recordNames = [
      ...reordered.modelAbi.recordNames,
    ].reverse();

    expect(await computeGpuAbiHash({ kind: "model", interface: reordered })).toBe(
      await computeGpuAbiHash({ kind: "model", interface: manifest }),
    );
  });

  it("normalizes all interface comparator tie-breakers", async () => {
    const original = clone(await reflectedInterface());
    const firstEntry = original.entryPoints[0]!;
    const manifest = {
      ...original,
      entryPoints: [
        { ...firstEntry, name: "zeta" },
        { ...firstEntry, name: "alpha" },
        { ...firstEntry, moduleId: "z-module" },
        firstEntry,
      ],
      overrides: [
        ...original.overrides,
        { ...original.overrides[0]!, name: "ANOTHER" },
        { ...original.overrides[0]!, moduleId: "z-module" },
      ],
      bindings: [
        ...original.bindings,
        { ...original.bindings[0]!, binding: 1 },
        { ...original.bindings[0]!, group: 1 },
        { ...original.bindings[0]!, moduleId: "z-module" },
      ],
    } satisfies GpuInterfaceManifest;

    const reversed = {
      ...manifest,
      entryPoints: [...manifest.entryPoints].reverse(),
      overrides: [...manifest.overrides].reverse(),
      bindings: [...manifest.bindings].reverse(),
    } satisfies GpuInterfaceManifest;

    expect(await computeGpuAbiHash({ kind: "interface", interface: reversed })).toBe(
      await computeGpuAbiHash({ kind: "interface", interface: manifest }),
    );
  });

  it("normalizes model selector tie-breakers and shader pipeline order", async () => {
    const manifest = clone(await reflectedInterface());
    const firstBinding = manifest.modelAbi.bindings[0]!;
    (manifest.modelAbi as Mutable<typeof manifest.modelAbi>).bindings = [
      firstBinding,
      {
        ...firstBinding,
        source: { ...firstBinding.source, binding: 1 },
        resource: { kind: "sampler", samplerType: "filtering" },
      },
    ];
    (manifest.modelAbi as Mutable<typeof manifest.modelAbi>).vertexInputs = [
      {
        source: { pipelineId: "model.render", shaderLocation: 0 },
        format: "float32x2",
        offset: 8,
        arrayStride: 16,
        stepMode: "vertex",
        semantic: "model.position",
      },
      {
        source: { pipelineId: "model.render", shaderLocation: 1 },
        format: "float32x2",
        offset: 0,
        arrayStride: 16,
        stepMode: "vertex",
        semantic: "model.position",
      },
    ];

    const reordered = clone(manifest);
    (reordered.modelAbi as Mutable<typeof reordered.modelAbi>).bindings = [
      ...reordered.modelAbi.bindings,
    ].reverse();
    (reordered.modelAbi as Mutable<typeof reordered.modelAbi>).vertexInputs = [
      ...reordered.modelAbi.vertexInputs,
    ].reverse();
    expect(await computeGpuAbiHash({ kind: "model", interface: reordered })).toBe(
      await computeGpuAbiHash({ kind: "model", interface: manifest }),
    );

    const requirements = {
      semantics: [],
      features: [],
      limits: [],
      formats: [],
    };
    const first = { ...computePipeline(), pipelineId: "z-pipeline" };
    const second = { ...computePipeline(), pipelineId: "a-pipeline" };
    expect(await computeGpuAbiHash({
      kind: "shader",
      interface: manifest,
      pipelines: [first, second],
      requirements,
    })).toBe(await computeGpuAbiHash({
      kind: "shader",
      interface: manifest,
      pipelines: [second, first],
      requirements,
    }));
  });
});
