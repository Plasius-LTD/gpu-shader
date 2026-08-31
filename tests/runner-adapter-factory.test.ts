import { describe, expect, it, vi } from "vitest";
import type { StableWebGpuMatrixCell } from "../src/contracts.js";
import {
  createProvisionedTrustedAdapter,
  defaultTrustedQualificationAdapterFactory,
} from "../src/testing/runner/adapter-factory.js";
import { createPlaywrightSwiftShaderAdapter } from "../src/testing/runner/playwright-swiftshader.js";
import { readTrustedHarnessPackageMetadata } from "../src/testing/runner/package-metadata.js";
import type {
  TrustedQualificationAdapter,
  TrustedQualificationAdapterFactory,
} from "../src/testing/runner/types.js";

const swiftShaderCell: StableWebGpuMatrixCell = {
  cellId: "swiftshader.chromium.ubuntu-x64",
  runnerLabels: ["ubuntu-24.04"],
  browser: { name: "chromium", channel: "playwright-bundled" },
  os: { name: "ubuntu", versionRequirement: { kind: "exact", value: "24.04" }, architecture: "x64" },
  adapter: { kind: "software", vendor: "google", family: "swiftshader", backend: "swiftshader" },
  automation: { kind: "playwright" },
  timeoutMs: 600_000,
  blocking: true,
  countsTowardStableCoverage: false,
};

const physicalCell: StableWebGpuMatrixCell = {
  ...swiftShaderCell,
  cellId: "ubuntu-intel-chrome-vulkan",
  runnerLabels: ["self-hosted", "Linux", "X64", "physical-gpu", "gpu-intel", "vulkan"],
  browser: { name: "chrome", channel: "stable" },
  adapter: { kind: "physical", vendor: "intel", family: "qualified-intel", backend: "vulkan" },
  countsTowardStableCoverage: true,
};

function adapter(overrides: Partial<TrustedQualificationAdapter> = {}): TrustedQualificationAdapter {
  return {
    automation: { kind: "playwright", driver: "trusted-driver", version: "1.0.0", sha256: "a".repeat(64) },
    runUnit: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("trusted qualification adapter routing", () => {
  it("reads release-owned package and Playwright pins", async () => {
    const metadata = await readTrustedHarnessPackageMetadata();
    expect(metadata.name).toBe("@plasius/gpu-shader");
    expect(metadata.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
    expect(metadata.playwrightCoreVersion).toBe("1.62.1");
  });

  it("fails closed for every unprovisioned physical route", async () => {
    await expect(defaultTrustedQualificationAdapterFactory.create(physicalCell)).rejects.toThrow(
      /No fixed trusted physical adapter is provisioned/u,
    );
  });

  it("rejects matrix drift before importing or launching Playwright", async () => {
    await expect(createPlaywrightSwiftShaderAdapter({
      ...swiftShaderCell,
      countsTowardStableCoverage: true,
    })).rejects.toThrow(/exact blocking SwiftShader smoke cell/u);
  });

  it("closes a provisioned adapter whose automation route differs", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const candidate = adapter({
      automation: { kind: "webdriver", driver: "trusted-driver", version: "1.0.0", sha256: "a".repeat(64) },
      close,
    });
    const factory: TrustedQualificationAdapterFactory = { create: vi.fn().mockResolvedValue(candidate) };
    await expect(createProvisionedTrustedAdapter(factory, physicalCell)).rejects.toThrow(/differs from matrix route/u);
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects an adapter without an actual driver identity", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const candidate = adapter({
      automation: { kind: "playwright", driver: " ", version: "1.0.0", sha256: "a".repeat(64) },
      close,
    });
    const factory: TrustedQualificationAdapterFactory = { create: vi.fn().mockResolvedValue(candidate) };
    await expect(createProvisionedTrustedAdapter(factory, physicalCell)).rejects.toThrow(/driver identity/u);
    expect(close).toHaveBeenCalledOnce();
  });

  it("accepts only a nonempty matching trusted route", async () => {
    const candidate = adapter();
    const factory: TrustedQualificationAdapterFactory = { create: vi.fn().mockResolvedValue(candidate) };
    await expect(createProvisionedTrustedAdapter(factory, physicalCell)).resolves.toBe(candidate);
  });
});
