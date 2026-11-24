import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";

const valid = () => ({ name: "@plasius/gpu-shader", version: "0.1.12",
  peerDependencies: { "playwright-core": "1.62.1" },
  peerDependenciesMeta: { "playwright-core": { optional: true } },
});

async function readMetadata(value: unknown) {
  vi.resetModules();
  vi.doMock("../package.json", () => ({ default: value }));
  const { readTrustedHarnessPackageMetadata } = await import("../src/testing/runner/package-metadata.js");
  return readTrustedHarnessPackageMetadata();
}

afterEach(() => { vi.doUnmock("../package.json"); vi.resetModules(); });

it("keeps automation an exact optional peer and development tool, outside normal runtime installs", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  expect(manifest.dependencies).not.toHaveProperty("playwright-core");
  expect(manifest.optionalDependencies ?? {}).not.toHaveProperty("playwright-core");
  expect(manifest.peerDependencies["playwright-core"]).toBe("1.62.1");
  expect(manifest.peerDependenciesMeta["playwright-core"]).toEqual({ optional: true });
  expect(manifest.devDependencies["playwright-core"]).toBe(manifest.peerDependencies["playwright-core"]);
});

it("reads the exact optional peer pin for stable and prerelease harness versions", async () => {
  for (const version of ["0.1.12", "0.2.0-beta.1"]) {
    await expect(readMetadata({ ...valid(), version })).resolves.toEqual({
      name: "@plasius/gpu-shader", version, playwrightCoreVersion: "1.62.1",
    });
  }
});

it("rejects malformed release-owned identity, peer pins and optional markers", async () => {
  const variants: unknown[] = [
    { ...valid(), name: "another-package" }, { ...valid(), version: null }, { ...valid(), version: "latest" },
    ...[undefined, null, [], 1].map(peerDependencies => ({ ...valid(), peerDependencies })),
    ...[undefined, null, "", "^1.62.1", "1.62.x", "1.62.1-beta.1", 1].map(pin => ({ ...valid(), peerDependencies: { "playwright-core": pin } })),
    ...[undefined, null, [], 1, {}, { "playwright-core": null }, { "playwright-core": [] },
      { "playwright-core": "optional" }, { "playwright-core": {} }, { "playwright-core": { optional: false } },
      { "playwright-core": { optional: 1 } }].map(peerDependenciesMeta => ({ ...valid(), peerDependenciesMeta })),
  ];
  for (const value of variants) await expect(readMetadata(value)).rejects.toThrow(/Trusted harness/u);
});
