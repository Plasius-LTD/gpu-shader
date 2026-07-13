import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { admitQualificationBundle } from "../src/node/bundle-admission.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "gpu-shader-admission-edge-"));
  roots.push(value);
  return value;
}

describe("qualification directory admission early failures", () => {
  it("requires the root envelope and reports invalid UTF-8/JSON deterministically", async () => {
    const missing = await root();
    await expect(admitQualificationBundle(missing)).rejects.toThrow(/qualification\.json/u);

    const invalidUtf = await root();
    await writeFile(join(invalidUtf, "qualification.json"), Uint8Array.of(0xff));
    await expect(admitQualificationBundle(invalidUtf)).rejects.toThrow(/not UTF-8 JSON/u);

    const invalidJson = await root();
    await writeFile(join(invalidJson, "qualification.json"), "{");
    await expect(admitQualificationBundle(invalidJson)).rejects.toThrow(/not UTF-8 JSON/u);

    const invalidContract = await root();
    await writeFile(join(invalidContract, "qualification.json"), "{}");
    await expect(admitQualificationBundle(invalidContract)).rejects.toThrow(/unknown or missing/u);
  });

  it("rejects a symlinked bundle root before reading candidate bytes", async () => {
    const container = await root();
    const target = join(container, "target");
    const link = join(container, "link");
    await mkdir(target);
    await symlink(target, link);
    await expect(admitQualificationBundle(link)).rejects.toThrow(/regular directory/u);
  });
});
