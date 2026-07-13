import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { observePlaywrightAdapterHarness } from "../src/testing/runner/playwright-integrity.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gpu-shader-playwright-integrity-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Playwright executable-tree integrity", () => {
  it("hashes the pinned Playwright package and every regular Chromium tree file deterministically", async () => {
    const root = await temporaryRoot();
    const browserRoot = join(root, "chromium-1234");
    const executable = join(browserRoot, "bin", "chromium");
    await mkdir(join(browserRoot, "bin"), { recursive: true });
    await mkdir(join(browserRoot, "resources", "nested"), { recursive: true });
    await writeFile(executable, "fake chromium executable");
    await writeFile(join(browserRoot, "resources", "z.pak"), "z");
    await writeFile(join(browserRoot, "resources", "nested", "a.pak"), "a");

    const first = await observePlaywrightAdapterHarness(executable);
    const second = await observePlaywrightAdapterHarness(executable);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ id: "playwright-core", version: "1.61.1" });
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects executables outside a versioned Chromium root", async () => {
    const root = await temporaryRoot();
    const executable = join(root, "browser", "bin", "chromium");
    await mkdir(join(root, "browser", "bin"), { recursive: true });
    await writeFile(executable, "fake");

    await expect(observePlaywrightAdapterHarness(executable)).rejects.toThrow(/outside a versioned browser root/u);
  });

  it("rejects symbolic links anywhere in the trusted Chromium tree", async () => {
    const root = await temporaryRoot();
    const browserRoot = join(root, "chromium_headless_shell-1234");
    const executable = join(browserRoot, "headless_shell");
    const target = join(root, "outside.dat");
    await mkdir(browserRoot, { recursive: true });
    await writeFile(executable, "fake");
    await writeFile(target, "outside");
    await symlink(target, join(browserRoot, "linked.dat"));

    await expect(observePlaywrightAdapterHarness(executable)).rejects.toThrow(/contains symbolic link/u);
  });

  it("propagates a missing executable as a fail-closed integrity error", async () => {
    const root = await temporaryRoot();
    await expect(observePlaywrightAdapterHarness(join(root, "chromium-1234", "missing"))).rejects.toThrow(/ENOENT/u);
  });
});
