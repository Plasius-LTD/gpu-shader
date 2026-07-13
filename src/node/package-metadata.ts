import packageMetadata from "../../package.json" with { type: "json" };

const PACKAGE_NAME = "@plasius/gpu-shader";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/** Reads release-owned metadata embedded by the package build. */
export async function readTrustedGpuShaderPackageVersion(): Promise<string> {
  if (
    packageMetadata.name === PACKAGE_NAME
    && typeof packageMetadata.version === "string"
    && SEMVER.test(packageMetadata.version)
  ) {
    return packageMetadata.version;
  }
  throw new TypeError("Trusted @plasius/gpu-shader package metadata is unavailable or invalid.");
}
