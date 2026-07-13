import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  architecture: "x64",
  host: "runner-host",
  osRelease: 'ID="ubuntu"\nVERSION_ID="24.04"\n',
  platform: "linux",
  release: "6.8.0",
  moduleBytes: new TextEncoder().encode("export const adapter = 1;\n"),
  readError: null as Error | null,
  regularFile: true,
  symbolicLink: false,
}));

vi.mock("node:os", () => ({
  arch: () => boundary.architecture,
  hostname: () => boundary.host,
  platform: () => boundary.platform,
  release: () => boundary.release,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: vi.fn(async () => ({
      isFile: () => boundary.regularFile,
      isSymbolicLink: () => boundary.symbolicLink,
    })),
    realpath: vi.fn(async (path: string | URL) => String(path)),
    readFile: vi.fn(async (path: string | URL, encoding?: unknown) => {
      if (boundary.readError) throw boundary.readError;
      if (String(path) === "/etc/os-release" && encoding === "utf8") return boundary.osRelease;
      return boundary.moduleBytes;
    }),
  };
});

import { pathToFileURL } from "node:url";
import type {
  ShaderQualificationPreflightManifest,
  Sha256Hex,
  StableWebGpuMatrixCell,
} from "../src/contracts.js";
import { computeSha256 } from "../src/hash.js";
import {
  resolveTrustedFleetAdapterFactory,
  TRUSTED_FLEET_REGISTRATION_SYMBOL,
} from "../src/testing/runner/fleet-registration.js";
import { observeTrustedRunnerHost } from "../src/testing/runner/host.js";
import type {
  TrustedQualificationAdapter,
  TrustedQualificationAdapterFactory,
} from "../src/testing/runner/types.js";
import { AUTOMATION_SHA, provenance, ZERO_SHA } from "./fixtures.js";

const physicalCell: StableWebGpuMatrixCell = {
  cellId: "ubuntu-intel-chrome-vulkan",
  runnerLabels: ["self-hosted", "Linux", "X64", "physical-gpu", "gpu-intel", "vulkan"],
  browser: { name: "chrome", channel: "stable" },
  os: {
    name: "ubuntu",
    versionRequirement: { kind: "minimum-major", value: 24 },
    architecture: "x64",
  },
  adapter: {
    kind: "physical",
    vendor: "intel",
    family: "qualified-intel",
    backend: "vulkan",
  },
  automation: { kind: "webdriver" },
  timeoutMs: 10_000,
  blocking: true,
  countsTowardStableCoverage: true,
};

const swiftShaderCell: StableWebGpuMatrixCell = {
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

function preflight(harnessSha256: Sha256Hex = ZERO_SHA): ShaderQualificationPreflightManifest {
  return {
    contractVersion: "1.0.0",
    kind: "shader-qualification-preflight",
    qualificationId: "qualification.fleet",
    sourceBlob: {
      host: "account.blob.core.windows.net",
      versionId: "one",
      uri: "https://account.blob.core.windows.net/candidates/candidate.tar?versionid=one",
    },
    dataBundleSha256: ZERO_SHA,
    compileUnitInventorySha256: ZERO_SHA,
    matrixSha256: ZERO_SHA,
    harnessSha256,
    subjectBindingSha256: ZERO_SHA,
    provenance: provenance(),
  };
}

function adapter(overrides: Partial<TrustedQualificationAdapter> = {}): TrustedQualificationAdapter {
  return {
    automation: {
      kind: "webdriver",
      driver: "fleet-adapter",
      version: "2.0.0",
      sha256: AUTOMATION_SHA,
    },
    runUnit: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function executableSha256(bytes: Uint8Array): Promise<Sha256Hex> {
  const fileSha256 = await computeSha256(bytes);
  return computeSha256(`plasius.trusted-fleet-adapter-single-file/v1\n${fileSha256}`);
}

function rootForPlatform(): string {
  if (boundary.platform === "darwin") return "/Library/Application Support/Plasius/WebGPUFleet";
  if (boundary.platform === "win32") return "C:\\ProgramData\\Plasius\\WebGPUFleet";
  return "/opt/plasius/webgpu-fleet";
}

async function register(options: {
  readonly moduleUrl?: string;
  readonly executableSha256?: Sha256Hex;
  readonly qualificationHarnessSha256?: Sha256Hex;
  readonly runnerName?: string;
  readonly allowedCellIds?: readonly string[];
  readonly selectedAdapter?: TrustedQualificationAdapter;
} = {}) {
  const moduleUrl = options.moduleUrl ?? pathToFileURL(`${rootForPlatform()}/adapter.mjs`).href;
  const sha256 = options.executableSha256 ?? await executableSha256(boundary.moduleBytes);
  const selectedAdapter = options.selectedAdapter ?? adapter({
    automation: { kind: "webdriver", driver: "fleet-adapter", version: "2.0.0", sha256 },
  });
  const factory: TrustedQualificationAdapterFactory = {
    create: vi.fn().mockResolvedValue(selectedAdapter),
  };
  Reflect.set(globalThis, TRUSTED_FLEET_REGISTRATION_SYMBOL, {
    contractVersion: "1.0.0",
    moduleUrl,
    adapterHarness: { id: "fleet-adapter", version: "2.0.0", sha256 },
    qualificationHarnessSha256: options.qualificationHarnessSha256 ?? ZERO_SHA,
    runnerName: options.runnerName ?? "runner-host",
    allowedCellIds: options.allowedCellIds ?? [physicalCell.cellId],
    factory,
  });
  process.env.PLASIUS_TRUSTED_FLEET_ADAPTER_URL = moduleUrl;
  process.env.PLASIUS_TRUSTED_FLEET_ADAPTER_SHA256 = sha256;
  process.env.RUNNER_NAME = "runner-host";
  return { moduleUrl, sha256, selectedAdapter, factory };
}

beforeEach(() => {
  boundary.architecture = "x64";
  boundary.host = "runner-host";
  boundary.osRelease = 'ID="ubuntu"\nVERSION_ID="24.04"\n';
  boundary.platform = "linux";
  boundary.release = "6.8.0";
  boundary.moduleBytes = new TextEncoder().encode("export const adapter = 1;\n");
  boundary.readError = null;
  boundary.regularFile = true;
  boundary.symbolicLink = false;
  process.env.RUNNER_NAME = "runner-host";
  delete process.env.PLASIUS_SHADER_OS_VERSION;
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, TRUSTED_FLEET_REGISTRATION_SYMBOL);
  delete process.env.PLASIUS_TRUSTED_FLEET_ADAPTER_URL;
  delete process.env.PLASIUS_TRUSTED_FLEET_ADAPTER_SHA256;
  delete process.env.PLASIUS_SHADER_OS_VERSION;
  delete process.env.RUNNER_NAME;
  vi.clearAllMocks();
});

describe("trusted runner host observation", () => {
  it("derives exact Linux release facts and retains API-observed runner labels", async () => {
    const apiRunner = { name: "runner-host", labels: [...swiftShaderCell.runnerLabels, "observed"] };
    await expect(observeTrustedRunnerHost(swiftShaderCell, apiRunner)).resolves.toEqual({
      runner: { id: "runner-host", labels: apiRunner.labels },
      os: { name: "ubuntu", version: "24.04", channel: null, architecture: "x64" },
    });
  });

  it("uses non-Ubuntu IDs and kernel fallback when VERSION_ID is absent", async () => {
    boundary.osRelease = "ID=debian\n";
    boundary.release = "6.12.1";
    const observed = await observeTrustedRunnerHost(physicalCell, {
      name: "runner-host",
      labels: physicalCell.runnerLabels,
    });
    expect(observed.os).toEqual({ name: "debian", version: "6.12.1", channel: null, architecture: "x64" });
  });

  it("reads calibrated macOS and Windows build values", async () => {
    boundary.platform = "darwin";
    boundary.architecture = "arm64";
    process.env.PLASIUS_SHADER_OS_VERSION = "15.5";
    const macCell = {
      ...physicalCell,
      cellId: "mac",
      os: { ...physicalCell.os, name: "macos" as const, architecture: "arm64" as const },
    };
    expect((await observeTrustedRunnerHost(macCell, { name: "runner-host", labels: [] })).os).toMatchObject({
      name: "macos",
      version: "15.5",
      architecture: "arm64",
    });

    boundary.platform = "win32";
    boundary.architecture = "x64";
    process.env.PLASIUS_SHADER_OS_VERSION = "11.0.26100";
    const windowsCell = { ...physicalCell, cellId: "win", os: { ...physicalCell.os, name: "windows" as const } };
    expect((await observeTrustedRunnerHost(windowsCell, { name: "runner-host", labels: [] })).os).toMatchObject({
      name: "windows",
      version: "11.0.26100",
    });
  });

  it("fails closed for architecture, platform, route and runner-name drift", async () => {
    boundary.architecture = "ia32";
    await expect(observeTrustedRunnerHost(physicalCell, { name: "runner-host", labels: [] })).rejects.toThrow(/Unsupported qualification host architecture/u);

    boundary.architecture = "x64";
    boundary.platform = "freebsd";
    await expect(observeTrustedRunnerHost(physicalCell, { name: "runner-host", labels: [] })).rejects.toThrow(/Unsupported qualification host platform/u);

    boundary.platform = "linux";
    boundary.osRelease = "ID=ubuntu\nVERSION_ID=22.04\n";
    await expect(observeTrustedRunnerHost(swiftShaderCell, { name: "runner-host", labels: [] })).rejects.toThrow(/differs from its exact matrix route/u);

    boundary.osRelease = "ID=ubuntu\nVERSION_ID=24.04\n";
    await expect(observeTrustedRunnerHost(swiftShaderCell, { name: "different", labels: [] })).rejects.toThrow(/runner name differs/u);
  });
});

describe("preload-only physical fleet registration", () => {
  it("verifies the runner-owned single-file digest and wraps the registered factory", async () => {
    const selected = await register();
    const factory = await resolveTrustedFleetAdapterFactory({ cell: physicalCell, preflight: preflight() });
    await expect(factory.create(physicalCell)).resolves.toBe(selected.selectedAdapter);
    expect(selected.factory.create).toHaveBeenCalledWith(physicalCell);
  });

  it.each(["linux", "darwin"])("accepts only the fixed %s runner-owned root", async (platformName) => {
    boundary.platform = platformName;
    await register();
    await expect(resolveTrustedFleetAdapterFactory({ cell: physicalCell, preflight: preflight() })).resolves.toBeDefined();
  });

  it("accepts only the fixed Windows runner-owned root", async () => {
    boundary.platform = "win32";
    await register();
    await expect(resolveTrustedFleetAdapterFactory({ cell: physicalCell, preflight: preflight() })).resolves.toBeDefined();
  });

  it("rejects software cells, missing registration and malformed registration", async () => {
    await expect(resolveTrustedFleetAdapterFactory({ cell: swiftShaderCell, preflight: preflight() })).rejects.toThrow(/restricted to physical/u);
    await expect(resolveTrustedFleetAdapterFactory({ cell: physicalCell, preflight: preflight() })).rejects.toThrow(/No preload-only/u);

    Reflect.set(globalThis, TRUSTED_FLEET_REGISTRATION_SYMBOL, { contractVersion: "1.0.0" });
    await expect(resolveTrustedFleetAdapterFactory({ cell: physicalCell, preflight: preflight() })).rejects.toThrow(/malformed/u);
  });

  it("rejects URL configuration, protocol, root and extension drift", async () => {
    await register();
    process.env.PLASIUS_TRUSTED_FLEET_ADAPTER_URL = "file:///different.mjs";
    await expect(resolveTrustedFleetAdapterFactory({ cell: physicalCell, preflight: preflight() })).rejects.toThrow(/URL differs/u);

    await register({ moduleUrl: "https://example.invalid/adapter.mjs" });
    await expect(resolveTrustedFleetAdapterFactory({ cell: physicalCell, preflight: preflight() })).rejects.toThrow(/absolute file URL/u);

    await register({ moduleUrl: pathToFileURL("/tmp/adapter.mjs").href });
    await expect(resolveTrustedFleetAdapterFactory({ cell: physicalCell, preflight: preflight() })).rejects.toThrow(/outside its fixed/u);

    await register({ moduleUrl: pathToFileURL(`${rootForPlatform()}/adapter.js`).href });
    await expect(resolveTrustedFleetAdapterFactory({ cell: physicalCell, preflight: preflight() })).rejects.toThrow(/outside its fixed/u);
  });

  it("rejects non-regular and linked executable files", async () => {
    await register();
    boundary.regularFile = false;
    await expect(resolveTrustedFleetAdapterFactory({ cell: physicalCell, preflight: preflight() })).rejects.toThrow(/regular non-linked/u);
    boundary.regularFile = true;
    boundary.symbolicLink = true;
    await expect(resolveTrustedFleetAdapterFactory({ cell: physicalCell, preflight: preflight() })).rejects.toThrow(/regular non-linked/u);
  });

  it.each([
    ["template literals", "export const value = `unsafe`;", /without template literals/u],
    ["transitive imports", "import value from './other.mjs';", /no transitive code loading/u],
    ["lexically incomplete source", "export const value = 'unterminated", /lexically incomplete/u],
  ])("rejects %s in the trusted adapter bundle", async (_label, source, expected) => {
    boundary.moduleBytes = new TextEncoder().encode(source);
    await register();
    await expect(resolveTrustedFleetAdapterFactory({ cell: physicalCell, preflight: preflight() })).rejects.toThrow(expected);
  });

  it("allows forbidden words inside comments and quoted strings", async () => {
    boundary.moduleBytes = new TextEncoder().encode("// import ignored\nexport const label = 'require'; /* eval */\n");
    await register();
    await expect(resolveTrustedFleetAdapterFactory({ cell: physicalCell, preflight: preflight() })).resolves.toBeDefined();
  });

  it("rejects executable digest and runner calibration drift", async () => {
    await register({ executableSha256: AUTOMATION_SHA });
    await expect(resolveTrustedFleetAdapterFactory({ cell: physicalCell, preflight: preflight() })).rejects.toThrow(/executable identity differs/u);

    await register({ qualificationHarnessSha256: AUTOMATION_SHA });
    await expect(resolveTrustedFleetAdapterFactory({ cell: physicalCell, preflight: preflight() })).rejects.toThrow(/not bound to this runner/u);

    await register({ runnerName: "other" });
    await expect(resolveTrustedFleetAdapterFactory({ cell: physicalCell, preflight: preflight() })).rejects.toThrow(/not bound to this runner/u);

    await register({ allowedCellIds: ["other"] });
    await expect(resolveTrustedFleetAdapterFactory({ cell: physicalCell, preflight: preflight() })).rejects.toThrow(/not bound to this runner/u);
  });

  it("closes a runtime adapter whose identity differs from the verified preload", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const selectedAdapter = adapter({
      automation: {
        kind: "webdriver",
        driver: "different",
        version: "2.0.0",
        sha256: AUTOMATION_SHA,
      },
      close,
    });
    await register({ selectedAdapter });
    const factory = await resolveTrustedFleetAdapterFactory({ cell: physicalCell, preflight: preflight() });
    await expect(factory.create(physicalCell)).rejects.toThrow(/runtime identity differs/u);
    expect(close).toHaveBeenCalledOnce();
  });

  it("fails closed on unsupported controller platforms and unreadable bundles", async () => {
    boundary.platform = "freebsd";
    await register();
    await expect(resolveTrustedFleetAdapterFactory({ cell: physicalCell, preflight: preflight() })).rejects.toThrow(/unsupported on controller platform/u);

    boundary.platform = "linux";
    boundary.readError = new Error("disk unavailable");
    await register();
    await expect(resolveTrustedFleetAdapterFactory({ cell: physicalCell, preflight: preflight() })).rejects.toThrow(/disk unavailable/u);
  });
});
