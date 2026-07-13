import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface PackedArtifact {
  filename: string;
  integrity: string;
  shasum: string;
  size: number;
}

interface ReleaseExpectation {
  packageName: string;
  version: string;
  integrity: string;
  commit: string;
  repository: string;
  workflow: string;
}

interface PackModule {
  parsePackResult(raw: string, name: string, version: string): PackedArtifact;
  resolveReleaseOutputDirectory(requested: string, workspace?: string): string;
}

interface VerificationModule {
  REGISTRY_REQUEST_TIMEOUT_MS: number;
  resolvePublishedRelease(
    expected: Omit<ReleaseExpectation, "integrity" | "commit">,
    attempts?: number,
    intervalMs?: number,
  ): Promise<unknown>;
  resolveReleaseRecord(
    metadata: unknown,
    attestations: unknown,
    expected: Omit<ReleaseExpectation, "integrity" | "commit">,
  ): {
    attestationUrl: string;
    commit: string;
    integrity: string;
    invocationId: string;
  };
  verifyReleaseRecord(
    metadata: unknown,
    attestations: unknown,
    expected: ReleaseExpectation,
  ): { attestationUrl: string; invocationId: string };
}

const require = createRequire(import.meta.url);
const packModule = require("../scripts/prepare-npm-release.cjs") as PackModule;
const verificationModule = require("../scripts/verify-npm-release.cjs") as VerificationModule;

const repository = "Plasius-LTD/gpu-shader";
const packageName = "@plasius/gpu-shader";
const version = "0.1.0";
const commit = "a".repeat(40);
const digestBytes = Buffer.alloc(64, 7);
const integrity = `sha512-${digestBytes.toString("base64")}`;
const expected: ReleaseExpectation = {
  packageName,
  version,
  integrity,
  commit,
  repository,
  workflow: ".github/workflows/cd.yml",
};

function releaseFixture(): { metadata: unknown; attestations: unknown } {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: "pkg:npm/%40plasius/gpu-shader@0.1.0",
        digest: { sha512: digestBytes.toString("hex") },
      },
    ],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            ref: "refs/heads/main",
            repository: `https://github.com/${repository}`,
            path: ".github/workflows/cd.yml",
          },
        },
        resolvedDependencies: [
          {
            uri: `git+https://github.com/${repository}@refs/heads/main`,
            digest: { gitCommit: commit },
          },
        ],
      },
      runDetails: {
        builder: { id: "https://github.com/actions/runner/github-hosted" },
        metadata: {
          invocationId: `https://github.com/${repository}/actions/runs/123/attempts/1`,
        },
      },
    },
  };
  return {
    metadata: {
      name: packageName,
      version,
      dist: {
        integrity,
        attestations: {
          url: "https://registry.npmjs.org/-/npm/v1/attestations/@plasius%2fgpu-shader@0.1.0",
        },
      },
    },
    attestations: {
      attestations: [
        {
          predicateType: "https://slsa.dev/provenance/v1",
          bundle: {
            dsseEnvelope: {
              payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
            },
          },
        },
      ],
    },
  };
}

function workflowBlock(source: string, name: string, indentation: number): string {
  const prefix = `${" ".repeat(indentation)}${name}:`;
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === prefix);
  if (start < 0) {
    throw new Error(`Workflow block not found: ${name}`);
  }

  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end] ?? "";
    if (line.trim().length === 0) {
      end += 1;
      continue;
    }
    const leadingSpaces = /^ */u.exec(line)?.[0].length ?? 0;
    if (leadingSpaces <= indentation) {
      break;
    }
    end += 1;
  }
  return lines.slice(start, end).join("\n");
}

function expectReadOnlyWorkflowPermissions(permissions: string): void {
  expect(permissions).toContain("actions: read");
  expect(permissions).toContain("contents: read");
  expect(permissions).not.toMatch(/:\s*write(?:\s|$)/u);
}

function workflowStep(workflow: string, stepName: string): string {
  const stepStart = workflow.indexOf(`      - name: ${stepName}`);
  if (stepStart < 0) throw new Error(`Workflow step not found: ${stepName}`);
  const nextStep = workflow.indexOf("\n      - name:", stepStart + 1);
  return workflow.slice(stepStart, nextStep < 0 ? undefined : nextStep);
}

function inlineNodeStepSource(workflow: string, stepName: string): string {
  const block = workflowStep(workflow, stepName);
  const marker = "          node <<'NODE'\n";
  const sourceStart = block.indexOf(marker);
  const sourceEnd = block.indexOf("\n          NODE", sourceStart + marker.length);
  if (sourceStart < 0 || sourceEnd < 0) throw new Error(`Inline Node source not found: ${stepName}`);
  return block
    .slice(sourceStart + marker.length, sourceEnd)
    .split(/\r?\n/u)
    .map((line) => line.startsWith("          ") ? line.slice(10) : line)
    .join("\n");
}

describe("immutable npm release preparation", () => {
  it("accepts one exact bounded npm pack result", () => {
    const raw = JSON.stringify([
      {
        name: packageName,
        version,
        filename: "plasius-gpu-shader-0.1.0.tgz",
        integrity,
        shasum: "b".repeat(40),
        size: 2048,
      },
    ]);
    expect(packModule.parsePackResult(raw, packageName, version)).toEqual({
      filename: "plasius-gpu-shader-0.1.0.tgz",
      integrity,
      shasum: "b".repeat(40),
      size: 2048,
    });
  });

  it.each([
    ["invalid JSON", "{"],
    ["multiple artifacts", JSON.stringify([{}, {}])],
    [
      "path traversal",
      JSON.stringify([
        {
          name: packageName,
          version,
          filename: "../package.tgz",
          integrity,
          shasum: "b".repeat(40),
          size: 1,
        },
      ]),
    ],
  ])("rejects %s pack output", (_label, raw) => {
    expect(() => packModule.parsePackResult(raw, packageName, version)).toThrow();
  });

  it("restricts destructive preparation to the isolated release directory", () => {
    expect(packModule.resolveReleaseOutputDirectory("release-artifacts")).toBe(
      `${process.cwd()}/release-artifacts`,
    );
    expect(() => packModule.resolveReleaseOutputDirectory(".")).toThrow(/exactly/u);
    expect(() => packModule.resolveReleaseOutputDirectory("../outside")).toThrow(/exactly/u);
  });
});

describe("npm release provenance verification", () => {
  it("bounds registry requests and retry policy", async () => {
    expect(verificationModule.REGISTRY_REQUEST_TIMEOUT_MS).toBe(10_000);
    const authority = {
      packageName,
      version,
      repository,
      workflow: ".github/workflows/cd.yml",
    };
    await expect(verificationModule.resolvePublishedRelease(authority, 0, 0)).rejects.toThrow(
      /attempts/u,
    );
    await expect(verificationModule.resolvePublishedRelease(authority, 1, 10_001)).rejects.toThrow(
      /interval/u,
    );
  });

  it("derives the immutable release commit from exact npm provenance", () => {
    const fixture = releaseFixture();
    expect(
      verificationModule.resolveReleaseRecord(fixture.metadata, fixture.attestations, {
        packageName,
        version,
        repository,
        workflow: ".github/workflows/cd.yml",
      }),
    ).toEqual({
      attestationUrl:
        "https://registry.npmjs.org/-/npm/v1/attestations/@plasius%2fgpu-shader@0.1.0",
      commit,
      integrity,
      invocationId: `https://github.com/${repository}/actions/runs/123/attempts/1`,
    });
  });

  it("rejects ambiguous published provenance authority", () => {
    const duplicateDependency = releaseFixture();
    const attestations = duplicateDependency.attestations as {
      attestations: Array<{ bundle: { dsseEnvelope: { payload: string } } }>;
    };
    const statement = JSON.parse(
      Buffer.from(attestations.attestations[0]!.bundle.dsseEnvelope.payload, "base64").toString(
        "utf8",
      ),
    ) as {
      predicate: { buildDefinition: { resolvedDependencies: unknown[] } };
    };
    statement.predicate.buildDefinition.resolvedDependencies.push({
      uri: `git+https://github.com/${repository}@refs/heads/main`,
      digest: { gitCommit: "b".repeat(40) },
    });
    attestations.attestations[0]!.bundle.dsseEnvelope.payload = Buffer.from(
      JSON.stringify(statement),
    ).toString("base64");

    expect(() =>
      verificationModule.resolveReleaseRecord(
        duplicateDependency.metadata,
        duplicateDependency.attestations,
        {
          packageName,
          version,
          repository,
          workflow: ".github/workflows/cd.yml",
        },
      ),
    ).toThrow(/exactly one protected-main source commit/u);

    const duplicateAttestation = releaseFixture();
    const duplicateDocument = duplicateAttestation.attestations as { attestations: unknown[] };
    duplicateDocument.attestations.push(duplicateDocument.attestations[0]);
    expect(() =>
      verificationModule.resolveReleaseRecord(
        duplicateAttestation.metadata,
        duplicateAttestation.attestations,
        {
          packageName,
          version,
          repository,
          workflow: ".github/workflows/cd.yml",
        },
      ),
    ).toThrow(/exactly one SLSA provenance attestation/u);
  });

  it("binds registry bytes to the exact main CD workflow and commit", () => {
    const fixture = releaseFixture();
    expect(
      verificationModule.verifyReleaseRecord(
        fixture.metadata,
        fixture.attestations,
        expected,
      ),
    ).toEqual({
      attestationUrl:
        "https://registry.npmjs.org/-/npm/v1/attestations/@plasius%2fgpu-shader@0.1.0",
      invocationId: `https://github.com/${repository}/actions/runs/123/attempts/1`,
    });
  });

  it("rejects stale bytes, commits, workflows, and missing provenance", () => {
    const staleIntegrity = releaseFixture();
    (staleIntegrity.metadata as { dist: { integrity: string } }).dist.integrity =
      `sha512-${Buffer.alloc(64, 8).toString("base64")}`;
    expect(() =>
      verificationModule.verifyReleaseRecord(
        staleIntegrity.metadata,
        staleIntegrity.attestations,
        expected,
      ),
    ).toThrow(/integrity/u);

    const staleCommit = { ...expected, commit: "c".repeat(40) };
    const fixture = releaseFixture();
    expect(() =>
      verificationModule.verifyReleaseRecord(
        fixture.metadata,
        fixture.attestations,
        staleCommit,
      ),
    ).toThrow(/commit/u);

    const staleWorkflow = { ...expected, workflow: ".github/workflows/other.yml" };
    expect(() =>
      verificationModule.verifyReleaseRecord(
        fixture.metadata,
        fixture.attestations,
        staleWorkflow,
      ),
    ).toThrow(/workflow/u);
    expect(() =>
      verificationModule.verifyReleaseRecord(fixture.metadata, { attestations: [] }, expected),
    ).toThrow(/attestation/u);
  });
});

describe("release workflow policy", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const cd = readFileSync(new URL("../.github/workflows/cd.yml", import.meta.url), "utf8");
  const prepare = readFileSync(
    new URL("../.github/workflows/release-prepare.yml", import.meta.url),
    "utf8",
  );
  const audit = readFileSync(
    new URL("../.github/workflows/npm-audit-fix.yml", import.meta.url),
    "utf8",
  );

  it("uses OIDC Codecov and Node-24-compatible maintenance actions", () => {
    expect(ci).toContain("id-token: write");
    expect(ci).toContain("codecov/codecov-action@fb8b3582c8e4def4969c97caa2f19720cb33a72f");
    expect(ci).toContain("use_oidc: true");
    expect(audit).toContain(
      "peter-evans/create-pull-request@5f6978faf089d4d20b00c7766989d076bb2fc7f1",
    );
    expect(audit).toContain(
      "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
    );
    expect(audit).toContain("token: ${{ steps.maintenance_app_token.outputs.token }}");
    expect(ci).not.toContain("CODECOV_TOKEN");
  });

  it("keeps release preparation read-only and disables dependency lifecycle scripts", () => {
    expectReadOnlyWorkflowPermissions(workflowBlock(cd, "permissions", 0));
    expectReadOnlyWorkflowPermissions(workflowBlock(prepare, "permissions", 0));
    const resolveRelease = workflowBlock(prepare, "resolve_release", 2);
    expect(resolveRelease).toContain("needs: prepare");
    expect(resolveRelease).not.toContain("environment:");
    expectReadOnlyWorkflowPermissions(workflowBlock(resolveRelease, "permissions", 4));
    expect(resolveRelease).toContain(
      "ref: ${{ needs.prepare.outputs.validation_commit_sha }}",
    );
    expect(resolveRelease).toContain("persist-credentials: false");
    expect(resolveRelease).toContain("node-version: '24.13.0'");
    expect(prepare).not.toContain("node-version-file:");
    expect(prepare.match(/node-version: '24[.]13[.]0'/gu)).toHaveLength(2);
    expect(resolveRelease).not.toContain("GH_TOKEN");
    expect(resolveRelease).not.toContain("RELEASE_PREP_AUTH_TOKEN");
    expectReadOnlyWorkflowPermissions(
      workflowBlock(workflowBlock(cd, "prepare_release", 2), "permissions", 4),
    );
    expect(prepare).toContain("persist-credentials: false");

    const versionCommands = prepare
      .split(/\r?\n/u)
      .filter((line) => line.includes("npm version "));
    expect(versionCommands.length).toBeGreaterThan(0);
    for (const command of versionCommands) {
      expect(command).toContain("--ignore-scripts");
    }
    expect(prepare).toContain("query_npm_registry_value()");
    expect(prepare).toContain("release preparation fails closed");
    expect(prepare).not.toMatch(/npm view[^\n]*\|\| true/u);
  });

  it("builds and uploads an attempt-scoped immutable artifact without release privilege", () => {
    const validate = workflowBlock(cd, "validate_and_pack", 2);
    expect(validate).toContain("needs: prepare_release");
    expect(validate).not.toContain("environment:");
    expectReadOnlyWorkflowPermissions(workflowBlock(validate, "permissions", 4));
    expect(validate).not.toContain("id-token: write");

    expect(validate).toContain("ref: ${{ needs.prepare_release.outputs.release_commit_sha }}");
    expect(validate).toContain(
      "VALIDATION_SHA: ${{ needs.prepare_release.outputs.validation_commit_sha }}",
    );
    expect(validate).toContain(
      "RELEASE_SHA: ${{ needs.prepare_release.outputs.release_commit_sha }}",
    );
    expect(validate).toMatch(
      /if \[ "\$\{GITHUB_SHA\}" != "\$\{VALIDATION_SHA\}" \]; then/u,
    );
    expect(validate).toContain('if [ "${ACTUAL_SHA}" != "${RELEASE_SHA}" ]; then');
    expect(validate).toContain("Wait for successful CI on exact validation commit");
    expect(validate).toContain('node-version: "24.13.0"');
    expect(validate).not.toContain("node-version-file:");
    expect(validate).toContain("npm ci");
    expect(validate).toContain("npm run lint");
    expect(validate).toContain("npm run typecheck");
    expect(validate).toContain("npm run build");
    expect(validate).toContain("npm run shader:matrix");
    expect(validate).toContain("npm run test:coverage");
    expect(validate).toContain("npm run pack:check");
    expect(validate).toContain("node scripts/prepare-npm-release.cjs release-artifacts");
    expect(validate).toContain("Generate reproducible SBOM (CycloneDX)");
    expect(validate).toContain('export SOURCE_DATE_EPOCH="$(git show -s --format=%ct "${EXPECTED_RELEASE_COMMIT}")"');
    expect(validate).toContain("delete document.serialNumber");
    expect(validate).toContain("delete document.metadata.timestamp");
    expect(validate).toContain('crypto.createHash("sha256").update("plasius-npm-sbom-v1\\0")');
    expect(validate).toContain("Object.keys(value).sort()");
    expect(validate).toContain('flag: "wx"');

    expect(validate).toContain(
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    );
    expect(validate).toContain(
      "name: npm-release-${{ github.run_id }}-attempt-${{ github.run_attempt }}",
    );
    expect(validate).toContain("release-artifacts/*.tgz");
    expect(validate).toContain("release-artifacts/sbom.cdx.json");
    expect(validate).toContain("release-artifacts/release-transport.json");
    expect(validate).toContain("schemaVersion: 2");
    expect(validate).toContain("validationCommitSha: env.EXPECTED_VALIDATION_COMMIT");
    expect(validate).toContain("releaseCommitSha: env.EXPECTED_RELEASE_COMMIT");
    expect(validate).toContain("artifact_id: ${{ steps.upload.outputs.artifact-id }}");
    expect(validate).toContain("artifact_digest: ${{ steps.upload.outputs.artifact-digest }}");
  });

  it("normalizes npm's volatile SBOM fields into reproducible release bytes", () => {
    const source = inlineNodeStepSource(cd, "Generate reproducible SBOM (CycloneDX)");
    const root = mkdtempSync(join(tmpdir(), "gpu-shader-sbom-"));
    try {
      const outputs: string[] = [];
      for (const volatile of [
        { serialNumber: "urn:uuid:11111111-1111-4111-8111-111111111111", timestamp: "2026-01-01T00:00:00.000Z" },
        { serialNumber: "urn:uuid:22222222-2222-4222-8222-222222222222", timestamp: "2026-07-13T12:34:56.789Z" },
      ]) {
        const work = join(root, String(outputs.length));
        mkdirSync(join(work, "release-artifacts"), { recursive: true });
        const raw = join(work, "raw.json");
        writeFileSync(raw, JSON.stringify({
          bomFormat: "CycloneDX",
          specVersion: "1.6",
          serialNumber: volatile.serialNumber,
          metadata: {
            timestamp: volatile.timestamp,
            component: { name: "gpu-shader", version: "0.1.0" },
          },
          components: [{ version: "1.0.0", name: "fixture" }],
        }));
        const result = spawnSync(process.execPath, ["-"], {
          cwd: work,
          encoding: "utf8",
          input: source,
          env: {
            ...process.env,
            EXPECTED_RELEASE_COMMIT: commit,
            SOURCE_DATE_EPOCH: "1_750_000_000".replaceAll("_", ""),
            RAW_SBOM: raw,
          },
        });
        expect(result.status, result.stderr).toBe(0);
        outputs.push(readFileSync(join(work, "release-artifacts/sbom.cdx.json"), "utf8"));
      }
      expect(outputs[0]).toBe(outputs[1]);
      const normalized = JSON.parse(outputs[0] ?? "") as {
        serialNumber: string;
        metadata: { timestamp: string };
      };
      expect(normalized.serialNumber).toMatch(/^urn:uuid:[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
      expect(normalized.metadata.timestamp).toBe("2025-06-15T15:06:40.000Z");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("publishes only an independently verified artifact from the privileged job", () => {
    const publish = workflowBlock(cd, "publish", 2);
    const permissions = workflowBlock(publish, "permissions", 4);

    expect(publish).toContain("needs: [prepare_release, validate_and_pack]");
    expect(publish).toContain("environment: production");
    expect(permissions).toContain("actions: read");
    expect(permissions).toContain("attestations: write");
    expect(permissions).toContain("contents: write");
    expect(permissions).toContain("id-token: write");

    expect(publish).not.toContain("actions/checkout@");
    expect(publish).not.toMatch(/\bnpm ci\b/u);
    expect(publish).not.toMatch(/\bnpm run\b/u);
    expect(publish).not.toContain("scripts/");

    expect(publish).toContain(
      "actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131",
    );
    expect(publish).toContain(
      "artifact-ids: ${{ needs.validate_and_pack.outputs.artifact_id }}",
    );
    expect(publish).toContain(
      "EXPECTED_ARTIFACT_ID: ${{ needs.validate_and_pack.outputs.artifact_id }}",
    );
    expect(publish).toContain(
      "EXPECTED_ARTIFACT_DIGEST: ${{ needs.validate_and_pack.outputs.artifact_digest }}",
    );
    expect(publish).toContain(
      "EXPECTED_ARTIFACT_NAME: npm-release-${{ github.run_id }}-attempt-${{ github.run_attempt }}",
    );
    expect(publish).toContain("listWorkflowRunArtifacts");
    expect(publish).toContain("release-transport.json");
    expect(publish).toMatch(/digest\(["']sha256["']/u);
    expect(publish).toMatch(/digest\(["']sha512["']/u);
    expect(publish).toContain("npm audit signatures");
    expect(publish).toContain('SIGNATURE_WAIT_SECONDS: "180"');
    expect(publish).toContain('SIGNATURE_DEADLINE=$((SECONDS + SIGNATURE_WAIT_SECONDS))');
    expect(publish).toContain('SIGNATURE_ATTEMPT=$((SIGNATURE_ATTEMPT + 1))');
    expect(publish).toContain('sleep 5');
    expect(publish).toContain('npm signature verification did not converge');
    expect(publish).toMatch(
      /npm publish "\$\{TARBALL_PATH\}"[^\n]*--ignore-scripts[^\n]*--provenance/u,
    );
    expect(publish.indexOf("Resolve authoritative live npm state before mutation")).toBeLessThan(
      publish.indexOf("Attest exact npm tarball"),
    );
    expect(publish.indexOf("Preflight complete GitHub release state before mutation")).toBeLessThan(
      publish.indexOf("Attest exact npm tarball"),
    );
    expect(publish).toContain("REGISTRY_PUBLISHED: ${{ steps.registry.outputs.published }}");
    expect(publish).toContain(
      "EXPECTED_VALIDATION_COMMIT: ${{ needs.prepare_release.outputs.validation_commit_sha }}",
    );
    expect(publish).toContain(
      "EXPECTED_RELEASE_COMMIT: ${{ needs.prepare_release.outputs.release_commit_sha }}",
    );
    expect(publish).toContain("transport.schemaVersion !== 2");
    expect(publish).toContain("steps.registry.outputs.published != 'true'");
    expect(publish).toContain("const requestTimeoutMs = 10_000");
    expect(publish).toContain("signal: AbortSignal.timeout(requestTimeoutMs)");
    expect(publish).toContain("provenances.length !== 1");
    expect(publish).toContain("protectedMainDependencies.length !== 1");
    expect(publish).toContain(
      '/^[1-9][0-9]*\\/attempts\\/[1-9][0-9]*$/.test(invocationSuffix)',
    );
    expect(publish).toContain(
      'if [ "${VALIDATION_COMMIT_SHA}" != "${RELEASE_COMMIT_SHA}" ] && [ "${PREPARED_PUBLISHED}" != "true" ]; then',
    );
    expect(publish).not.toContain("${{ inputs.preid }}");
    expect(publish).toContain('assets.length !== 1');
    expect(publish).toContain('"prerelease", "distTag"');
    const prereleaseClassifiers = cd.match(/const prereleaseMatch = [^\n]+/gu) ?? [];
    expect(prereleaseClassifiers).toHaveLength(2);
    for (const classifier of prereleaseClassifiers) {
      expect(classifier).toContain("[0-9A-Za-z.-]*)\\.[0-9]+$/);");
    }
  });

  it("discovers draft releases through the authenticated release listing", () => {
    for (const stepName of [
      "Preflight complete GitHub release state before mutation",
      "Reconcile exact release tag",
      "Create or reconcile draft GitHub release",
      "Publish GitHub release",
    ]) {
      const step = workflowStep(cd, stepName);
      expect(step).toContain("github.rest.repos.listReleases");
      expect(step).not.toContain("github.rest.repos.getReleaseByTag");
      expect(step).toContain("candidate.tag_name === tag");
      expect(step).toContain("matchingReleases.length > 1");
    }
  });

  it("keeps every inline release verifier syntactically valid", () => {
    const snippets = [...cd.matchAll(/^ {10,12}(?:[^\n]* )?node( --input-type=module)? <<'NODE'\n([\s\S]*?)^ {10}NODE$/gmu)];
    expect(snippets).toHaveLength(5);
    for (const [, moduleFlag, indentedSource] of snippets) {
      const source = (indentedSource ?? "")
        .split(/\r?\n/u)
        .map((line) => line.startsWith("          ") ? line.slice(10) : line)
        .join("\n");
      const args = moduleFlag ? ["--input-type=module", "--check", "-"] : ["--check", "-"];
      const checked = spawnSync(process.execPath, args, { input: source, encoding: "utf8" });
      expect(checked.status, checked.stderr).toBe(0);
    }
  });

  it("keeps every privileged GitHub API script syntactically valid", () => {
    const lines = cd.split(/\r?\n/u);
    const sources: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (!(lines[index] ?? "").includes("uses: actions/github-script@")) continue;
      const scriptLine = lines.findIndex(
        (line, candidate) => candidate > index && candidate < index + 12 && line === "          script: |",
      );
      expect(scriptLine).toBeGreaterThan(index);
      const sourceLines: string[] = [];
      for (let candidate = scriptLine + 1; candidate < lines.length; candidate += 1) {
        const line = lines[candidate] ?? "";
        if (line.length > 0 && !line.startsWith("            ")) break;
        sourceLines.push(line.startsWith("            ") ? line.slice(12) : line);
      }
      sources.push(sourceLines.join("\n"));
    }
    expect(sources.length).toBeGreaterThanOrEqual(6);
    const AsyncFunction = Object.getPrototypeOf(async function fixture() {}).constructor as new (
      ...arguments_: string[]
    ) => (...values: unknown[]) => Promise<unknown>;
    for (const source of sources) {
      expect(() => new AsyncFunction("github", "context", "core", "require", "process", source)).not.toThrow();
    }
  });

  it("keeps release preparation shell syntax valid", () => {
    for (const name of [
      "Prepare and land release metadata",
      "Resolve immutable release source authority",
    ]) {
      const stepName = `      - name: ${name}`;
      const stepStart = prepare.indexOf(stepName);
      const runStart = prepare.indexOf("        run: |\n", stepStart);
      expect(stepStart).toBeGreaterThanOrEqual(0);
      expect(runStart).toBeGreaterThan(stepStart);
      const sourceLines: string[] = [];
      for (const line of prepare.slice(runStart + "        run: |\n".length).split(/\r?\n/u)) {
        if (line.length > 0 && !line.startsWith("          ")) break;
        sourceLines.push(line.startsWith("          ") ? line.slice(10) : line);
      }
      const checked = spawnSync("bash", ["-n"], {
        input: sourceLines.join("\n"),
        encoding: "utf8",
      });
      expect(checked.status, `${name}: ${checked.stderr}`).toBe(0);
    }
  });

  it("limits automated maintenance writes to the reviewed package lock pull request", () => {
    expectReadOnlyWorkflowPermissions(workflowBlock(audit, "permissions", 0));
    expect(audit).toContain("persist-credentials: false");
    expect(audit).toMatch(/add-paths:\s*\|\s*\n\s+package-lock\.json\s*(?:\n|$)/u);
  });

  it("uses main HEAD and never pushes release metadata directly to main", () => {
    expect(prepare).toContain("VALIDATION_COMMIT_SHA=$(git rev-parse HEAD)");
    expect(prepare).toContain("resolvePublishedRelease");
    expect(prepare.indexOf("  resolve_release:")).toBeGreaterThan(
      prepare.indexOf('RELEASE_PREP_AUTH_TOKEN: ${{ steps.release_prep_app_token.outputs.token }}'),
    );
    expect(prepare).toContain('if [ "${BUMP}" != "none" ]; then');
    expect(prepare).toContain(
      'TAG_COMMIT_SHA=$(git rev-parse "refs/tags/${RELEASE_TAG}^{commit}")',
    );
    expect(prepare).toContain('git merge-base --is-ancestor "${RELEASE_COMMIT_SHA}"');
    expect(prepare).toContain("validation_commit_sha=${VALIDATION_COMMIT_SHA}");
    expect(prepare).toContain("release_commit_sha=${RELEASE_COMMIT_SHA}");
    expect(prepare).not.toContain("commit_sha=${COMMIT_SHA}");
    expect(cd).not.toContain("needs.prepare_release.outputs.commit_sha");
    expect(prepare).not.toContain('git push origin "HEAD:${BASE_BRANCH}"');
    expect(prepare).toContain('BRANCH_PROTECTED="$(gh api');
    expect(prepare).toContain('ALLOW_AUTO_MERGE="$(gh api');
    expect(prepare).toContain('gh pr merge "${PR_NUMBER}" --auto --squash');
    expect(prepare).not.toContain('gh pr merge "${PR_NUMBER}" --squash --delete-branch; then');
    expect(prepare).toContain("release fails closed");
  });
});
