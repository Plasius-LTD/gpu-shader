import { canonicalizeGpuContract } from "../canonical-json.js";
import type {
  GpuInterfaceManifest,
  ReflectGpuInterfaceInput,
  ShaderDiagnostic,
  ShaderResult,
} from "../contracts.js";
import { reflectGpuInterface } from "./reflect.js";

function issue(code: ShaderDiagnostic["code"], message: string): ShaderDiagnostic {
  return { code, severity: "error", message };
}

/** Regenerates the final interface and rejects stale claims or model projections. */
export async function validateAssembledGpuInterface(input: {
  readonly assembled: ReflectGpuInterfaceInput;
  readonly expectedModelInterface?: GpuInterfaceManifest;
  readonly claimedManifest?: GpuInterfaceManifest;
}): Promise<ShaderResult<GpuInterfaceManifest>> {
  try {
    const regenerated = await reflectGpuInterface(input.assembled);
    const diagnostics: ShaderDiagnostic[] = [];
    if (input.expectedModelInterface && regenerated.modelAbiHash !== input.expectedModelInterface.modelAbiHash) {
      diagnostics.push(issue("model-abi-mismatch", "Final assembled WGSL changed the expected model-facing ABI projection."));
    }
    if (input.claimedManifest && canonicalizeGpuContract(regenerated) !== canonicalizeGpuContract(input.claimedManifest)) {
      diagnostics.push(issue("interface-abi-mismatch", "Caller-supplied interface differs from regenerated final WGSL reflection."));
    }
    return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, value: regenerated };
  } catch (cause) {
    return {
      ok: false,
      diagnostics: [issue("invalid-contract", cause instanceof Error ? cause.message : "WGSL reflection failed.")],
    };
  }
}
