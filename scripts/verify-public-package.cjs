#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  collectRepositoryArtifactPaths,
  comparePackageArtifactAllowlist,
  findPackageFilesPolicyViolations,
  findPrivateArtifactViolations,
  normalizePackageArtifactPath,
} = require("./private-artifact-policy.cjs");

const EXPECTED_PACKAGE_FILES = Object.freeze(["dist", "matrices"]);
const EXPECTED_PACKED_PATHS = Object.freeze([
  "LICENSE",
  "README.md",
  "dist/cli.cjs",
  "dist/cli.cjs.map",
  "dist/cli.d.cts",
  "dist/cli.d.ts",
  "dist/cli.js",
  "dist/cli.js.map",
  "dist/contracts-B49AUejk.d.cts",
  "dist/contracts-B49AUejk.d.ts",
  "dist/index.cjs",
  "dist/index.cjs.map",
  "dist/index.d.cts",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/index.js.map",
  "dist/node.cjs",
  "dist/node.cjs.map",
  "dist/node.d.cts",
  "dist/node.d.ts",
  "dist/node.js",
  "dist/node.js.map",
  "dist/testing.cjs",
  "dist/testing.cjs.map",
  "dist/testing.d.cts",
  "dist/testing.d.ts",
  "dist/testing.js",
  "dist/testing.js.map",
  "matrices/stable-webgpu-2026-07-13.json",
  "package.json",
]);

function main() {
  const cacheDir = path.resolve(process.cwd(), ".npm-cache-packcheck");

  try {
    const repositoryPrivateArtifactViolations = findPrivateArtifactViolations(
      collectRepositoryArtifactPaths(process.cwd())
    );
    if (repositoryPrivateArtifactViolations.length > 0) {
      return reportPrivateArtifactViolations(
        "Public package check stopped before npm pack. Prohibited private artifact paths found:",
        repositoryPrivateArtifactViolations
      );
    }

    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")
    );
    const packageFilesViolations = findPackageFilesPolicyViolations(
      packageJson.files,
      EXPECTED_PACKAGE_FILES
    );
    if (packageFilesViolations.length > 0) {
      console.error(
        "Public package check stopped before npm pack. package.json files policy failed:"
      );
      for (const violation of packageFilesViolations) {
        console.error(`- ${violation.entry} (${violation.ruleId})`);
      }
      return 1;
    }

    const output = runNpmPack(cacheDir);
    const parsed = parseNpmPackJson(output);
    const files = Array.isArray(parsed) && parsed[0]?.files ? parsed[0].files : [];
    const paths = files.map((entry) => entry.path);
    const normalizedPaths = paths.map(normalizePackageArtifactPath);

    const privateArtifactViolations = findPrivateArtifactViolations(paths);
    if (privateArtifactViolations.length > 0) {
      return reportPrivateArtifactViolations(
        "Public package check failed. Prohibited private artifact paths found:",
        privateArtifactViolations
      );
    }

    const packageAllowlist = comparePackageArtifactAllowlist(
      paths,
      EXPECTED_PACKED_PATHS
    );
    if (
      packageAllowlist.missingPaths.length > 0 ||
      packageAllowlist.unexpectedPaths.length > 0
    ) {
      console.error("Public package check failed. Packed paths differ from the allowlist:");
      for (const filePath of packageAllowlist.missingPaths) {
        console.error(`- missing: ${filePath}`);
      }
      for (const filePath of packageAllowlist.unexpectedPaths) {
        console.error(`- unexpected: ${filePath}`);
      }
      return 1;
    }

    const forbiddenTarballPathPatterns = [
      {
        label: "private monorepo path",
        regex: /(?:^|\/)plasius-ltd-site(?:\/|$)/i,
      },
      {
        label: "private app runtime path",
        regex: /(?:^|\/)(frontend|backend|dashboard|infra)(?:\/|$)/i,
      },
      {
        label: "local settings artifact",
        regex: /(?:^|\/)local\.settings(?:\.[^/]+)?\.json$/i,
      },
      {
        label: "azure host artifact",
        regex: /(?:^|\/)host\.json$/i,
      },
      {
        label: "generated tsp artifact",
        regex: /(?:^|\/)tsp-output(?:\/|$)/i,
      },
      {
        label: "uncompiled source or test path",
        regex: /(?:^|\/)(src|tests|coverage|node_modules)(?:\/|$)/i,
      },
      {
        label: "local environment file",
        regex: /(?:^|\/)\.env(?:\.[^/]+)?$/i,
      },
      {
        label: "qualification candidate artifact",
        regex: /(?:^|\/)(build-artifacts|qualification-results)(?:\/|$)/i,
      },
    ];

    const forbiddenPaths = normalizedPaths.filter((filePath) =>
      forbiddenTarballPathPatterns.some(({ regex }) => regex.test(filePath))
    );

    if (forbiddenPaths.length > 0) {
      console.error("Public package check failed. Forbidden publish paths found:");
      for (const filePath of forbiddenPaths) {
        console.error(`- ${filePath}`);
      }
      return 1;
    }

    const forbiddenCodeReferencePatterns = [
      {
        label: "private monorepo reference",
        regex: /\bplasius-ltd-site\b/i,
      },
      {
        label: "proprietary PGP artifact reference",
        regex: /\bpgp[-_a-z0-9]*\b/i,
      },
      {
        label: "proprietary Lunari artifact reference",
        regex: /\blunari\b/i,
      },
      {
        label: "proprietary Pixelverse artifact reference",
        regex: /\bpixelverse\b/i,
      },
    ];

    const codeRoots = ["src", "tests", "demo", "dist"];
    const codeExtensions = new Set([
      ".ts",
      ".tsx",
      ".js",
      ".mjs",
      ".cjs",
      ".json",
    ]);
    const violations = scanCodeReferences(
      codeRoots,
      codeExtensions,
      forbiddenCodeReferencePatterns
    );

    if (violations.length > 0) {
      console.error(
        "Public package check failed. Forbidden private/product code references found:"
      );
      for (const violation of violations) {
        console.error(`- ${violation.file}:${violation.line} (${violation.label})`);
      }
      return 1;
    }

    validatePackageMetadata(normalizedPaths);
    validatePublishedMatrix();

    console.log("Public package check passed.");
    return 0;
  } finally {
    fs.rmSync(cacheDir, { force: true, recursive: true });
  }
}

function runNpmPack(cacheDir) {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : "npm";
  const args = npmExecPath
    ? [npmExecPath, "pack", "--dry-run", "--json", "--ignore-scripts"]
    : ["pack", "--dry-run", "--json", "--ignore-scripts"];
  args.push("--cache", cacheDir);

  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function reportPrivateArtifactViolations(message, violations) {
  console.error(message);
  for (const violation of violations) {
    console.error(`- ${violation.artifactPath} (${violation.ruleId})`);
  }
  return 1;
}

function validatePackageMetadata(packedPaths) {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")
  );
  if (pkg.name !== "@plasius/gpu-shader") {
    throw new Error("Public package check failed: package name must be @plasius/gpu-shader.");
  }
  if (pkg.private === true || pkg.license !== "Apache-2.0") {
    throw new Error("Public package check failed: package must be public and Apache-2.0 licensed.");
  }
  if (pkg.publishConfig?.access !== "public") {
    throw new Error("Public package check failed: publishConfig.access must be public.");
  }

  const targets = [];
  for (const value of Object.values(pkg.exports || {})) {
    if (typeof value === "string") targets.push(value);
    else if (value && typeof value === "object") {
      for (const target of Object.values(value)) {
        if (typeof target === "string") targets.push(target);
      }
    }
  }
  if (typeof pkg.bin?.["plasius-gpu-shader"] === "string") {
    targets.push(pkg.bin["plasius-gpu-shader"]);
  } else {
    throw new Error("Public package check failed: CLI bin entry is missing.");
  }

  const normalized = new Set(packedPaths.map((entry) => `./${entry}`));
  const missingTargets = targets.filter(
    (target) => target !== "./package.json" && !normalized.has(target)
  );
  if (missingTargets.length > 0) {
    throw new Error(
      `Public package check failed: export/bin targets are missing: ${missingTargets.join(", ")}`
    );
  }
}

function validatePublishedMatrix() {
  const matrixPath = path.resolve(
    process.cwd(),
    "matrices/stable-webgpu-2026-07-13.json"
  );
  const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
  const cells = Array.isArray(matrix.cells) ? matrix.cells : [];
  const physical = cells.filter(
    (cell) =>
      cell?.adapter?.kind === "physical" &&
      cell.countsTowardStableCoverage === true
  );
  const blocking = cells.filter((cell) => cell?.blocking === true);
  const software = cells.filter((cell) => cell?.adapter?.kind === "software");
  if (
    matrix?.contractVersion !== "1.0.0" ||
    matrix?.matrixId !== "stable-webgpu" ||
    matrix?.version !== "2026-07-13" ||
    matrix?.policy?.coverage !== "all-cells-required" ||
    matrix?.policy?.unavailable !== "fail" ||
    matrix?.policy?.skipped !== "fail" ||
    matrix?.policy?.timeout !== "fail" ||
    matrix?.policy?.deviceLoss !== "fail" ||
    cells.length !== 16 ||
    physical.length !== 15 ||
    blocking.length !== 16 ||
    physical.some((cell) => cell.blocking !== true) ||
    software.length !== 1 ||
    software[0]?.adapter?.backend !== "swiftshader" ||
    software[0]?.blocking !== true ||
    software[0]?.countsTowardStableCoverage !== false ||
    matrix?.policy?.requiredPhysicalCellCount !== physical.length ||
    matrix?.policy?.requiredBlockingCellCount !== blocking.length
  ) {
    throw new Error(
      "Public package check failed: published stable WebGPU matrix is incomplete or non-blocking."
    );
  }
}

function parseNpmPackJson(rawOutput) {
  const start = rawOutput.indexOf("[");
  const end = rawOutput.lastIndexOf("]");

  if (start < 0 || end < start) {
    throw new Error("Could not find npm pack JSON payload in command output.");
  }

  const jsonSlice = rawOutput.slice(start, end + 1);
  return JSON.parse(jsonSlice);
}

function scanCodeReferences(roots, extensions, patterns) {
  const allFiles = [];
  for (const root of roots) {
    allFiles.push(...collectFiles(path.resolve(process.cwd(), root), extensions));
  }

  const violations = [];
  for (const file of allFiles) {
    const contents = fs.readFileSync(file, "utf8");

    for (const pattern of patterns) {
      const matchIndex = contents.search(pattern.regex);
      if (matchIndex < 0) {
        continue;
      }

      const beforeMatch = contents.slice(0, matchIndex);
      const line = beforeMatch.split(/\r?\n/u).length;
      violations.push({
        file: path.relative(process.cwd(), file),
        line,
        label: pattern.label,
      });
      break;
    }
  }

  return violations;
}

function collectFiles(root, extensions) {
  if (!fs.existsSync(root)) {
    return [];
  }

  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "dist-cjs"
      ) {
        continue;
      }
      files.push(...collectFiles(fullPath, extensions));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (extensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`Public package check failed: ${error.message}`);
  process.exitCode = 1;
}
