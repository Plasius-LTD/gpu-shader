import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import type { StableWebGpuMatrixCell } from "../../contracts.js";
import { executeQualificationInBrowser } from "./browser-executor.js";
import type {
  TrustedAdapterUnitResult,
  TrustedBrowserUnitPayload,
  TrustedQualificationAdapter,
} from "./types.js";
import { readTrustedHarnessPackageMetadata } from "./package-metadata.js";
import { observePlaywrightAdapterHarness } from "./playwright-integrity.js";

const require = createRequire(__PLASIUS_MODULE_URL__);

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo | null;
      if (!address) reject(new TypeError("Trusted loopback origin did not bind."));
      else resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function trustedLoopbackOrigin(): Promise<{ readonly server: Server; readonly url: string }> {
  const html = "<!doctype html><html><head><meta charset=utf-8><title>Plasius trusted WebGPU qualification</title></head><body></body></html>";
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
    });
    response.end(html);
  });
  const port = await listen(server);
  return { server, url: `http://127.0.0.1:${port}/` };
}

function assertSwiftShaderCell(cell: StableWebGpuMatrixCell): void {
  const exact = cell.cellId === "swiftshader.chromium.ubuntu-x64"
    && cell.adapter.kind === "software"
    && cell.adapter.vendor === "google"
    && cell.adapter.family === "swiftshader"
    && cell.adapter.backend === "swiftshader"
    && cell.browser.name === "chromium"
    && cell.browser.channel === "playwright-bundled"
    && cell.os.name === "ubuntu"
    && cell.os.versionRequirement.kind === "exact"
    && cell.os.versionRequirement.value === "24.04"
    && cell.os.architecture === "x64"
    && cell.automation.kind === "playwright"
    && cell.blocking
    && !cell.countsTowardStableCoverage;
  if (!exact) throw new TypeError("Bundled Playwright adapter accepts only the exact blocking SwiftShader smoke cell.");
}

/** Launches Playwright's pinned Chromium build with a fixed SwiftShader route. */
export async function createPlaywrightSwiftShaderAdapter(
  cell: StableWebGpuMatrixCell,
): Promise<TrustedQualificationAdapter> {
  assertSwiftShaderCell(cell);
  let playwright: typeof import("playwright-core");
  try {
    const specifier: string = "playwright-core";
    playwright = await import(specifier) as typeof import("playwright-core");
  } catch (cause) {
    throw new TypeError("Pinned playwright-core is not installed; the SwiftShader route is unavailable.", { cause });
  }
  const packageMetadata = require("playwright-core/package.json") as { version?: unknown };
  const version = typeof packageMetadata.version === "string" ? packageMetadata.version : "unavailable";
  const harnessMetadata = await readTrustedHarnessPackageMetadata();
  if (version !== harnessMetadata.playwrightCoreVersion) {
    throw new TypeError(`Trusted runner requires playwright-core ${harnessMetadata.playwrightCoreVersion}, received ${version}.`);
  }
  const executablePath = playwright.chromium.executablePath();
  if (!executablePath) throw new TypeError("Pinned Playwright Chromium is not installed.");
  const adapterHarness = await observePlaywrightAdapterHarness(executablePath);
  const origin = await trustedLoopbackOrigin();
  let browser: import("playwright-core").Browser | null = null;
  try {
    browser = await playwright.chromium.launch({
      headless: true,
      args: [
        "--enable-unsafe-webgpu",
        "--enable-features=Vulkan",
        "--use-angle=swiftshader",
        "--use-vulkan=swiftshader",
        "--disable-vulkan-surface",
      ],
    });
    if (browser.browserType().name() !== "chromium") throw new TypeError("Playwright launched a non-Chromium browser.");
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    await page.goto(origin.url, { waitUntil: "domcontentloaded", timeout: Math.min(cell.timeoutMs, 30_000) });
    const browserVersion = browser.version();
    await page.evaluate((value) => {
      Object.defineProperty(globalThis, "__PLASIUS_BROWSER_VERSION__", {
        configurable: false,
        enumerable: false,
        value,
        writable: false,
      });
    }, browserVersion);
    const evaluateQualification = page.evaluate.bind(page) as unknown as (
      operation: typeof executeQualificationInBrowser,
      payload: TrustedBrowserUnitPayload,
    ) => Promise<TrustedAdapterUnitResult>;
    const adapter: TrustedQualificationAdapter = {
      automation: { kind: "playwright", driver: adapterHarness.id, version, sha256: adapterHarness.sha256 },
      async runUnit(payload: TrustedBrowserUnitPayload): Promise<TrustedAdapterUnitResult> {
        if (payload.cell.cellId !== cell.cellId) throw new TypeError("Adapter cell identity changed after trusted routing.");
        return evaluateQualification(executeQualificationInBrowser, payload);
      },
      async close(): Promise<void> {
        await context.close();
        await browser?.close();
        browser = null;
        await closeServer(origin.server);
      },
    };
    return adapter;
  } catch (cause) {
    await browser?.close().catch(() => undefined);
    await closeServer(origin.server).catch(() => undefined);
    throw cause;
  }
}
