import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  browserName: "chromium",
  browserVersion: "123.4.5.6",
  executablePath: "/trusted/chromium-1234/chrome",
  integrityError: null as Error | null,
  launchError: null as Error | null,
  gotoError: null as Error | null,
  evaluateSetupError: null as Error | null,
  metadataVersion: "1.61.1",
  originUrl: "",
  rootStatus: 0,
  launchOptions: null as unknown,
  contextOptions: null as unknown,
  evaluateCalls: 0,
  unitResult: { marker: "unit-result" } as unknown,
  browserClose: vi.fn(async () => undefined),
  contextClose: vi.fn(async () => undefined),
  launch: vi.fn(),
}));

vi.mock("playwright-core", () => ({
  chromium: {
    executablePath: () => boundary.executablePath,
    launch: boundary.launch,
  },
}));

vi.mock("../src/testing/runner/package-metadata.js", () => ({
  readTrustedHarnessPackageMetadata: async () => ({
    name: "@plasius/gpu-shader",
    version: "0.1.0",
    playwrightCoreVersion: boundary.metadataVersion,
  }),
}));

vi.mock("../src/testing/runner/playwright-integrity.js", () => ({
  observePlaywrightAdapterHarness: async () => {
    if (boundary.integrityError) throw boundary.integrityError;
    return {
      id: "playwright-core" as const,
      version: boundary.metadataVersion,
      sha256: "a".repeat(64),
    };
  },
}));

import type { StableWebGpuMatrixCell } from "../src/contracts.js";
import { createPlaywrightSwiftShaderAdapter } from "../src/testing/runner/playwright-swiftshader.js";
import type {
  TrustedAdapterUnitResult,
  TrustedBrowserUnitPayload,
} from "../src/testing/runner/types.js";

const cell: StableWebGpuMatrixCell = {
  cellId: "swiftshader.chromium.ubuntu-x64",
  runnerLabels: ["ubuntu-24.04"],
  browser: { name: "chromium", channel: "playwright-bundled" },
  os: {
    name: "ubuntu",
    versionRequirement: { kind: "exact", value: "24.04" },
    architecture: "x64",
  },
  adapter: {
    kind: "software",
    vendor: "google",
    family: "swiftshader",
    backend: "swiftshader",
  },
  automation: { kind: "playwright" },
  timeoutMs: 10_000,
  blocking: true,
  countsTowardStableCoverage: false,
};

function fakeBrowser() {
  const page = {
    goto: vi.fn(async (url: string) => {
      boundary.originUrl = url;
      if (boundary.gotoError) throw boundary.gotoError;
      const response = await fetch(url);
      boundary.rootStatus = response.status;
      await response.text();
    }),
    evaluate: vi.fn(async (_operation: unknown, argument: unknown) => {
      boundary.evaluateCalls += 1;
      if (typeof argument === "string") {
        if (boundary.evaluateSetupError) throw boundary.evaluateSetupError;
        return undefined;
      }
      return boundary.unitResult;
    }),
  };
  const context = {
    newPage: vi.fn(async () => page),
    close: boundary.contextClose,
  };
  const browser = {
    browserType: () => ({ name: () => boundary.browserName }),
    newContext: vi.fn(async (options: unknown) => {
      boundary.contextOptions = options;
      return context;
    }),
    version: () => boundary.browserVersion,
    close: boundary.browserClose,
  };
  return { browser, context, page };
}

beforeEach(() => {
  boundary.browserName = "chromium";
  boundary.browserVersion = "123.4.5.6";
  boundary.executablePath = "/trusted/chromium-1234/chrome";
  boundary.integrityError = null;
  boundary.launchError = null;
  boundary.gotoError = null;
  boundary.evaluateSetupError = null;
  boundary.metadataVersion = "1.61.1";
  boundary.originUrl = "";
  boundary.rootStatus = 0;
  boundary.launchOptions = null;
  boundary.contextOptions = null;
  boundary.evaluateCalls = 0;
  boundary.unitResult = { marker: "unit-result" };
  boundary.browserClose.mockClear();
  boundary.contextClose.mockClear();
  boundary.launch.mockReset();
  boundary.launch.mockImplementation(async (options: unknown) => {
    boundary.launchOptions = options;
    if (boundary.launchError) throw boundary.launchError;
    return fakeBrowser().browser;
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("pinned Playwright SwiftShader adapter", () => {
  it("serves a CSP-locked loopback page, launches the fixed route, executes inert data and closes", async () => {
    const result = {
      status: "passed",
      observed: {},
      phases: [],
      diagnostics: [],
      layoutProbeOutputs: [],
    } as unknown as TrustedAdapterUnitResult;
    boundary.unitResult = result;
    const adapter = await createPlaywrightSwiftShaderAdapter(cell);

    expect(boundary.rootStatus).toBe(200);
    expect(boundary.launchOptions).toEqual({
      headless: true,
      args: [
        "--enable-unsafe-webgpu",
        "--enable-features=Vulkan",
        "--use-angle=swiftshader",
        "--use-vulkan=swiftshader",
        "--disable-vulkan-surface",
      ],
    });
    expect(boundary.contextOptions).toEqual({ serviceWorkers: "block" });
    const missing = await fetch(new URL("missing", boundary.originUrl));
    expect(missing.status).toBe(404);
    expect(missing.headers.get("x-content-type-options")).toBeNull();

    const payload = { cell } as unknown as TrustedBrowserUnitPayload;
    await expect(adapter.runUnit(payload)).resolves.toBe(result);
    await expect(adapter.runUnit({
      ...payload,
      cell: { ...cell, cellId: "changed" },
    })).rejects.toThrow(/cell identity changed/u);
    expect(adapter.automation).toMatchObject({
      kind: "playwright",
      driver: "playwright-core",
      version: "1.61.1",
      sha256: "a".repeat(64),
    });

    await adapter.close();
    expect(boundary.contextClose).toHaveBeenCalledOnce();
    expect(boundary.browserClose).toHaveBeenCalledOnce();
  });

  it.each([
    ["cell ID", { cellId: "other" }],
    ["adapter vendor", { adapter: { ...cell.adapter, vendor: "intel" } }],
    ["browser channel", { browser: { ...cell.browser, channel: "stable" as const } }],
    ["OS version", { os: { ...cell.os, versionRequirement: { kind: "exact" as const, value: "22.04" } } }],
    ["automation", { automation: { kind: "webdriver" as const } }],
  ])("rejects %s route drift before importing or launching a browser", async (_label, change) => {
    await expect(createPlaywrightSwiftShaderAdapter({ ...cell, ...change })).rejects.toThrow(/exact blocking SwiftShader smoke cell/u);
    expect(boundary.launch).not.toHaveBeenCalled();
  });

  it("rejects package-version, browser-install and executable-integrity drift", async () => {
    boundary.metadataVersion = "1.60.0";
    await expect(createPlaywrightSwiftShaderAdapter(cell)).rejects.toThrow(/requires playwright-core/u);

    boundary.metadataVersion = "1.61.1";
    boundary.executablePath = "";
    await expect(createPlaywrightSwiftShaderAdapter(cell)).rejects.toThrow(/Chromium is not installed/u);

    boundary.executablePath = "/trusted/chromium-1234/chrome";
    boundary.integrityError = new Error("integrity failed");
    await expect(createPlaywrightSwiftShaderAdapter(cell)).rejects.toThrow(/integrity failed/u);
  });

  it("closes the loopback origin and browser when launch or browser identity fails", async () => {
    boundary.launchError = new Error("launch failed");
    await expect(createPlaywrightSwiftShaderAdapter(cell)).rejects.toThrow(/launch failed/u);

    boundary.launchError = null;
    boundary.browserName = "firefox";
    await expect(createPlaywrightSwiftShaderAdapter(cell)).rejects.toThrow(/non-Chromium/u);
    expect(boundary.browserClose).toHaveBeenCalledOnce();
  });

  it("closes the browser and origin when page navigation or setup evaluation fails", async () => {
    boundary.gotoError = new Error("navigation failed");
    await expect(createPlaywrightSwiftShaderAdapter(cell)).rejects.toThrow(/navigation failed/u);
    expect(boundary.browserClose).toHaveBeenCalledOnce();

    boundary.gotoError = null;
    boundary.evaluateSetupError = new Error("setup failed");
    await expect(createPlaywrightSwiftShaderAdapter(cell)).rejects.toThrow(/setup failed/u);
    expect(boundary.browserClose).toHaveBeenCalledTimes(2);
  });
});
