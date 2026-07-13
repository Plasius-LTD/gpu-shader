#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

function parseArgs(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name || !name.startsWith("--") || !value || value.startsWith("--") || result.has(name)) {
      throw new Error("Invalid or duplicate workflow-cell argument " + String(name || "<missing>"));
    }
    result.set(name, value);
  }
  return result;
}

function exactArgs(args, names) {
  const expected = new Set(names);
  for (const name of args.keys()) {
    if (!expected.has(name)) throw new Error("Unsupported workflow-cell argument " + name);
  }
  for (const name of names) {
    if (!args.has(name)) throw new Error(name + " is required.");
  }
}

function terminate(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "inherit",
      timeout: 10_000,
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 5_000).unref();
}

function runDiagnostic(options) {
  const output = path.join(
    options.evidenceDirectory,
    options.cellId + (options.status === "timeout" ? ".watchdog.json" : ".failure.json")
  );
  const completeJson = (file, kind) => {
    if (!fs.existsSync(file)) return false;
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!value || typeof value !== "object" || value.cellId !== options.cellId) return false;
      if (value.qualificationId !== process.env.PLASIUS_QUALIFICATION_ID) return false;
      return kind === "diagnostic"
        ? value.kind === "non-qualifying-workflow-diagnostic"
          && (value.status === "failed" || value.status === "timeout")
        : Array.isArray(value.results) && value.producer && value.qualificationPreflightProvenance;
    } catch {
      return false;
    }
  };
  if (completeJson(options.evidenceOutput, "evidence") || completeJson(output, "diagnostic")) return;
  for (const partial of [options.evidenceOutput, output]) {
    if (fs.existsSync(partial)) fs.unlinkSync(partial);
  }
  const result = spawnSync(process.execPath, [
    options.cli,
    "create-workflow-diagnostic",
    "--matrix", options.matrix,
    "--cell", options.cellId,
    "--preflight", options.preflight,
    "--status", options.status,
    "--message", options.message,
    "--output", output,
  ], { stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error("Trusted workflow diagnostic creation failed.");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const names = [
    "--cli",
    "--bundle",
    "--matrix",
    "--cell",
    "--preflight",
    "--runner-preflight",
    "--evidence-dir",
  ];
  exactArgs(args, names);
  const value = (name) => args.get(name);
  const cellId = value("--cell");
  const matrixPath = value("--matrix");
  const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
  const cell = Array.isArray(matrix.cells)
    ? matrix.cells.find((candidate) => candidate.cellId === cellId)
    : null;
  if (!cell || !Number.isSafeInteger(cell.timeoutMs) || cell.timeoutMs < 1_000) {
    throw new Error("Trusted cell watchdog configuration is invalid.");
  }

  const evidenceDirectory = value("--evidence-dir");
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const evidenceOutput = path.join(evidenceDirectory, cellId + ".json");
  const watchdogMs = cell.timeoutMs + 60_000;
  const nodeArgs = [];
  const preload = process.env.PLASIUS_TRUSTED_FLEET_ADAPTER_URL || "";
  if (cell.adapter && cell.adapter.kind === "physical") {
    if (!preload.startsWith("file:")) {
      throw new Error("Physical qualification requires a runner-owned trusted adapter preload URL.");
    }
    nodeArgs.push(
      "--import",
      pathToFileURL(path.join(__dirname, "preload-trusted-fleet-adapter.mjs")).href
    );
  } else if (preload) {
    throw new Error("Hosted SwiftShader qualification cannot preload a physical fleet adapter.");
  }
  nodeArgs.push(
    value("--cli"),
    "run-cell",
    "--bundle", value("--bundle"),
    "--matrix", matrixPath,
    "--cell", cellId,
    "--preflight", value("--preflight"),
    "--runner-preflight", value("--runner-preflight"),
    "--output", evidenceOutput
  );

  let timedOut = false;
  let spawnError = null;
  const child = spawn(process.execPath, nodeArgs, {
    stdio: "inherit",
    env: process.env,
    detached: process.platform !== "win32",
  });
  const timer = setTimeout(() => {
    timedOut = true;
    terminate(child);
  }, watchdogMs);

  const exitCode = await new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
      resolve(1);
    });
    child.once("exit", (code) => resolve(code === null ? 1 : code));
  });
  clearTimeout(timer);

  if (timedOut) {
    runDiagnostic({
      cli: value("--cli"), matrix: matrixPath, cellId,
      preflight: value("--preflight"), evidenceDirectory, evidenceOutput,
      status: "timeout",
      message: "Trusted harness exceeded its " + String(watchdogMs) + " ms workflow watchdog.",
    });
    process.exitCode = 124;
    return;
  }
  if (exitCode !== 0) {
    runDiagnostic({
      cli: value("--cli"), matrix: matrixPath, cellId,
      preflight: value("--preflight"), evidenceDirectory, evidenceOutput,
      status: "failed",
      message: "Fixed trusted harness failed before qualification evidence was produced"
        + (spawnError ? ": " + spawnError.message : "; exit code " + String(exitCode)) + ".",
    });
    process.exitCode = exitCode;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message + "\n");
  try {
    const args = parseArgs(process.argv.slice(2));
    const cellId = args.get("--cell");
    const evidenceDirectory = args.get("--evidence-dir");
    if (cellId && evidenceDirectory) {
      fs.mkdirSync(evidenceDirectory, { recursive: true });
      runDiagnostic({
        cli: args.get("--cli"),
        matrix: args.get("--matrix"),
        cellId,
        preflight: args.get("--preflight"),
        evidenceDirectory,
        evidenceOutput: path.join(evidenceDirectory, cellId + ".json"),
        status: "failed",
        message: "Trusted workflow-cell bootstrap failed: " + message,
      });
    }
  } catch (diagnosticError) {
    process.stderr.write(
      "Trusted workflow diagnostic creation also failed: "
        + (diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError))
        + "\n"
    );
  }
  process.exitCode = 1;
});
