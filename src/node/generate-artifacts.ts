import { canonicalizeGpuContract } from "../canonical-json.js";
import type {
  GeneratedGpuInterfaceArtifacts,
  GpuInterfaceManifest,
  GpuRecordLayout,
  GpuTypeLayout,
} from "../contracts.js";

function generatedIdentifier(value: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value)
    ? value
    : `Gpu_${Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function typeScriptType(type: GpuTypeLayout): string {
  switch (type.kind) {
    case "scalar":
    case "atomic":
      return "number";
    case "vector":
      return `readonly [${Array.from({ length: type.width }, () => "number").join(", ")}]`;
    case "matrix": {
      const column = `readonly [${Array.from({ length: type.rows }, () => "number").join(", ")}]`;
      return `readonly [${Array.from({ length: type.columns }, () => column).join(", ")}]`;
    }
    case "array":
      return `readonly ${typeScriptType(type.element)}[]`;
    case "record":
      return `${generatedIdentifier(type.recordName)}GpuRecord`;
  }
}

function recordType(record: GpuRecordLayout): string {
  const members = record.members.map((member) => `  readonly ${JSON.stringify(member.name)}: ${typeScriptType(member.type)};`).join("\n");
  return `export interface ${generatedIdentifier(record.name)}GpuRecord {\n${members}\n}`;
}

function constantBase(value: string): string {
  const converted = value.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").replace(/[^A-Za-z0-9]+/gu, "_").toUpperCase();
  const nonEmpty = converted.replace(/^_+|_+$/gu, "") || "GPU";
  return /^[A-Z_]/u.test(nonEmpty) ? nonEmpty : `GPU_${nonEmpty}`;
}

function uniqueConstantName(value: string, used: Set<string>): string {
  const base = constantBase(value);
  let result = base;
  if (used.has(result)) {
    const suffix = Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
    result = `${base}_X${suffix || "00"}`;
    let disambiguator = 2;
    while (used.has(result)) result = `${base}_X${suffix || "00"}_${disambiguator++}`;
  }
  used.add(result);
  return result;
}

/** Produces deterministic generated source without writing files itself. */
export function generateGpuInterfaceArtifacts(manifest: GpuInterfaceManifest): GeneratedGpuInterfaceArtifacts {
  const recordsByName = new Map(manifest.records.map((record) => [record.name, record]));
  const modelRecordNames = new Set<string>();
  const includeRecord = (name: string): void => {
    if (modelRecordNames.has(name)) return;
    const record = recordsByName.get(name);
    if (!record) throw new TypeError(`Model ABI references missing record ${name}.`);
    modelRecordNames.add(name);
    const visit = (type: GpuTypeLayout): void => {
      if (type.kind === "record") includeRecord(type.recordName);
      else if (type.kind === "array") visit(type.element);
    };
    record.members.forEach((member) => visit(member.type));
  };
  manifest.modelAbi.recordNames.forEach(includeRecord);
  manifest.modelAbi.bindings.forEach((binding) => {
    if (binding.resource.kind === "buffer" && binding.resource.recordName) includeRecord(binding.resource.recordName);
  });
  manifest.modelAbi.semantics.forEach((semantic) => {
    if (semantic.source.kind === "record-member") includeRecord(semantic.source.recordName);
  });
  const allRecords = [...manifest.records].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const records = allRecords.filter((record) => modelRecordNames.has(record.name));
  const normalizedManifest = {
    ...manifest,
    modules: [...manifest.modules].sort((left, right) => left.moduleId < right.moduleId ? -1 : left.moduleId > right.moduleId ? 1 : 0),
    records: allRecords,
    bindings: [...manifest.bindings].sort((left, right) => left.moduleId < right.moduleId ? -1 : left.moduleId > right.moduleId ? 1 : left.group - right.group || left.binding - right.binding),
    entryPoints: [...manifest.entryPoints].sort((left, right) => left.moduleId < right.moduleId ? -1 : left.moduleId > right.moduleId ? 1 : left.stage < right.stage ? -1 : left.stage > right.stage ? 1 : left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    vertexInputs: [...manifest.vertexInputs].sort((left, right) => left.pipelineId < right.pipelineId ? -1 : left.pipelineId > right.pipelineId ? 1 : left.shaderLocation - right.shaderLocation),
    overrides: [...manifest.overrides].sort((left, right) => left.moduleId < right.moduleId ? -1 : left.moduleId > right.moduleId ? 1 : left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    modelAbi: {
      recordNames: [...manifest.modelAbi.recordNames].sort(),
      bindings: [...manifest.modelAbi.bindings].sort((left, right) => left.source.moduleId < right.source.moduleId ? -1 : left.source.moduleId > right.source.moduleId ? 1 : left.source.group - right.source.group || left.source.binding - right.source.binding),
      vertexInputs: [...manifest.modelAbi.vertexInputs].sort((left, right) => left.source.pipelineId < right.source.pipelineId ? -1 : left.source.pipelineId > right.source.pipelineId ? 1 : left.source.shaderLocation - right.source.shaderLocation),
      semantics: [...manifest.modelAbi.semantics].sort((left, right) => left.semantic < right.semantic ? -1 : left.semantic > right.semantic ? 1 : 0),
    },
  };
  const constants: string[] = [];
  const usedRecordConstants = new Set<string>();
  for (const record of records) {
    const prefix = uniqueConstantName(record.name, usedRecordConstants);
    constants.push(`export const ${prefix}_ALIGNMENT = ${record.alignment} as const;`);
    constants.push(`export const ${prefix}_BYTE_SIZE = ${record.byteSize === null ? "null" : record.byteSize} as const;`);
    constants.push(`export const ${prefix}_MINIMUM_BYTE_SIZE = ${record.minimumByteSize} as const;`);
    const usedMemberConstants = new Set<string>();
    for (const member of record.members) {
      constants.push(`export const ${prefix}_${uniqueConstantName(member.name, usedMemberConstants)}_OFFSET = ${member.offset} as const;`);
    }
  }
  const schemaFor = (type: GpuTypeLayout): unknown => {
    if (type.kind === "scalar" || type.kind === "atomic") {
      if (type.scalar === "bool") return { type: "boolean" };
      if (type.scalar === "u32") return { type: "integer", minimum: 0, maximum: 0xffff_ffff };
      if (type.scalar === "i32") return { type: "integer", minimum: -0x8000_0000, maximum: 0x7fff_ffff };
      return type.scalar === "f16"
        ? { type: "number", minimum: -65_504, maximum: 65_504 }
        : { type: "number", minimum: -3.4028234663852886e38, maximum: 3.4028234663852886e38 };
    }
    if (type.kind === "vector") return { type: "array", prefixItems: Array.from({ length: type.width }, () => schemaFor({ kind: "scalar", scalar: type.scalar, alignment: type.scalar === "f16" ? 2 : 4, byteSize: type.scalar === "f16" ? 2 : 4 })), items: false, minItems: type.width, maxItems: type.width };
    if (type.kind === "matrix") { const scalar = schemaFor({ kind: "scalar", scalar: type.scalar, alignment: type.scalar === "f16" ? 2 : 4, byteSize: type.scalar === "f16" ? 2 : 4 }); const column = { type: "array", prefixItems: Array.from({ length: type.rows }, () => scalar), items: false, minItems: type.rows, maxItems: type.rows }; return { type: "array", prefixItems: Array.from({ length: type.columns }, () => column), items: false, minItems: type.columns, maxItems: type.columns }; }
    if (type.kind === "array") return { type: "array", items: schemaFor(type.element), ...(type.count === null ? {} : { minItems: type.count, maxItems: type.count }) };
    return { $ref: `#/$defs/${type.recordName.replace(/~/gu, "~0").replace(/\//gu, "~1")}` };
  };
  const jsonSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://schemas.plasius.co.uk/gpu-interface/${encodeURIComponent(manifest.interfaceId)}/${encodeURIComponent(manifest.interfaceVersion)}/records.schema.json`,
    title: `${manifest.interfaceId} ${manifest.interfaceVersion} reflected GPU records`,
    $defs: Object.fromEntries(records.map((record) => [record.name, {
      type: "object",
      properties: Object.fromEntries(record.members.map((member) => [member.name, schemaFor(member.type)])),
      required: record.members.map((member) => member.name),
      additionalProperties: false,
    }])),
  };
  const manifestJson = `${canonicalizeGpuContract(normalizedManifest)}\n`;
  return {
    manifestJson,
    jsonSchemas: `${canonicalizeGpuContract(jsonSchema)}\n`,
    typescriptTypes: `${records.map(recordType).join("\n\n")}\n`,
    byteConstants: `${constants.join("\n")}\n`,
    codecs: [
      `import { createGpuRecordCodec, parseGpuInterfaceManifest } from "@plasius/gpu-shader";`,
      `const manifest = parseGpuInterfaceManifest(${manifestJson.trim()});`,
      ...records.map((record) =>
        `export const ${generatedIdentifier(record.name)}Codec = createGpuRecordCodec(manifest.records.find((item) => item.name === ${JSON.stringify(record.name)})!, manifest.records);`),
      "",
    ].join("\n"),
  };
}
