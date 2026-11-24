import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { observePlaywrightAdapterHarness } from "../src/testing/runner/playwright-integrity.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
afterEach(() => vi.mocked(readFile).mockReset());

it.each([null, [], 1, {}, { name: "other", version: "1.62.1" },
  { name: "playwright-core", version: "1.62.0" }, { name: "playwright-core", version: 1 },
].map(metadata => ({ metadata })))("rejects an installed peer that does not match the release-owned identity/version: $metadata", async ({ metadata }) => {
  vi.mocked(readFile).mockResolvedValue(JSON.stringify(metadata));
  await expect(observePlaywrightAdapterHarness("/nonexistent/unused-browser"))
    .rejects.toThrow("Installed playwright-core does not match the trusted harness pin.");
});

it("rejects unreadable or malformed installed peer metadata before browser work", async () => {
  vi.mocked(readFile).mockResolvedValue("not-json");
  await expect(observePlaywrightAdapterHarness("/nonexistent/unused-browser"))
    .rejects.toThrow("Installed playwright-core metadata is invalid.");
  vi.mocked(readFile).mockRejectedValue(new Error("synthetic read failure"));
  await expect(observePlaywrightAdapterHarness("/nonexistent/unused-browser"))
    .rejects.toThrow("Installed playwright-core metadata is invalid.");
});
