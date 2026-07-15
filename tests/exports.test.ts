import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("public subpath boundaries", () => {
  it("keeps the root entry browser-safe while exporting runtime contracts", async () => {
    const root = await import("../src/index.js");
    expect(root).toEqual(expect.objectContaining({
      assertImmutableAssetVersion: expect.any(Function),
      canonicalizeGpuContract: expect.any(Function),
      computeGpuAbiHash: expect.any(Function),
      createGpuRecordCodec: expect.any(Function),
      parseModelGpuCompatibilityDescriptor: expect.any(Function),
      loadShaderStyleProfile: expect.any(Function),
      prepareStyleProfile: expect.any(Function),
      activateStyleProfile: expect.any(Function),
      GPU_SHADER_STORE_FEATURE_FLAG: "asset.pipeline.shader-store.enabled",
      GPU_SHADER_STYLE_SELECTION_CAPABILITY: "gpu.shader.style.select",
    }));
    const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/node:|\.\/node\//u);
    expect(source).not.toContain("wgsl_reflect");
  });

  it("isolates reflection/admission and qualification APIs behind explicit subpaths", async () => {
    const node = await import("../src/node.js");
    expect(node).toEqual(expect.objectContaining({
      reflectGpuInterface: expect.any(Function),
      validateAssembledGpuInterface: expect.any(Function),
      generateGpuInterfaceArtifacts: expect.any(Function),
      admitQualificationBundle: expect.any(Function),
    }));
    const testing = await import("../src/testing.js");
    expect(testing).toEqual(expect.objectContaining({
      validateCompileUnitInventory: expect.any(Function),
      validateStableWebGpuMatrix: expect.any(Function),
      validateQualificationFixture: expect.any(Function),
      aggregateShaderValidationEvidence: expect.any(Function),
    }));
  });
});
