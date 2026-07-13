import { lstat, readFile, realpath } from "node:fs/promises";
import { platform } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ShaderQualificationPreflightManifest,
  Sha256Hex,
  StableWebGpuMatrixCell,
} from "../../contracts.js";
import { computeSha256 } from "../../hash.js";
import type { TrustedQualificationAdapterFactory } from "./types.js";

export const TRUSTED_FLEET_REGISTRATION_SYMBOL = Symbol.for("@plasius/gpu-shader/trusted-fleet-adapter/v1");

interface TrustedFleetRegistration {
  readonly contractVersion: "1.0.0";
  readonly moduleUrl: string;
  readonly adapterHarness: { readonly id: string; readonly version: string; readonly sha256: Sha256Hex };
  readonly qualificationHarnessSha256: Sha256Hex;
  readonly runnerName: string;
  readonly allowedCellIds: readonly string[];
  readonly factory: TrustedQualificationAdapterFactory;
}

function trustedRoot(): string {
  if (platform() === "linux") return "/opt/plasius/webgpu-fleet";
  if (platform() === "darwin") return "/Library/Application Support/Plasius/WebGPUFleet";
  if (platform() === "win32") return "C:\\ProgramData\\Plasius\\WebGPUFleet";
  throw new TypeError(`Physical fleet adapters are unsupported on controller platform ${platform()}.`);
}

function registration(): TrustedFleetRegistration {
  const value = (globalThis as Record<PropertyKey, unknown>)[TRUSTED_FLEET_REGISTRATION_SYMBOL];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("No preload-only trusted physical fleet adapter is registered in this process.");
  }
  const candidate = value as Partial<TrustedFleetRegistration>;
  if (candidate.contractVersion !== "1.0.0" || typeof candidate.moduleUrl !== "string"
    || typeof candidate.runnerName !== "string" || !Array.isArray(candidate.allowedCellIds)
    || typeof candidate.factory?.create !== "function" || typeof candidate.adapterHarness !== "object"
    || candidate.adapterHarness === null) {
    throw new TypeError("Trusted physical fleet adapter registration is malformed.");
  }
  return candidate as TrustedFleetRegistration;
}

function assertSelfContainedModule(source: Uint8Array): void {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  if (text.includes("`")) throw new TypeError("Trusted fleet adapter must be a self-contained bundle without template literals.");
  let stripped = "";
  let state: "code" | "single" | "double" | "line" | "block" = "code";
  for (let index = 0; index < text.length; index += 1) {
    const value = text[index]!; const next = text[index + 1];
    if (state === "code") {
      if (value === "'") { state = "single"; stripped += " "; }
      else if (value === "\"") { state = "double"; stripped += " "; }
      else if (value === "/" && next === "/") { state = "line"; stripped += "  "; index += 1; }
      else if (value === "/" && next === "*") { state = "block"; stripped += "  "; index += 1; }
      else stripped += value;
    } else if (state === "line") {
      if (value === "\n") { state = "code"; stripped += "\n"; } else stripped += " ";
    } else if (state === "block") {
      if (value === "*" && next === "/") { state = "code"; stripped += "  "; index += 1; } else stripped += value === "\n" ? "\n" : " ";
    } else if (value === "\\") {
      stripped += "  "; index += 1;
    } else if (state === "single" && value === "'" || state === "double" && value === "\"") {
      state = "code"; stripped += " ";
    } else stripped += value === "\n" ? "\n" : " ";
  }
  if (state !== "code" && state !== "line") throw new TypeError("Trusted fleet adapter source is lexically incomplete.");
  if (/(?:^|[^A-Za-z0-9_$])(?:import|require|createRequire|eval|Function)(?:[^A-Za-z0-9_$]|$)/u.test(stripped)) {
    throw new TypeError("Trusted fleet adapter must be a single-file bundle with no transitive code loading.");
  }
}

/** Resolves only runner-preloaded, allowlisted, digest-bound physical executable code. */
export async function resolveTrustedFleetAdapterFactory(input: {
  readonly cell: StableWebGpuMatrixCell;
  readonly preflight: ShaderQualificationPreflightManifest;
}): Promise<TrustedQualificationAdapterFactory> {
  if (input.cell.adapter.kind !== "physical") throw new TypeError("Fleet adapter registration is restricted to physical cells.");
  const selected = registration();
  const configuredUrl = process.env.PLASIUS_TRUSTED_FLEET_ADAPTER_URL?.trim();
  if (!configuredUrl || configuredUrl !== selected.moduleUrl) {
    throw new TypeError("Trusted fleet adapter URL differs from fixed runner configuration.");
  }
  let modulePath: string;
  try {
    const url = new URL(selected.moduleUrl);
    if (url.protocol !== "file:") throw new TypeError("not file");
    modulePath = resolve(fileURLToPath(url));
  } catch (cause) {
    throw new TypeError("Trusted fleet adapter URL must be an absolute file URL.", { cause });
  }
  const stats = await lstat(modulePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new TypeError("Trusted fleet adapter must be a regular non-linked file.");
  }
  modulePath = await realpath(modulePath);
  const root = await realpath(resolve(trustedRoot()));
  const child = relative(root, modulePath);
  if (!child || child.startsWith("..") || isAbsolute(child) || !modulePath.endsWith(".mjs")) {
    throw new TypeError("Trusted fleet adapter is outside its fixed OS-specific runner-owned root.");
  }
  const moduleBytes = new Uint8Array(await readFile(modulePath));
  assertSelfContainedModule(moduleBytes);
  const fileSha256 = await computeSha256(moduleBytes);
  const actualSha256 = await computeSha256(`plasius.trusted-fleet-adapter-single-file/v1\n${fileSha256}`);
  const expectedEnvironmentSha256 = process.env.PLASIUS_TRUSTED_FLEET_ADAPTER_SHA256?.trim();
  if (!expectedEnvironmentSha256
    || actualSha256 !== expectedEnvironmentSha256
    || actualSha256 !== selected.adapterHarness.sha256) {
    throw new TypeError("Trusted fleet adapter executable identity differs from runner-owned calibration.");
  }
  if (selected.qualificationHarnessSha256 !== input.preflight.harnessSha256
    || selected.runnerName !== process.env.RUNNER_NAME
    || !selected.allowedCellIds.includes(input.cell.cellId)) {
    throw new TypeError("Trusted fleet adapter registration is not bound to this runner, harness, and matrix cell.");
  }
  return {
    async create(cell): Promise<Awaited<ReturnType<TrustedQualificationAdapterFactory["create"]>>> {
      const adapter = await selected.factory.create(cell);
      if (adapter.automation.driver !== selected.adapterHarness.id
        || adapter.automation.version !== selected.adapterHarness.version
        || adapter.automation.sha256 !== selected.adapterHarness.sha256) {
        await adapter.close().catch(() => undefined);
        throw new TypeError("Fleet adapter runtime identity differs from its verified preload bundle.");
      }
      return adapter;
    },
  };
}
