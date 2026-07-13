#!/usr/bin/env node
const { setTimeout: delay } = require("node:timers/promises");

const PROVENANCE_PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
const GITHUB_HOSTED_BUILDER = "https://github.com/actions/runner/github-hosted";
const REGISTRY_REQUEST_TIMEOUT_MS = 10_000;

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

function validateReleaseAuthority(expected) {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    throw new Error("Expected release authority is malformed.");
  }
  if (!/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/u.test(expected.packageName || "")) {
    throw new Error("Expected npm package name is malformed.");
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/u.test(expected.version || "")) {
    throw new Error("Expected npm package version is malformed.");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(expected.repository || "")) {
    throw new Error("Expected GitHub repository is malformed.");
  }
  if (!/^\.github\/workflows\/[A-Za-z0-9_.-]+[.]ya?ml$/u.test(expected.workflow || "")) {
    throw new Error("Expected GitHub workflow path is malformed.");
  }
}

function trustedAttestationUrl(metadata, expected) {
  let attestationUrl;
  let decodedPath;
  try {
    attestationUrl = new URL(metadata?.dist?.attestations?.url || "");
    decodedPath = decodeURIComponent(attestationUrl.pathname);
  } catch (cause) {
    throw new Error("npm registry returned an untrusted attestation URL.", { cause });
  }
  const expectedAttestationPath = `/-/npm/v1/attestations/${expected.packageName}@${expected.version}`;
  if (
    attestationUrl.protocol !== "https:" ||
    attestationUrl.hostname !== "registry.npmjs.org" ||
    attestationUrl.port !== "" ||
    attestationUrl.username !== "" ||
    attestationUrl.password !== "" ||
    attestationUrl.search !== "" ||
    attestationUrl.hash !== "" ||
    decodedPath !== expectedAttestationPath
  ) {
    throw new Error("npm registry returned an untrusted attestation URL.");
  }
  return attestationUrl;
}

function resolveReleaseRecord(metadata, attestationsDocument, expected) {
  validateReleaseAuthority(expected);
  if (metadata?.name !== expected.packageName || metadata?.version !== expected.version) {
    throw new Error("npm registry package identity differs from the prepared release.");
  }
  const integrity = metadata?.dist?.integrity;
  const expectedHex = expectedIntegrityHex(integrity);
  const attestationUrl = trustedAttestationUrl(metadata, expected);

  const attestations = attestationsDocument?.attestations;
  if (!Array.isArray(attestations) || attestations.length === 0 || attestations.length > 16) {
    throw new Error("npm registry returned no bounded attestation set.");
  }
  const provenances = attestations.filter(
    (attestation) => attestation?.predicateType === PROVENANCE_PREDICATE_TYPE
  );
  if (provenances.length !== 1) {
    throw new Error("npm package must have exactly one SLSA provenance attestation.");
  }

  const statement = decodeEnvelopePayload(provenances[0]);
  if (
    statement?._type !== "https://in-toto.io/Statement/v1" ||
    statement?.predicateType !== PROVENANCE_PREDICATE_TYPE
  ) {
    throw new Error("npm DSSE payload predicate type differs from its attestation envelope.");
  }
  const expectedSubjectName = `pkg:npm/${expected.packageName.replace(/^@/u, "%40")}@${expected.version}`;
  const subjects = Array.isArray(statement?.subject) && statement.subject.length === 1
    ? statement.subject.filter((candidate) => candidate?.name === expectedSubjectName)
    : [];
  if (subjects.length !== 1 || subjects[0]?.digest?.sha512 !== expectedHex) {
    throw new Error("npm provenance subject does not bind the exact registry integrity/tarball digest.");
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
  const dependencies = predicate?.buildDefinition?.resolvedDependencies;
  const expectedDependencyUri = `git+https://github.com/${expected.repository}@refs/heads/main`;
  const protectedMainDependencies = Array.isArray(dependencies) && dependencies.length <= 64
    ? dependencies.filter((candidate) => candidate?.uri === expectedDependencyUri)
    : [];
  if (protectedMainDependencies.length !== 1) {
    throw new Error("npm provenance must identify exactly one protected-main source commit.");
  }
  const commit = protectedMainDependencies[0]?.digest?.gitCommit;
  if (typeof commit !== "string" || !/^[a-f0-9]{40}$/u.test(commit)) {
    throw new Error("npm provenance protected-main source commit is malformed.");
  }
  if (predicate?.runDetails?.builder?.id !== GITHUB_HOSTED_BUILDER) {
    throw new Error("npm provenance was not produced by a GitHub-hosted runner.");
  }
  const invocationId = predicate?.runDetails?.metadata?.invocationId;
  const invocationPrefix = `https://github.com/${expected.repository}/actions/runs/`;
  const invocationSuffix = typeof invocationId === "string" && invocationId.startsWith(invocationPrefix)
    ? invocationId.slice(invocationPrefix.length)
    : "";
  if (!/^[1-9][0-9]*\/attempts\/[1-9][0-9]*$/u.test(invocationSuffix)) {
    throw new Error("npm provenance invocation does not belong to the package repository.");
  }

  return { attestationUrl: attestationUrl.toString(), commit, integrity, invocationId };
}

function verifyReleaseRecord(metadata, attestationsDocument, expected) {
  if (!/^[a-f0-9]{40}$/u.test(expected.commit || "")) {
    throw new Error("Expected release commit must be an exact lowercase SHA-1.");
  }
  const resolved = resolveReleaseRecord(metadata, attestationsDocument, expected);
  if (resolved.integrity !== expected.integrity) {
    throw new Error("npm registry integrity differs from the prepared tarball.");
  }
  if (resolved.commit !== expected.commit) {
    throw new Error("npm provenance is not bound to the exact immutable release commit.");
  }
  return { attestationUrl: resolved.attestationUrl, invocationId: resolved.invocationId };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "plasius-gpu-shader-release-verifier" },
    redirect: "error",
    signal: AbortSignal.timeout(REGISTRY_REQUEST_TIMEOUT_MS),
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

function permanentVerificationFailure(cause) {
  return cause instanceof Error &&
    /differs|does not bind|not bound|malformed|untrusted|exactly one/u.test(cause.message);
}

async function readPublishedRelease(expected, verify, attempts, intervalMs) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 30) {
    throw new Error("Registry verification attempts must be an integer from 1 through 30.");
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 10_000) {
    throw new Error("Registry verification interval must be an integer from 0 through 10000 milliseconds.");
  }
  validateReleaseAuthority(expected);
  const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(expected.packageName)}/${encodeURIComponent(expected.version)}`;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const metadata = await fetchJson(metadataUrl);
      const attestationUrl = trustedAttestationUrl(metadata, expected);
      const attestations = await fetchJson(attestationUrl);
      return verify(metadata, attestations, expected);
    } catch (cause) {
      lastError = cause;
      if (attempt === attempts) break;
      if (permanentVerificationFailure(cause)) {
        throw cause;
      }
      await delay(intervalMs);
    }
  }
  throw new Error(
    `npm release verification did not converge after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

async function resolvePublishedRelease(expected, attempts = 30, intervalMs = 4000) {
  return readPublishedRelease(expected, resolveReleaseRecord, attempts, intervalMs);
}

async function verifyPublishedRelease(expected, attempts = 30, intervalMs = 4000) {
  return readPublishedRelease(expected, verifyReleaseRecord, attempts, intervalMs);
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
  REGISTRY_REQUEST_TIMEOUT_MS,
  decodeEnvelopePayload,
  expectedIntegrityHex,
  fetchJson,
  main,
  parseArguments,
  resolvePublishedRelease,
  resolveReleaseRecord,
  trustedAttestationUrl,
  validateReleaseAuthority,
  verifyPublishedRelease,
  verifyReleaseRecord,
};
