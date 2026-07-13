import type {
  ActiveShaderStyleProfile,
  FrameBoundaryScheduler,
  PreparedShaderStyleProfile,
  ShaderDiagnostic,
  ShaderResult,
  ShaderStyleController,
} from "../contracts.js";
import { requireTrustedPreparedShaderStyleProfile } from "./trusted-values.js";

interface ControllerState {
  current: ActiveShaderStyleProfile | null;
  readonly scheduler: FrameBoundaryScheduler;
  readonly now: () => number;
  activationTail: Promise<void>;
}

const controllers = new WeakMap<object, ControllerState>();

/** Creates an atomic frame-boundary style-profile controller. */
export function createShaderStyleController(input: {
  readonly scheduler: FrameBoundaryScheduler;
  readonly initial?: PreparedShaderStyleProfile;
  readonly now?: () => number;
}): ShaderStyleController {
  if (input.initial) requireTrustedPreparedShaderStyleProfile(input.initial);
  const now = input.now ?? Date.now;
  const state: ControllerState = {
    current: input.initial ? Object.freeze({ prepared: input.initial, activatedAt: now() }) : null,
    scheduler: input.scheduler,
    now,
    activationTail: Promise.resolve(),
  };
  const controller = Object.freeze({
    get current(): ActiveShaderStyleProfile | null { return state.current; },
  } satisfies ShaderStyleController);
  controllers.set(controller, state);
  return controller;
}

/** Atomically swaps a fully prepared profile; failure preserves the active profile. */
export async function activateStyleProfile(input: {
  readonly controller: ShaderStyleController;
  readonly prepared: PreparedShaderStyleProfile;
  readonly retire?: (previous: PreparedShaderStyleProfile) => void | Promise<void>;
}): Promise<ShaderResult<ActiveShaderStyleProfile>> {
  const controller = controllers.get(input.controller as object);
  if (!controller) {
    throw new TypeError("controller must be created by createShaderStyleController.");
  }
  requireTrustedPreparedShaderStyleProfile(input.prepared);
  const operation = controller.activationTail.then(async (): Promise<ShaderResult<ActiveShaderStyleProfile>> => {
    const previous = controller.current;
    let callbackOpen = true;
    let callbackInvoked = false;
    let callbackViolation: TypeError | null = null;
    const next = Object.freeze({ prepared: input.prepared, activatedAt: controller.now() });
    try {
      await controller.scheduler.schedule(() => {
        if (!callbackOpen || callbackInvoked) {
          callbackViolation ??= new TypeError("Frame-boundary scheduler invoked an activation callback more than once or after completion.");
          throw callbackViolation;
        }
        callbackInvoked = true;
        controller.current = next;
      });
      callbackOpen = false;
      if (callbackViolation) throw callbackViolation;
      if (!callbackInvoked) throw new TypeError("Frame-boundary scheduler completed without invoking the activation callback.");
    } catch (cause) {
      callbackOpen = false;
      if (controller.current === next) controller.current = previous;
      if (!previous || previous.prepared !== input.prepared) {
        try { input.prepared.dispose(); } catch { /* disposal cannot replace activation failure */ }
      }
      const diagnostic: ShaderDiagnostic = {
        code: "activation-error",
        severity: "error",
        message: cause instanceof Error ? cause.message : "Frame-boundary activation failed.",
      };
      return { ok: false, diagnostics: [diagnostic] };
    }
    if (previous && previous.prepared !== input.prepared) {
      try {
        if (input.retire) await input.retire(previous.prepared);
        else previous.prepared.dispose();
      } catch {
        // The frame-boundary switch is already complete; retirement is best-effort cleanup.
      }
    }
    return { ok: true, value: next };
  });
  controller.activationTail = operation.then(() => undefined, () => undefined);
  return operation;
}
