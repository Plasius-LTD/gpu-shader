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
  const peers = raw.peerDependencies;
  if (typeof peers !== "object" || peers === null || Array.isArray(peers)) {
    throw new TypeError("Trusted harness peerDependencies are invalid.");
  }
  const playwrightCoreVersion = (peers as Record<string, unknown>)["playwright-core"];
  if (typeof playwrightCoreVersion !== "string" || !/^\d+\.\d+\.\d+$/u.test(playwrightCoreVersion)) {
    throw new TypeError("Trusted harness must pin an exact playwright-core version.");
  }
  const metadata = raw.peerDependenciesMeta;
  const playwright = typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)["playwright-core"] : undefined;
  if (typeof playwright !== "object" || playwright === null || Array.isArray(playwright)
    || (playwright as Record<string, unknown>).optional !== true) {
    throw new TypeError("Trusted harness playwright-core peer must be optional.");
  }
  return { name: raw.name, version: raw.version, playwrightCoreVersion };
}
