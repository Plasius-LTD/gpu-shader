import type { StableWebGpuMatrixCell } from "../../contracts.js";
import { createPlaywrightSwiftShaderAdapter } from "./playwright-swiftshader.js";
import type {
  TrustedQualificationAdapter,
  TrustedQualificationAdapterFactory,
} from "./types.js";

/**
 * Fixed built-in routes. Physical routes must be provisioned as trusted package
 * code by the fleet; candidate archives can never select or load an adapter.
 */
export const defaultTrustedQualificationAdapterFactory: TrustedQualificationAdapterFactory = {
  async create(cell: StableWebGpuMatrixCell): Promise<TrustedQualificationAdapter> {
    if (cell.cellId === "swiftshader.chromium.ubuntu-x64") return createPlaywrightSwiftShaderAdapter(cell);
    const route = `${cell.automation.kind}/${cell.browser.name}/${cell.adapter.backend}/${cell.adapter.vendor}/${cell.adapter.family}`;
    throw new TypeError(
      `No fixed trusted physical adapter is provisioned for ${cell.cellId} (${route}); qualification fails closed.`,
    );
  },
};

/** Verifies a fleet-supplied trusted adapter before it receives admitted data. */
export async function createProvisionedTrustedAdapter(
  factory: TrustedQualificationAdapterFactory,
  cell: StableWebGpuMatrixCell,
): Promise<TrustedQualificationAdapter> {
  const adapter = await factory.create(cell);
  if (adapter.automation.kind !== cell.automation.kind) {
    await adapter.close().catch(() => undefined);
    throw new TypeError(`Provisioned adapter kind ${adapter.automation.kind} differs from matrix route ${cell.automation.kind}.`);
  }
  if (!adapter.automation.driver.trim() || !adapter.automation.version.trim()
    || !/^[a-f0-9]{64}$/u.test(adapter.automation.sha256)) {
    await adapter.close().catch(() => undefined);
    throw new TypeError("Provisioned adapter must report a bounded driver identity and version.");
  }
  return adapter;
}
