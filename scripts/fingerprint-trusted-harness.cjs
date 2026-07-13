#!/usr/bin/env node

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function fail(message) {
  throw new Error(message);
}

function trackedFiles(root) {
  return execFileSync("git", ["-C", root, "ls-files", "-z"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function builtFiles(root) {
  const dist = path.join(root, "dist");
  if (!fs.existsSync(dist) || !fs.lstatSync(dist).isDirectory()) {
    fail("Trusted harness dist directory is missing; build before fingerprinting.");
  }

  const result = [];
  const pending = [dist];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        fail("Built trusted harness contains an unexpected symbolic link.");
      }
      if (stat.isDirectory()) {
        pending.push(absolute);
      } else if (stat.isFile()) {
        result.push(path.relative(root, absolute).split(path.sep).join("/"));
      } else {
        fail("Built trusted harness contains an unexpected file type.");
      }
    }
  }
  return result;
}

function main() {
  const root = path.resolve(process.argv[2] || ".");
  const expected = process.argv[3] || "";
  if (process.argv.length > 4) fail("Usage: fingerprint-trusted-harness.cjs [root] [expected-sha256]");
  if (expected && !/^[a-f0-9]{64}$/.test(expected)) {
    fail("Expected trusted harness fingerprint must be a lowercase SHA-256 digest.");
  }

  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const expectedCommit = process.env.PLASIUS_EXPECTED_HARNESS_COMMIT_SHA || "";
  if (expectedCommit && commit !== expectedCommit) {
    fail("Checked-out harness commit differs from the trusted workflow commit.");
  }

  execFileSync("git", ["-C", root, "diff", "--exit-code", "--", "."], {
    stdio: "inherit",
  });

  const files = Array.from(new Set([...trackedFiles(root), ...builtFiles(root)])).sort();
  const hash = crypto.createHash("sha256");
  hash.update("plasius.gpu.trusted-harness/v1\n");
  for (const relative of files) {
    const absolute = path.join(root, ...relative.split("/"));
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile()) fail("Trusted harness digest accepts only regular files.");
    const bytes = fs.readFileSync(absolute);
    hash.update(relative + "\0" + String(bytes.byteLength) + "\0");
    hash.update(bytes);
  }

  const actual = hash.digest("hex");
  if (expected && actual !== expected) {
    fail("Rebuilt trusted harness differs from the OIDC-bound prepare harness.");
  }
  process.stdout.write(actual + "\n");
}

try {
  main();
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
}
