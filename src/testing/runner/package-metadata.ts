import packageMetadata from "../../../package.json" with { type: "json" };

export interface TrustedHarnessPackageMetadata {
  readonly name: "@plasius/gpu-shader";
  readonly version: string;
  readonly playwrightCoreVersion: string;
}

/** Reads release-owned package metadata embedded by the trusted harness build. */
export async function readTrustedHarnessPackageMetadata(): Promise<TrustedHarnessPackageMetadata> {
  const raw: Record<string, unknown> = packageMetadata;
  if (raw.name !== "@plasius/gpu-shader" || typeof raw.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(raw.version)) {
    throw new TypeError("Trusted harness package identity/version is invalid.");
  }
  const optional = raw.optionalDependencies;
  if (typeof optional !== "object" || optional === null || Array.isArray(optional)) {
    throw new TypeError("Trusted harness optionalDependencies are invalid.");
  }
  const playwrightCoreVersion = (optional as Record<string, unknown>)["playwright-core"];
  if (typeof playwrightCoreVersion !== "string" || !/^\d+\.\d+\.\d+$/u.test(playwrightCoreVersion)) {
    throw new TypeError("Trusted harness must pin an exact playwright-core version.");
  }
  return { name: raw.name, version: raw.version, playwrightCoreVersion };
}
