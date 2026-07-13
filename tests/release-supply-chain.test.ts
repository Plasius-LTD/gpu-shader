import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
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

    expect(validate).toContain("${{ needs.prepare_release.outputs.commit_sha }}");
    expect(validate).toMatch(
      /(?:PREPARED_SHA|EXPECTED_SHA): \$\{\{ needs\.prepare_release\.outputs\.commit_sha \}\}/u,
    );
    expect(validate).toMatch(
      /if \[ "\$\{GITHUB_SHA\}" != "\$\{(?:PREPARED_SHA|EXPECTED_SHA)\}" \]; then/u,
    );
    expect(validate).toContain("Wait for successful CI on exact prepared commit");
    expect(validate).toContain("npm ci");
    expect(validate).toContain("npm run lint");
    expect(validate).toContain("npm run typecheck");
    expect(validate).toContain("npm run build");
    expect(validate).toContain("npm run shader:matrix");
    expect(validate).toContain("npm run test:coverage");
    expect(validate).toContain("npm run pack:check");
    expect(validate).toContain("node scripts/prepare-npm-release.cjs release-artifacts");

    expect(validate).toContain(
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    );
    expect(validate).toContain(
      "name: npm-release-${{ github.run_id }}-attempt-${{ github.run_attempt }}",
    );
    expect(validate).toContain("release-artifacts/*.tgz");
    expect(validate).toContain("release-artifacts/sbom.cdx.json");
    expect(validate).toContain("release-artifacts/release-transport.json");
    expect(validate).toContain("artifact_id: ${{ steps.upload.outputs.artifact-id }}");
    expect(validate).toContain("artifact_digest: ${{ steps.upload.outputs.artifact-digest }}");
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
    expect(publish).not.toContain("${{ inputs.preid }}");
    expect(publish).toContain('assets.length !== 1');
    expect(publish).toContain('"prerelease", "distTag"');
    const prereleaseClassifiers = cd.match(/const prereleaseMatch = [^\n]+/gu) ?? [];
    expect(prereleaseClassifiers).toHaveLength(2);
    for (const classifier of prereleaseClassifiers) {
      expect(classifier).toContain("[0-9A-Za-z.-]*)\\.[0-9]+$/);");
    }
  });

  it("keeps every inline release verifier syntactically valid", () => {
    const snippets = [...cd.matchAll(/^ {10,12}(?:[^\n]* )?node( --input-type=module)? <<'NODE'\n([\s\S]*?)^ {10}NODE$/gmu)];
    expect(snippets).toHaveLength(4);
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

  it("limits automated maintenance writes to the reviewed package lock pull request", () => {
    expectReadOnlyWorkflowPermissions(workflowBlock(audit, "permissions", 0));
    expect(audit).toContain("persist-credentials: false");
    expect(audit).toMatch(/add-paths:\s*\|\s*\n\s+package-lock\.json\s*(?:\n|$)/u);
  });

  it("uses main HEAD and never pushes release metadata directly to main", () => {
    expect(prepare).toContain("COMMIT_SHA=$(git rev-parse HEAD)");
    expect(prepare).not.toContain('git push origin "HEAD:${BASE_BRANCH}"');
    expect(prepare).toContain('BRANCH_PROTECTED="$(gh api');
    expect(prepare).toContain('ALLOW_AUTO_MERGE="$(gh api');
    expect(prepare).toContain('gh pr merge "${PR_NUMBER}" --auto --squash');
    expect(prepare).not.toContain('gh pr merge "${PR_NUMBER}" --squash --delete-branch; then');
    expect(prepare).toContain("release fails closed");
  });
});
