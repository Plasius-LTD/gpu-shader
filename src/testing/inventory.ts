import {
  SHADER_COMPILE_UNIT_VERSION,
  type ShaderCompileUnitInventory,
  type ShaderCompileUnitManifest,
  type ShaderDiagnostic,
  type ShaderQualificationBundleManifest,
  type ShaderResult,
} from "../contracts.js";
import {
  canonicalizeGpuContract,
  QUALIFICATION_GPU_CONTRACT_SNAPSHOT_LIMITS,
  snapshotGpuContract,
} from "../canonical-json.js";
import { assertImmutableAssetVersion } from "../asset-version.js";
import { asSha256Hex } from "../hash.js";
import { parseSerializableGpuPipelineDescriptors } from "../manifest-validation.js";

const SAFE_PATH = /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;

function issue(code: ShaderDiagnostic["code"], message: string, path?: string): ShaderDiagnostic {
  return { code, severity: "error", message, ...(path ? { path } : {}) };
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function freezeJson<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeJson(child);
  return Object.freeze(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).every((key) => expected.has(key)) && keys.every((key) => Object.hasOwn(value, key));
}

function safeToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u.test(value) && !value.includes("..");
}

function immutableVersion(value: unknown): boolean {
  try {
    assertImmutableAssetVersion(value);
    return true;
  } catch {
    return false;
  }
}

function validSha(value: unknown): boolean {
  try {
    asSha256Hex(String(value));
    return true;
  } catch {
    return false;
  }
}

/** Identity helper that makes compile-unit declarations readonly at the call site. */
export function defineShaderCompileUnit<const T extends ShaderCompileUnitManifest>(unit: T): T {
  return Object.freeze(unit);
}

/** Validates that every declared WGSL fragment belongs to at least one concrete compile unit. */
export function validateCompileUnitInventory(
  value: unknown,
): ShaderResult<ShaderCompileUnitInventory> {
  let snapshot: unknown;
  try {
    snapshot = snapshotGpuContract(value, QUALIFICATION_GPU_CONTRACT_SNAPSHOT_LIMITS);
  } catch {
    return {
      ok: false,
      diagnostics: [issue(
        "invalid-contract",
        "Compile-unit inventory must contain bounded detached JSON contract data.",
      )],
    };
  }
  const envelope = object(snapshot);
  const candidate = envelope && Object.hasOwn(envelope, "inventory")
    ? object((snapshot as Partial<ShaderQualificationBundleManifest>).inventory)
    : envelope;
  const diagnostics: ShaderDiagnostic[] = [];
  if (!candidate || !exactKeys(candidate, ["contractVersion", "fragments", "compileUnits"])) {
    return { ok: false, diagnostics: [issue("invalid-contract", "Compile-unit inventory has unknown or missing fields.")] };
  }
  if (candidate.contractVersion !== SHADER_COMPILE_UNIT_VERSION) {
    diagnostics.push(issue("invalid-contract", "Unsupported compile-unit inventory version.", "contractVersion"));
  }
  if (!Array.isArray(candidate.fragments) || !Array.isArray(candidate.compileUnits)) {
    diagnostics.push(issue("invalid-contract", "Inventory fragments and compileUnits must be arrays."));
    return { ok: false, diagnostics };
  }
  if (candidate.fragments.length > 10000 || candidate.compileUnits.length > 10000) {
    diagnostics.push(issue("invalid-contract", "Inventory exceeds the bounded item count."));
    return { ok: false, diagnostics };
  }
  const fragmentIds = new Set<string>();
  for (const [index, raw] of candidate.fragments.entries()) {
    const path = `fragments[${index}]`;
    const fragment = object(raw);
    if (!fragment || !exactKeys(fragment, ["fragmentId", "path", "sha256"])) {
      diagnostics.push(issue("invalid-contract", "Fragment has unknown or missing fields.", path));
      continue;
    }
    if (!safeToken(fragment.fragmentId) || fragmentIds.has(fragment.fragmentId)) {
      diagnostics.push(issue("invalid-contract", "Fragment IDs must be unique safe tokens.", `${path}.fragmentId`));
    } else fragmentIds.add(fragment.fragmentId);
    if (typeof fragment.path !== "string" || !SAFE_PATH.test(fragment.path) || !fragment.path.endsWith(".wgsl")) {
      diagnostics.push(issue("invalid-contract", "Fragment path must remain inside the data-only bundle.", `${path}.path`));
    }
    if (!validSha(fragment.sha256)) diagnostics.push(issue("invalid-contract", "Fragment digest is invalid.", `${path}.sha256`));
  }
  const covered = new Set<string>();
  const unitIds = new Set<string>();
  for (const [index, raw] of candidate.compileUnits.entries()) {
    const path = `compileUnits[${index}]`;
    const unit = object(raw);
    const keys = [
      "contractVersion", "compileUnitId", "fragmentIds", "modules", "entryPoints", "pipelines", "interfaceRef",
      "overrideValues", "qualificationFixture",
    ];
    if (!unit || !exactKeys(unit, keys)) {
      diagnostics.push(issue("invalid-contract", "Compile unit has unknown or missing fields.", path));
      continue;
    }
    if (unit.contractVersion !== SHADER_COMPILE_UNIT_VERSION || !safeToken(unit.compileUnitId) || unitIds.has(String(unit.compileUnitId))) {
      diagnostics.push(issue("invalid-contract", "Compile-unit identity/version is invalid or duplicated.", path));
    } else unitIds.add(unit.compileUnitId);
    if (!Array.isArray(unit.fragmentIds) || unit.fragmentIds.length === 0 || new Set(unit.fragmentIds).size !== unit.fragmentIds.length) {
      diagnostics.push(issue("invalid-contract", "Compile unit requires unique fragment IDs.", `${path}.fragmentIds`));
    } else {
      for (const id of unit.fragmentIds) {
        if (typeof id !== "string" || !fragmentIds.has(id)) diagnostics.push(issue("invalid-contract", `Compile unit references unknown fragment ${String(id)}.`, `${path}.fragmentIds`));
        else covered.add(id);
      }
    }
    if (!Array.isArray(unit.modules) || unit.modules.length === 0 || !Array.isArray(unit.entryPoints) || unit.entryPoints.length === 0 || !Array.isArray(unit.pipelines) || unit.pipelines.length === 0) {
      diagnostics.push(issue("invalid-contract", "Compile unit requires modules, entry points, and explicit pipelines.", path));
    }
    const modules = Array.isArray(unit.modules) ? unit.modules : [];
    const moduleIds = new Set<string>();
    for (const [moduleIndex, moduleRaw] of modules.entries()) {
      const module = object(moduleRaw);
      if (!module || !exactKeys(module, ["moduleId", "sha256", "assembly"]) || !safeToken(module.moduleId) || moduleIds.has(String(module.moduleId)) || !validSha(module.sha256)) {
        diagnostics.push(issue("invalid-contract", "Compile-unit module reference is invalid or duplicated.", `${path}.modules[${moduleIndex}]`));
      } else {
        moduleIds.add(module.moduleId);
        const assembly = object(module.assembly);
        if (!assembly || !exactKeys(assembly, ["kind", "fragmentIds"]) || assembly.kind !== "concat-v1" || !Array.isArray(assembly.fragmentIds) || assembly.fragmentIds.length === 0 || new Set(assembly.fragmentIds).size !== assembly.fragmentIds.length || assembly.fragmentIds.some((id) => typeof id !== "string" || !fragmentIds.has(id))) {
          diagnostics.push(issue("invalid-contract", "Module requires a non-vacuous concat-v1 recipe over exact inventory fragments.", `${path}.modules[${moduleIndex}].assembly`));
        }
      }
    }
    const recipeFragments = new Set(modules.flatMap((moduleRaw) => {
      const module = object(moduleRaw); const assembly = module ? object(module.assembly) : null;
      return Array.isArray(assembly?.fragmentIds) ? assembly.fragmentIds.filter((id): id is string => typeof id === "string") : [];
    }));
    if (Array.isArray(unit.fragmentIds) && ([...recipeFragments].sort().join("\n") !== [...unit.fragmentIds].sort().join("\n"))) {
      diagnostics.push(issue("invalid-contract", "Compile-unit fragment claims must exactly equal deterministic assembly inputs.", `${path}.fragmentIds`));
    }
    const entryKeys = new Set<string>();
    if (Array.isArray(unit.entryPoints)) for (const [entryIndex, entryRaw] of unit.entryPoints.entries()) {
      const entry = object(entryRaw); const entryPath = `${path}.entryPoints[${entryIndex}]`;
      if (!entry || !exactKeys(entry, ["moduleId", "name", "stage"]) || !safeToken(entry.moduleId) || !moduleIds.has(String(entry.moduleId)) || !safeToken(entry.name) || !["vertex", "fragment", "compute"].includes(String(entry.stage))) diagnostics.push(issue("invalid-contract", "Compile-unit entry point is invalid.", entryPath));
      else { const key = `${entry.moduleId}:${entry.stage}:${entry.name}`; if (entryKeys.has(key)) diagnostics.push(issue("invalid-contract", "Compile-unit entry point is duplicated.", entryPath)); entryKeys.add(key); }
    }
    try {
      const pipelines = parseSerializableGpuPipelineDescriptors(unit.pipelines, [...moduleIds], `${path}.pipelines`);
      const usedEntries = new Set<string>();
      for (const pipeline of pipelines) {
        if (pipeline.kind === "compute") usedEntries.add(`${pipeline.compute.moduleId}:compute:${pipeline.compute.entryPoint}`);
        else { usedEntries.add(`${pipeline.vertex.moduleId}:vertex:${pipeline.vertex.entryPoint}`); if (pipeline.fragment) usedEntries.add(`${pipeline.fragment.moduleId}:fragment:${pipeline.fragment.entryPoint}`); }
      }
      for (const key of usedEntries) if (!entryKeys.has(key)) diagnostics.push(issue("invalid-contract", `Pipeline references undeclared compile-unit entry point ${key}.`, `${path}.pipelines`));
      for (const key of entryKeys) if (!usedEntries.has(key)) diagnostics.push(issue("invalid-contract", `Compile-unit entry point ${key} is not used by a pipeline.`, `${path}.entryPoints`));
      const overrideValues = object(unit.overrideValues);
      if (!overrideValues) diagnostics.push(issue("invalid-contract", "overrideValues must be an object.", `${path}.overrideValues`));
      else {
        for (const [name, value] of Object.entries(overrideValues)) if (!safeToken(name) || (typeof value !== "boolean" && (typeof value !== "number" || !Number.isFinite(value)))) diagnostics.push(issue("invalid-contract", `Override value ${name} is invalid.`, `${path}.overrideValues`));
        const derived = new Map<string, boolean | number>();
        for (const descriptor of pipelines) {
          const stages = descriptor.kind === "compute" ? [descriptor.compute] : [descriptor.vertex, ...(descriptor.fragment ? [descriptor.fragment] : [])];
          for (const stage of stages) for (const [name, constant] of Object.entries(stage.constants)) {
            const previous = derived.get(name); if (previous !== undefined && !Object.is(previous, constant)) diagnostics.push(issue("invalid-contract", `Override ${name} has conflicting stage values.`, `${path}.pipelines`)); else derived.set(name, constant);
          }
        }
        const exactOverrides = Object.fromEntries([...derived.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
        if (canonicalizeGpuContract(overrideValues) !== canonicalizeGpuContract(exactOverrides)) diagnostics.push(issue("invalid-contract", "overrideValues must exactly equal the union of programmable-stage constants.", `${path}.overrideValues`));
      }
    } catch (cause) {
      diagnostics.push(issue("invalid-contract", cause instanceof Error ? cause.message : "Compile-unit pipelines are invalid.", `${path}.pipelines`));
    }
    const interfaceRef = object(unit.interfaceRef);
    if (!interfaceRef || !exactKeys(interfaceRef, ["interfaceId", "interfaceVersion", "manifestUri", "manifestSha256", "interfaceAbiHash", "modelAbiHash"]) || !safeToken(interfaceRef.interfaceId) || !immutableVersion(interfaceRef.interfaceVersion) || typeof interfaceRef.manifestUri !== "string" || !interfaceRef.manifestUri.startsWith("https://") || !validSha(interfaceRef.manifestSha256) || !validSha(interfaceRef.interfaceAbiHash) || !validSha(interfaceRef.modelAbiHash)) {
      diagnostics.push(issue("invalid-contract", "Compile-unit interfaceRef is invalid.", `${path}.interfaceRef`));
    }
    const fixture = object(unit.qualificationFixture);
    if (!fixture || !exactKeys(fixture, ["fixtureId", "path", "sha256"]) || !safeToken(fixture.fixtureId) || typeof fixture.path !== "string" || !SAFE_PATH.test(fixture.path) || !fixture.path.endsWith(".json") || !validSha(fixture.sha256)) {
      diagnostics.push(issue("invalid-contract", "Compile unit requires an exact declarative qualification fixture.", `${path}.qualificationFixture`));
    }
  }
  for (const fragmentId of fragmentIds) {
    if (!covered.has(fragmentId)) diagnostics.push(issue("uncovered-fragment", `WGSL fragment ${fragmentId} has no compile unit.`));
  }
  return diagnostics.length > 0
    ? { ok: false, diagnostics }
    : { ok: true, value: freezeJson(candidate as unknown as ShaderCompileUnitInventory) };
}
