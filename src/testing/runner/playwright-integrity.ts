import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, sep } from "node:path";
import { asSha256Hex, computeSha256 } from "../../hash.js";
import type { Sha256Hex } from "../../contracts.js";
import { readTrustedHarnessPackageMetadata } from "./package-metadata.js";

const require = createRequire(__PLASIUS_MODULE_URL__);

async function fileSha256(path: string): Promise<Sha256Hex> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return asSha256Hex(hash.digest("hex"));
}

async function treeEntries(root: string, prefix: string): Promise<string[]> {
  const result: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) throw new TypeError(`Trusted adapter tree contains symbolic link ${path}.`);
      if (stats.isDirectory()) { await walk(path); continue; }
      if (!stats.isFile()) throw new TypeError(`Trusted adapter tree contains non-file ${path}.`);
      const name = relative(root, path).split(sep).join("/");
      result.push(`${prefix}/${name}\u0000${stats.size}\u0000${await fileSha256(path)}`);
    }
  };
  await walk(root);
  return result;
}

function chromiumRoot(executable: string): string {
  let current = dirname(executable);
  for (let depth = 0; depth < 8; depth += 1) {
    if (/^(?:chromium|chromium_headless_shell)-/u.test(basename(current))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new TypeError("Pinned Playwright Chromium executable is outside a versioned browser root.");
}

/** Hashes exact installed Playwright code plus every file in its pinned Chromium build. */
export async function observePlaywrightAdapterHarness(executablePath: string): Promise<{
  readonly id: "playwright-core";
  readonly version: string;
  readonly sha256: Sha256Hex;
}> {
  const metadata = await readTrustedHarnessPackageMetadata();
  const packageJson = require.resolve("playwright-core/package.json");
  const packageRoot = await realpath(dirname(packageJson));
  const browserRoot = await realpath(chromiumRoot(await realpath(executablePath)));
  const entries = [
    ...await treeEntries(packageRoot, "playwright-core"),
    ...await treeEntries(browserRoot, "chromium"),
  ];
  return {
    id: "playwright-core",
    version: metadata.playwrightCoreVersion,
    sha256: await computeSha256(`plasius.trusted-adapter-tree/v1\n${entries.join("\n")}`),
  };
}
