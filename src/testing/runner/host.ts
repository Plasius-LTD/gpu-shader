import { readFile } from "node:fs/promises";
import { arch, hostname, platform, release } from "node:os";
import type { StableWebGpuMatrixCell } from "../../contracts.js";
import type { TrustedRunnerHostObservation } from "./types.js";

function normalizedArchitecture(): "x64" | "arm64" {
  const value = arch();
  if (value !== "x64" && value !== "arm64") throw new TypeError(`Unsupported qualification host architecture ${value}.`);
  return value;
}

async function linuxRelease(): Promise<{ readonly name: string; readonly version: string }> {
  const input = await readFile("/etc/os-release", "utf8");
  const values = new Map<string, string>();
  for (const line of input.split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    const raw = line.slice(separator + 1).trim();
    values.set(key, raw.replace(/^"|"$/gu, ""));
  }
  const identifier = values.get("ID")?.toLowerCase();
  return {
    name: identifier === "ubuntu" ? "ubuntu" : identifier ?? "linux",
    version: values.get("VERSION_ID") ?? release(),
  };
}

/** Reads host facts from the trusted process and fixed workflow route. */
export async function observeTrustedRunnerHost(
  cell: StableWebGpuMatrixCell,
  apiRunner: { readonly name: string; readonly labels: readonly string[] },
): Promise<TrustedRunnerHostObservation> {
  const architecture = normalizedArchitecture();
  let name: string;
  let version: string;
  if (platform() === "linux") {
    ({ name, version } = await linuxRelease());
  } else if (platform() === "darwin") {
    name = "macos";
    version = process.env.PLASIUS_SHADER_OS_VERSION ?? release();
  } else if (platform() === "win32") {
    name = "windows";
    version = process.env.PLASIUS_SHADER_OS_VERSION ?? release();
  } else {
    throw new TypeError(`Unsupported qualification host platform ${platform()}.`);
  }
  if (cell.cellId === "swiftshader.chromium.ubuntu-x64") {
    const requirement = cell.os.versionRequirement;
    if (name !== "ubuntu" || requirement.kind !== "exact" || version !== requirement.value || architecture !== cell.os.architecture) {
      throw new TypeError(`SwiftShader runner host ${name}/${version}/${architecture} differs from its exact matrix route.`);
    }
  }
  const actualRunnerName = process.env.RUNNER_NAME?.trim() || hostname();
  if (actualRunnerName !== apiRunner.name) throw new TypeError("Execution runner name differs from API-verified runner preflight evidence.");
  return {
    runner: {
      id: actualRunnerName,
      labels: [...apiRunner.labels],
    },
    os: { name, version, channel: null, architecture },
  };
}
