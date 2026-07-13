import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { validInventory } from "./fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function jsonFile(value: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gpu-shader-cli-"));
  roots.push(root);
  const path = join(root, "input.json");
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

const matrixPath = new URL(
  "../matrices/stable-webgpu-2026-07-13.json",
  import.meta.url,
).pathname;

describe("gpu-shader CLI routing", () => {
  it("validates the exact stable matrix and a compile-unit inventory", async () => {
    await expect(runCli(["node", "cli", "validate-matrix", "--matrix", matrixPath]))
      .resolves.toBeUndefined();
    const inventory = await jsonFile(validInventory());
    await expect(runCli(["node", "cli", "validate-inventory", "--inventory", inventory]))
      .resolves.toBeUndefined();
  });

  it("fails on invalid JSON, invalid contracts, and unknown commands", async () => {
    const invalidJson = await jsonFile({});
    await writeFile(invalidJson, "{", "utf8");
    await expect(runCli(["node", "cli", "validate-matrix", "--matrix", invalidJson]))
      .rejects.toThrow(/not UTF-8 JSON/u);

    const invalidMatrix = await jsonFile({ contractVersion: "wrong" });
    await expect(runCli(["node", "cli", "validate-matrix", "--matrix", invalidMatrix]))
      .rejects.toThrow();

    const semanticClone = JSON.parse(await readFile(matrixPath, "utf8")) as unknown;
    const reserializedMatrix = await jsonFile(semanticClone);
    await writeFile(reserializedMatrix, JSON.stringify(semanticClone), "utf8");
    await expect(runCli(["node", "cli", "validate-matrix", "--matrix", reserializedMatrix]))
      .rejects.toThrow(/Matrix bytes do not match/u);
    await expect(runCli(["node", "cli", "unknown"])).rejects.toThrow(/Usage/u);
  });

  it.each([
    ["missing argument value", ["node", "cli", "validate-matrix", "--matrix"]],
    ["duplicate argument", ["node", "cli", "validate-matrix", "--matrix", matrixPath, "--matrix", matrixPath]],
    ["positional argument", ["node", "cli", "validate-matrix", "matrix", matrixPath]],
    ["unsupported argument", ["node", "cli", "validate-matrix", "--matrix", matrixPath, "--extra", "value"]],
  ])("rejects %s", async (_label, argv) => {
    await expect(runCli(argv)).rejects.toThrow(/argument|Unsupported/u);
  });
});
