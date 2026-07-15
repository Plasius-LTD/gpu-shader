import {
  STABLE_WEBGPU_MATRIX_VERSION,
  SUPPORTED_STABLE_WEBGPU_MATRIX_POLICIES,
  type ShaderDiagnostic,
  type ShaderResult,
  type StableWebGpuMatrixManifest,
} from "../contracts.js";
import { canonicalizeGpuContract, snapshotGpuContract } from "../canonical-json.js";

function issue(message: string, path?: string): ShaderDiagnostic {
  return { code: "invalid-contract", severity: "error", message, ...(path ? { path } : {}) };
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const set = new Set(expected);
  return Object.keys(value).every((key) => set.has(key)) && expected.every((key) => Object.hasOwn(value, key));
}

function freezeJson<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeJson(child);
  return Object.freeze(value);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalizeGpuContract(left) === canonicalizeGpuContract(right);
  } catch {
    return false;
  }
}

const browserNames = new Set(["chromium", "chrome", "edge", "firefox", "safari"]);
const osNames = new Set(["ubuntu", "windows", "macos", "chromeos", "android", "ios", "ipados", "visionos"]);
const backends = new Set(["swiftshader", "d3d12", "metal", "vulkan"]);
const automation = new Set(["playwright", "webdriver", "device-farm", "safari-webdriver"]);

const VERSION_REQUIREMENTS = new Map<string, unknown>([
  ["android-adreno-chrome-vulkan", { kind: "minimum-major", value: 12 }],
  ["android-mali-chrome-vulkan", { kind: "minimum-major", value: 12 }],
  ["chromeos-arm-chrome-vulkan", { kind: "stable-channel", channel: "stable" }],
  ["chromeos-intel-chrome-vulkan", { kind: "stable-channel", channel: "stable" }],
  ["ios-iphone-safari-metal", { kind: "major", value: 26 }],
  ["ipados-ipad-safari-metal", { kind: "major", value: 26 }],
  ["macos-apple-chrome-metal", { kind: "major", value: 26 }],
  ["macos-apple-firefox-metal", { kind: "major", value: 26 }],
  ["macos-apple-safari-metal", { kind: "major", value: 26 }],
  ["swiftshader.chromium.ubuntu-x64", { kind: "exact", value: "24.04" }],
  ["ubuntu-intel-chrome-vulkan", { kind: "exact", value: "24.04" }],
  ["ubuntu-nvidia-chrome-vulkan", { kind: "exact", value: "24.04" }],
  ["visionos-safari-metal", { kind: "major", value: 26 }],
  ["win11-amd-firefox-d3d12", { kind: "major", value: 11 }],
  ["win11-intel-chrome-d3d12", { kind: "major", value: 11 }],
  ["win11-nvidia-edge-d3d12", { kind: "major", value: 11 }],
]);

const BASELINE = new Map<string, string>([
  ["android-adreno-chrome-vulkan", "chrome|android|arm64|physical|qualcomm|adreno|vulkan|playwright|self-hosted,Linux,X64,shader-validation,device-controller,physical-gpu,android-adreno,vulkan"],
  ["android-mali-chrome-vulkan", "chrome|android|arm64|physical|arm|mali|vulkan|playwright|self-hosted,Linux,X64,shader-validation,device-controller,physical-gpu,android-mali,vulkan"],
  ["chromeos-arm-chrome-vulkan", "chrome|chromeos|arm64|physical|arm|qualified-arm|vulkan|webdriver|self-hosted,Linux,X64,shader-validation,device-controller,physical-gpu,chromeos-arm,vulkan"],
  ["chromeos-intel-chrome-vulkan", "chrome|chromeos|x64|physical|intel|qualified-intel|vulkan|webdriver|self-hosted,Linux,X64,shader-validation,device-controller,physical-gpu,chromeos-intel,vulkan"],
  ["ios-iphone-safari-metal", "safari|ios|arm64|physical|apple|iphone|metal|safari-webdriver|self-hosted,macOS,ARM64,shader-validation,device-controller,physical-gpu,ios-safari,metal"],
  ["ipados-ipad-safari-metal", "safari|ipados|arm64|physical|apple|ipad|metal|safari-webdriver|self-hosted,macOS,ARM64,shader-validation,device-controller,physical-gpu,ipados-safari,metal"],
  ["macos-apple-chrome-metal", "chrome|macos|arm64|physical|apple|apple-silicon|metal|playwright|self-hosted,macOS,ARM64,shader-validation,physical-gpu,gpu-apple,metal"],
  ["macos-apple-firefox-metal", "firefox|macos|arm64|physical|apple|apple-silicon|metal|webdriver|self-hosted,macOS,ARM64,shader-validation,physical-gpu,gpu-apple,metal"],
  ["macos-apple-safari-metal", "safari|macos|arm64|physical|apple|apple-silicon|metal|safari-webdriver|self-hosted,macOS,ARM64,shader-validation,physical-gpu,gpu-apple,metal"],
  ["swiftshader.chromium.ubuntu-x64", "chromium|ubuntu|x64|software|google|swiftshader|swiftshader|playwright|ubuntu-24.04"],
  ["ubuntu-intel-chrome-vulkan", "chrome|ubuntu|x64|physical|intel|qualified-intel|vulkan|playwright|self-hosted,Linux,X64,shader-validation,physical-gpu,gpu-intel,vulkan"],
  ["ubuntu-nvidia-chrome-vulkan", "chrome|ubuntu|x64|physical|nvidia|qualified-nvidia|vulkan|playwright|self-hosted,Linux,X64,shader-validation,physical-gpu,gpu-nvidia,vulkan"],
  ["visionos-safari-metal", "safari|visionos|arm64|physical|apple|vision-pro|metal|safari-webdriver|self-hosted,macOS,ARM64,shader-validation,device-controller,physical-gpu,visionos-safari,metal"],
  ["win11-amd-firefox-d3d12", "firefox|windows|x64|physical|amd|qualified-amd|d3d12|webdriver|self-hosted,Windows,X64,shader-validation,physical-gpu,gpu-amd,d3d12"],
  ["win11-intel-chrome-d3d12", "chrome|windows|x64|physical|intel|qualified-intel|d3d12|playwright|self-hosted,Windows,X64,shader-validation,physical-gpu,gpu-intel,d3d12"],
  ["win11-nvidia-edge-d3d12", "edge|windows|x64|physical|nvidia|qualified-nvidia|d3d12|playwright|self-hosted,Windows,X64,shader-validation,physical-gpu,gpu-nvidia,d3d12"],
]);

/** Strictly validates the versioned 16-cell stable WebGPU support matrix. */
export function validateStableWebGpuMatrix(value: unknown): ShaderResult<StableWebGpuMatrixManifest> {
  let snapshot: unknown;
  try {
    snapshot = snapshotGpuContract(value);
  } catch {
    return { ok: false, diagnostics: [issue("Matrix must contain bounded detached JSON contract data.")] };
  }
  const matrix = object(snapshot);
  const diagnostics: ShaderDiagnostic[] = [];
  if (!matrix || !keys(matrix, ["contractVersion", "matrixId", "version", "policy", "cells"])) {
    return { ok: false, diagnostics: [issue("Matrix has unknown or missing top-level fields.")] };
  }
  if (matrix.contractVersion !== STABLE_WEBGPU_MATRIX_VERSION) diagnostics.push(issue("Unsupported matrix contract version.", "contractVersion"));
  const stablePolicy = SUPPORTED_STABLE_WEBGPU_MATRIX_POLICIES[0];
  if (matrix.matrixId !== stablePolicy?.matrixId || matrix.version !== stablePolicy.matrixVersion) diagnostics.push(issue("Matrix identity/version differs from the supported universal policy."));
  const policy = object(matrix.policy);
  const policyKeys = ["coverage", "unavailable", "skipped", "timeout", "deviceLoss", "requiredPhysicalCellCount", "requiredBlockingCellCount"];
  if (!policy || !keys(policy, policyKeys)
    || policy.coverage !== "all-cells-required"
    || policy.unavailable !== "fail"
    || policy.skipped !== "fail"
    || policy.timeout !== "fail"
    || policy.deviceLoss !== "fail"
    || policy.requiredPhysicalCellCount !== 15
    || policy.requiredBlockingCellCount !== 16) {
    diagnostics.push(issue("Matrix policy must fail closed with 15 physical and 16 blocking cells.", "policy"));
  }
  if (!Array.isArray(matrix.cells) || matrix.cells.length !== 16) {
    diagnostics.push(issue("Stable WebGPU matrix must contain exactly 16 cells.", "cells"));
    return { ok: false, diagnostics };
  }
  const ids = new Set<string>();
  let physical = 0;
  let blocking = 0;
  let software = 0;
  for (const [index, raw] of matrix.cells.entries()) {
    const path = `cells[${index}]`;
    const cell = object(raw);
    if (!cell || !keys(cell, [
      "cellId", "runnerLabels", "browser", "os", "adapter", "automation", "timeoutMs", "blocking", "countsTowardStableCoverage",
    ])) {
      diagnostics.push(issue("Matrix cell has unknown or missing fields.", path));
      continue;
    }
    if (typeof cell.cellId !== "string" || !/^[a-z0-9][a-z0-9._-]+$/u.test(cell.cellId) || ids.has(cell.cellId)) diagnostics.push(issue("Cell ID is invalid or duplicated.", `${path}.cellId`));
    else ids.add(cell.cellId);
    if (!Array.isArray(cell.runnerLabels) || cell.runnerLabels.length === 0 || cell.runnerLabels.some((label) => typeof label !== "string" || !label) || new Set(cell.runnerLabels).size !== cell.runnerLabels.length) diagnostics.push(issue("Runner labels must be unique non-empty strings.", `${path}.runnerLabels`));
    const browser = object(cell.browser);
    const os = object(cell.os);
    const adapter = object(cell.adapter);
    const adapterAutomation = object(cell.automation);
    if (!browser || !keys(browser, ["name", "channel"]) || !browserNames.has(String(browser.name))) diagnostics.push(issue("Browser descriptor is invalid.", `${path}.browser`));
    if (!os || !keys(os, ["name", "versionRequirement", "architecture"]) || !osNames.has(String(os.name)) || !["x64", "arm64"].includes(String(os.architecture))) diagnostics.push(issue("OS descriptor is invalid.", `${path}.os`));
    else {
      const requirement = object(os.versionRequirement); const kind = String(requirement?.kind);
      const validRequirement = requirement && (kind === "exact"
        ? keys(requirement, ["kind", "value"]) && typeof requirement.value === "string" && /^\d+(?:\.\d+)*$/u.test(requirement.value)
        : kind === "major" || kind === "minimum-major"
          ? keys(requirement, ["kind", "value"]) && Number.isSafeInteger(requirement.value) && Number(requirement.value) > 0
          : kind === "stable-channel" && keys(requirement, ["kind", "channel"]) && requirement.channel === "stable");
      if (!validRequirement) diagnostics.push(issue("OS version requirement is invalid.", `${path}.os.versionRequirement`));
      if (typeof cell.cellId === "string"
        && !canonicalEqual(requirement, VERSION_REQUIREMENTS.get(cell.cellId))) {
        diagnostics.push(issue("OS version requirement differs from the stable baseline.", `${path}.os.versionRequirement`));
      }
    }
    if (!adapter || !keys(adapter, ["kind", "vendor", "family", "backend"]) || !["software", "physical"].includes(String(adapter.kind)) || !backends.has(String(adapter.backend))) diagnostics.push(issue("Adapter descriptor is invalid.", `${path}.adapter`));
    if (!adapterAutomation || !keys(adapterAutomation, ["kind"]) || !automation.has(String(adapterAutomation.kind))) diagnostics.push(issue("Automation descriptor is invalid.", `${path}.automation`));
    const signature = `${String(browser?.name)}|${String(os?.name)}|${String(os?.architecture)}|${String(adapter?.kind)}|${String(adapter?.vendor)}|${String(adapter?.family)}|${String(adapter?.backend)}|${String(adapterAutomation?.kind)}|${Array.isArray(cell.runnerLabels) ? cell.runnerLabels.join(",") : ""}`;
    if (typeof cell.cellId === "string" && BASELINE.get(cell.cellId) !== signature) diagnostics.push(issue("Cell identity, target, automation, or runner labels differ from the stable baseline.", path));
    if (typeof cell.cellId === "string" && [...BASELINE.keys()][index] !== cell.cellId) diagnostics.push(issue("Stable matrix cells must remain in fixed code-unit order.", `${path}.cellId`));
    if (!Number.isSafeInteger(cell.timeoutMs) || Number(cell.timeoutMs) < 1000 || Number(cell.timeoutMs) > 3_600_000) diagnostics.push(issue("Cell timeout must be bounded.", `${path}.timeoutMs`));
    if (cell.blocking !== true) diagnostics.push(issue("Every stable matrix cell must block delivery.", `${path}.blocking`));
    else blocking += 1;
    if (adapter?.kind === "physical") {
      physical += 1;
      if (browser?.channel !== "stable" || cell.countsTowardStableCoverage !== true) diagnostics.push(issue("Physical cells must use stable browsers and count toward stable coverage.", path));
    } else if (adapter?.kind === "software") {
      software += 1;
      if (adapter.backend !== "swiftshader" || browser?.name !== "chromium" || browser.channel !== "playwright-bundled" || cell.countsTowardStableCoverage !== false) diagnostics.push(issue("The sole software lane must be bundled Chromium with SwiftShader smoke coverage.", path));
    }
  }
  if (physical !== 15 || blocking !== 16 || software !== 1 || ids.size !== BASELINE.size) diagnostics.push(issue("Matrix must contain the exact 15 physical baseline cells plus one SwiftShader smoke cell."));
  return diagnostics.length > 0
    ? { ok: false, diagnostics }
    : { ok: true, value: freezeJson(matrix as unknown as StableWebGpuMatrixManifest) };
}
