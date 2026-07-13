#!/usr/bin/env node
const { setTimeout: delay } = require("node:timers/promises");

const PROVENANCE_PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
const GITHUB_HOSTED_BUILDER = "https://github.com/actions/runner/github-hosted";

function parseArguments(argv) {
  const allowed = new Set([
    "--package",
    "--version",
    "--integrity",
    "--commit",
    "--repository",
    "--workflow",
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || value.length === 0) {
      throw new Error(`Invalid release verification argument ${String(name || "<missing>")}.`);
    }
    if (Object.hasOwn(values, name)) {
      throw new Error(`Duplicate release verification argument ${name}.`);
    }
    values[name] = value;
  }
  if (Object.keys(values).length !== allowed.size) {
    throw new Error("All release verification arguments are required exactly once.");
  }
  return {
    packageName: values["--package"],
    version: values["--version"],
    integrity: values["--integrity"],
    commit: values["--commit"],
    repository: values["--repository"],
    workflow: values["--workflow"],
  };
}

function expectedIntegrityHex(integrity) {
  if (typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(integrity)) {
    throw new Error("Expected npm integrity is not SHA-512.");
  }
  const bytes = Buffer.from(integrity.slice("sha512-".length), "base64");
  if (bytes.length !== 64) {
    throw new Error("Expected npm integrity does not contain 64 SHA-512 bytes.");
  }
  return bytes.toString("hex");
}

function decodeEnvelopePayload(attestation) {
  const payload = attestation?.bundle?.dsseEnvelope?.payload;
  if (typeof payload !== "string" || payload.length === 0 || payload.length > 2_000_000) {
    throw new Error("npm provenance attestation has no bounded DSSE payload.");
  }
  try {
    return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  } catch (cause) {
    throw new Error("npm provenance DSSE payload is not valid JSON.", { cause });
  }
}

function verifyReleaseRecord(metadata, attestationsDocument, expected) {
  if (metadata?.name !== expected.packageName || metadata?.version !== expected.version) {
    throw new Error("npm registry package identity differs from the prepared release.");
  }
  if (metadata?.dist?.integrity !== expected.integrity) {
    throw new Error("npm registry integrity differs from the prepared tarball.");
  }

  const attestationUrl = new URL(metadata?.dist?.attestations?.url || "");
  const expectedAttestationPath = `/-/npm/v1/attestations/${expected.packageName}@${expected.version}`;
  if (
    attestationUrl.protocol !== "https:" ||
    attestationUrl.hostname !== "registry.npmjs.org" ||
    decodeURIComponent(attestationUrl.pathname) !== expectedAttestationPath
  ) {
    throw new Error("npm registry returned an untrusted attestation URL.");
  }

  const attestations = attestationsDocument?.attestations;
  if (!Array.isArray(attestations) || attestations.length === 0 || attestations.length > 16) {
    throw new Error("npm registry returned no bounded attestation set.");
  }
  const provenance = attestations.find(
    (attestation) => attestation?.predicateType === PROVENANCE_PREDICATE_TYPE
  );
  if (!provenance) {
    throw new Error("npm package has no SLSA provenance attestation.");
  }

  const statement = decodeEnvelopePayload(provenance);
  if (statement?.predicateType !== PROVENANCE_PREDICATE_TYPE) {
    throw new Error("npm DSSE payload predicate type differs from its attestation envelope.");
  }
  const expectedSubjectName = `pkg:npm/${expected.packageName.replace(/^@/u, "%40")}@${expected.version}`;
  const expectedHex = expectedIntegrityHex(expected.integrity);
  const subject = Array.isArray(statement?.subject)
    ? statement.subject.find((candidate) => candidate?.name === expectedSubjectName)
    : undefined;
  if (subject?.digest?.sha512 !== expectedHex) {
    throw new Error("npm provenance subject does not bind the exact prepared tarball digest.");
  }

  if (!/^[a-f0-9]{40}$/u.test(expected.commit)) {
    throw new Error("Expected release commit must be an exact lowercase SHA-1.");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(expected.repository)) {
    throw new Error("Expected GitHub repository is malformed.");
  }
  if (!/^\.github\/workflows\/[A-Za-z0-9_.-]+[.]ya?ml$/u.test(expected.workflow)) {
    throw new Error("Expected GitHub workflow path is malformed.");
  }

  const predicate = statement?.predicate;
  const workflow = predicate?.buildDefinition?.externalParameters?.workflow;
  if (
    workflow?.repository !== `https://github.com/${expected.repository}` ||
    workflow?.path !== expected.workflow ||
    workflow?.ref !== "refs/heads/main"
  ) {
    throw new Error("npm provenance is not bound to the approved main CD workflow.");
  }
  const dependency = Array.isArray(predicate?.buildDefinition?.resolvedDependencies)
    ? predicate.buildDefinition.resolvedDependencies.find(
        (candidate) => candidate?.digest?.gitCommit === expected.commit
      )
    : undefined;
  if (
    !dependency ||
    dependency.uri !== `git+https://github.com/${expected.repository}@refs/heads/main`
  ) {
    throw new Error("npm provenance is not bound to the exact prepared Git commit.");
  }
  if (predicate?.runDetails?.builder?.id !== GITHUB_HOSTED_BUILDER) {
    throw new Error("npm provenance was not produced by a GitHub-hosted runner.");
  }
  const invocationId = predicate?.runDetails?.metadata?.invocationId;
  if (
    typeof invocationId !== "string" ||
    !invocationId.startsWith(`https://github.com/${expected.repository}/actions/runs/`)
  ) {
    throw new Error("npm provenance invocation does not belong to the package repository.");
  }

  return { attestationUrl: attestationUrl.toString(), invocationId };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "plasius-gpu-shader-release-verifier" },
    redirect: "error",
  });
  if (!response.ok) {
    const error = new Error(`Registry request failed with HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  const length = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(length) && length > 10_000_000) {
    throw new Error("Registry verification response exceeds its bounded size.");
  }
  if (!response.body) {
    throw new Error("Registry verification response has no body.");
  }

  const chunks = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.byteLength;
    if (received > 10_000_000) {
      throw new Error("Registry verification response exceeds its bounded size.");
    }
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (cause) {
    throw new Error("Registry verification response is not valid UTF-8 JSON.", { cause });
  }
}

async function verifyPublishedRelease(expected, attempts = 30, intervalMs = 4000) {
  const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(expected.packageName)}/${encodeURIComponent(expected.version)}`;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const metadata = await fetchJson(metadataUrl);
      const attestationUrl = new URL(metadata?.dist?.attestations?.url || "");
      if (attestationUrl.hostname !== "registry.npmjs.org") {
        throw new Error("Registry metadata does not contain a trusted npm attestation URL.");
      }
      const attestations = await fetchJson(attestationUrl);
      return verifyReleaseRecord(metadata, attestations, expected);
    } catch (cause) {
      lastError = cause;
      if (attempt === attempts) break;
      if (cause instanceof Error && /integrity differs|not bound|malformed|untrusted/u.test(cause.message)) {
        throw cause;
      }
      await delay(intervalMs);
    }
  }
  throw new Error(
    `npm release verification did not converge after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

async function main(argv = process.argv.slice(2)) {
  const expected = parseArguments(argv);
  const result = await verifyPublishedRelease(expected);
  process.stdout.write(
    `Verified ${expected.packageName}@${expected.version} integrity and provenance: ${result.invocationId}\n`
  );
}

if (require.main === module) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  });
}

module.exports = {
  GITHUB_HOSTED_BUILDER,
  PROVENANCE_PREDICATE_TYPE,
  decodeEnvelopePayload,
  expectedIntegrityHex,
  fetchJson,
  main,
  parseArguments,
  verifyPublishedRelease,
  verifyReleaseRecord,
};
