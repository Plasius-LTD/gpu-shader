#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_TARBALL_BYTES = 50 * 1024 * 1024;

function parsePackResult(raw, expectedName, expectedVersion) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error("npm pack did not return valid JSON.", { cause });
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0]) {
    throw new Error("npm pack must return exactly one package artifact.");
  }

  const result = parsed[0];
  if (result.name !== expectedName || result.version !== expectedVersion) {
    throw new Error(
      `Packed package identity ${String(result.name)}@${String(result.version)} differs from ${expectedName}@${expectedVersion}.`
    );
  }
  if (
    typeof result.filename !== "string" ||
    result.filename !== path.basename(result.filename) ||
    !/^[A-Za-z0-9._-]+[.]tgz$/u.test(result.filename)
  ) {
    throw new Error("npm pack returned an unsafe tarball filename.");
  }
  if (
    typeof result.integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(result.integrity) ||
    Buffer.from(result.integrity.slice("sha512-".length), "base64").length !== 64
  ) {
    throw new Error("npm pack returned an invalid SHA-512 integrity value.");
  }
  if (typeof result.shasum !== "string" || !/^[a-f0-9]{40}$/u.test(result.shasum)) {
    throw new Error("npm pack returned an invalid SHA-1 shasum.");
  }
  if (!Number.isSafeInteger(result.size) || result.size <= 0 || result.size > MAX_TARBALL_BYTES) {
    throw new Error("npm pack returned an invalid or oversized tarball size.");
  }

  return {
    filename: result.filename,
    integrity: result.integrity,
    shasum: result.shasum,
    size: result.size,
  };
}

function appendOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    fs.appendFileSync(outputPath, `${name}=${value}\n`, "utf8");
  }
}

function resolveReleaseOutputDirectory(requested, workspace = process.cwd()) {
  if (requested !== "release-artifacts") {
    throw new Error("The release output directory must be exactly release-artifacts.");
  }
  return path.join(fs.realpathSync(workspace), requested);
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) {
    throw new Error("Usage: prepare-npm-release.cjs <output-directory>");
  }

  const expectedName = process.env.EXPECTED_PACKAGE_NAME || "";
  const expectedVersion = process.env.EXPECTED_PACKAGE_VERSION || "";
  if (!/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/u.test(expectedName)) {
    throw new Error("EXPECTED_PACKAGE_NAME must be a lowercase scoped npm package name.");
  }
  if (!/^[0-9]+[.][0-9]+[.][0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/u.test(expectedVersion)) {
    throw new Error("EXPECTED_PACKAGE_VERSION must be a valid supported semantic version.");
  }

  const outputDirectory = resolveReleaseOutputDirectory(argv[0]);
  fs.rmSync(outputDirectory, { recursive: true, force: true });
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });

  const raw = execFileSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", outputDirectory],
    { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
  );
  const packed = parsePackResult(raw, expectedName, expectedVersion);
  const tarballPath = path.resolve(outputDirectory, packed.filename);
  const realOutputDirectory = fs.realpathSync(outputDirectory);
  const realTarballPath = fs.realpathSync(tarballPath);
  if (!realTarballPath.startsWith(`${realOutputDirectory}${path.sep}`)) {
    throw new Error("Packed tarball escaped its isolated output directory.");
  }
  const stat = fs.statSync(realTarballPath);
  if (!stat.isFile() || stat.size !== packed.size || stat.size > MAX_TARBALL_BYTES) {
    throw new Error("Packed tarball bytes differ from npm pack metadata.");
  }
  const tarballBytes = fs.readFileSync(realTarballPath);
  const computedIntegrity = `sha512-${crypto.createHash("sha512").update(tarballBytes).digest("base64")}`;
  const computedShasum = crypto.createHash("sha1").update(tarballBytes).digest("hex");
  if (computedIntegrity !== packed.integrity || computedShasum !== packed.shasum) {
    throw new Error("Packed tarball digests differ from npm pack metadata.");
  }

  const relativeTarballPath = path.relative(process.cwd(), realTarballPath).split(path.sep).join("/");
  if (relativeTarballPath.startsWith("../") || path.isAbsolute(relativeTarballPath)) {
    throw new Error("Packed tarball is outside the release workspace.");
  }

  appendOutput("tarball_path", relativeTarballPath);
  appendOutput("integrity", packed.integrity);
  appendOutput("shasum", packed.shasum);
  appendOutput("size", String(packed.size));
  process.stdout.write(
    `${JSON.stringify({ tarballPath: relativeTarballPath, ...packed }, null, 2)}\n`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  }
}

module.exports = { MAX_TARBALL_BYTES, main, parsePackResult, resolveReleaseOutputDirectory };
