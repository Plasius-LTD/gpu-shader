import type {
  GpuAddressSpace,
  GpuBindingLayout,
  GpuEntryPointInterface,
  GpuEntryPointIo,
  GpuOverrideLayout,
  GpuRecordLayout,
  GpuTypeLayout,
  GpuVertexInputLayout,
  GpuWorkgroupDimension,
  SerializableGpuPipelineDescriptor,
} from "../contracts.js";

type Reflected = any;

const scalarSizes: Readonly<Record<string, number>> = {
  bool: 4,
  f16: 2,
  f32: 4,
  i32: 4,
  u32: 4,
};

function attributeNumber(attributes: Reflected[] | null | undefined, name: string): number | null {
  const value = attributes?.find((attribute) => attribute.name === name)?.value;
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return null;
  return Number(value);
}

function scalarName(type: Reflected): string {
  return String(type?.format?.name ?? type?.name ?? "");
}

function vectorAlignment(width: number, scalarSize: number): number {
  return (width === 2 ? 2 : 4) * scalarSize;
}

export function normalizeType(type: Reflected): GpuTypeLayout {
  const rawName = String(type?.name ?? "");
  const shorthand = /^(vec[234]|mat[234]x[234])([fhiu])$/u.exec(rawName);
  const name = shorthand?.[1] ?? rawName;
  const shorthandScalar = shorthand
    ? ({ f: "f32", h: "f16", i: "i32", u: "u32" } as const)[shorthand[2] as "f" | "h" | "i" | "u"]
    : null;
  if (name in scalarSizes) {
    return {
      kind: "scalar",
      scalar: name as "i32" | "u32" | "f32" | "f16" | "bool",
      alignment: scalarSizes[name]!,
      byteSize: scalarSizes[name]!,
    };
  }
  if (name === "atomic") {
    const scalar = scalarName(type);
    if (scalar !== "i32" && scalar !== "u32") throw new TypeError(`Unsupported atomic scalar ${scalar}.`);
    return { kind: "atomic", scalar, alignment: 4, byteSize: 4 };
  }
  const vector = /^vec([234])$/u.exec(name);
  if (vector) {
    const width = Number(vector[1]) as 2 | 3 | 4;
    const scalar = (shorthandScalar ?? scalarName(type)) as "i32" | "u32" | "f32" | "f16" | "bool";
    const size = scalarSizes[scalar];
    if (!size) throw new TypeError(`Unsupported vector scalar ${scalar}.`);
    return { kind: "vector", scalar, width, alignment: vectorAlignment(width, size), byteSize: width * size };
  }
  const matrix = /^mat([234])x([234])$/u.exec(name);
  if (matrix) {
    const columns = Number(matrix[1]) as 2 | 3 | 4;
    const rows = Number(matrix[2]) as 2 | 3 | 4;
    const scalar = shorthandScalar ?? scalarName(type);
    if (scalar !== "f32" && scalar !== "f16") throw new TypeError(`Unsupported matrix scalar ${scalar}.`);
    const size = scalarSizes[scalar]!;
    const alignment = vectorAlignment(rows, size);
    const columnStride = Math.ceil((rows * size) / alignment) * alignment;
    return { kind: "matrix", scalar, columns, rows, columnStride, alignment, byteSize: columns * columnStride };
  }
  if (type?.isArray || name === "array") {
    const element = normalizeType(type.format);
    const count = Number(type.count) === 0 ? null : Number(type.count);
    const stride = Number(type.stride) || Math.ceil((element.byteSize ?? 0) / element.alignment) * element.alignment;
    return {
      kind: "array",
      element,
      count,
      stride,
      alignment: element.alignment,
      byteSize: count === null ? null : count * stride,
    };
  }
  if (type?.isStruct || Array.isArray(type?.members)) {
    return {
      kind: "record",
      recordName: name,
      alignment: Number(type.align) || 1,
      byteSize: type.members?.at(-1)?.type?.isArray && Number(type.members.at(-1).type.count) === 0
        ? null
        : Number(type.size),
    };
  }
  throw new TypeError(`Unsupported reflected WGSL type ${name || "<unknown>"}.`);
}

function addressSpacesFor(structName: string, reflection: Reflected): GpuAddressSpace[] {
  const spaces = new Set<GpuAddressSpace>();
  if (reflection.uniforms.some((item: Reflected) => item.type?.name === structName)) spaces.add("uniform");
  if (reflection.storage.some((item: Reflected) => item.type?.name === structName)) spaces.add("storage");
  return [...spaces].sort();
}

export function normalizeRecords(reflection: Reflected): GpuRecordLayout[] {
  return reflection.structs
    .map((record: Reflected) => {
      const members = record.members.map((member: Reflected) => {
        const type = normalizeType(member.type);
        const explicitAlign = attributeNumber(member.attributes, "align");
        const explicitSize = attributeNumber(member.attributes, "size");
        return {
          name: String(member.name),
          offset: Number(member.offset),
          alignment: Math.max(type.alignment, explicitAlign ?? 0),
          valueByteSize: type.byteSize,
          occupiedByteSize: type.byteSize === null ? null : Math.max(type.byteSize, explicitSize ?? 0),
          explicitAlign,
          explicitSize,
          type,
        };
      });
      const tail = members.at(-1);
      const runtimeArrayMember = tail?.type.kind === "array" && tail.type.count === null ? tail.name : null;
      return {
        name: String(record.name),
        alignment: Number(record.align) || 1,
        byteSize: runtimeArrayMember ? null : Number(record.size),
        minimumByteSize: runtimeArrayMember ? tail!.offset : Number(record.size),
        runtimeArrayMember,
        addressSpaces: addressSpacesFor(String(record.name), reflection),
        members,
      } satisfies GpuRecordLayout;
    })
    .sort((left: GpuRecordLayout, right: GpuRecordLayout) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

function declaredBinding(
  pipelines: readonly SerializableGpuPipelineDescriptor[],
  group: number,
  binding: number,
) {
  for (const pipeline of pipelines) {
    for (const layout of pipeline.layout.bindGroups) {
      const found = layout.group === group ? layout.entries.find((entry) => entry.binding === binding) : undefined;
      if (found) return found;
    }
  }
  return undefined;
}

export function normalizeBindings(
  moduleId: string,
  reflection: Reflected,
  pipelines: readonly SerializableGpuPipelineDescriptor[],
): GpuBindingLayout[] {
  const all = [...reflection.uniforms, ...reflection.storage, ...reflection.textures, ...reflection.samplers];
  const unique = new Map<string, Reflected>();
  for (const item of all) unique.set(`${item.group}:${item.binding}`, item);
  return [...unique.values()].map((item) => {
    const declared = declaredBinding(pipelines, Number(item.group), Number(item.binding));
    if (declared) {
      return {
        moduleId,
        variableName: String(item.name),
        group: Number(item.group),
        binding: Number(item.binding),
        resource: declared.resource,
        visibility: declared.visibility,
      };
    }
    if (reflection.uniforms.includes(item)) {
      return {
        moduleId,
        variableName: String(item.name),
        group: Number(item.group),
        binding: Number(item.binding),
        resource: {
          kind: "buffer",
          addressSpace: "uniform",
          access: "read",
          recordName: item.type?.isStruct ? String(item.type.name) : null,
          minimumBindingSize: Number(item.size),
        },
        visibility: [],
      };
    }
    if (reflection.storage.includes(item) && Number(item.resourceType) === 1) {
      return {
        moduleId,
        variableName: String(item.name),
        group: Number(item.group),
        binding: Number(item.binding),
        resource: {
          kind: "buffer",
          addressSpace: "storage",
          access: (item.access || "read") as "read" | "write" | "read_write",
          recordName: item.type?.isStruct ? String(item.type.name) : null,
          minimumBindingSize: Number(item.size),
        },
        visibility: [],
      };
    }
    throw new TypeError(`Binding ${moduleId}:${item.group}:${item.binding} needs an explicit pipeline layout descriptor.`);
  });
}

function normalizeIo(item: Reflected): GpuEntryPointIo {
  return {
    name: String(item.name),
    locationKind: item.locationType === "builtin" ? "builtin" : "location",
    location: item.location,
    interpolation: item.interpolation ?? null,
    type: normalizeType(item.type),
  };
}

export function normalizeEntryPoints(
  moduleId: string,
  reflection: Reflected,
  sourceWorkgroupSizes: ReadonlyMap<string, readonly [GpuWorkgroupDimension, GpuWorkgroupDimension, GpuWorkgroupDimension]>,
  sourceWorkgroupStorageSizes: ReadonlyMap<string, number>,
): GpuEntryPointInterface[] {
  const entries = [
    ...reflection.entry.vertex.map((fn: Reflected) => ["vertex", fn] as const),
    ...reflection.entry.fragment.map((fn: Reflected) => ["fragment", fn] as const),
    ...reflection.entry.compute.map((fn: Reflected) => ["compute", fn] as const),
  ];
  return entries.map(([stage, fn]) => ({
    moduleId,
    name: String(fn.name),
    stage,
    inputs: fn.inputs.map(normalizeIo),
    outputs: fn.outputs.map(normalizeIo),
    bindingKeys: fn.resources.map((item: Reflected) => `${moduleId}:${item.group}:${item.binding}`).sort(),
    overrideNames: fn.overrides.map((item: Reflected) => String(item.name)).sort(),
    workgroupSize: stage === "compute" ? sourceWorkgroupSizes.get(String(fn.name)) ?? null : null,
    workgroupStorageSize: stage === "compute" ? sourceWorkgroupStorageSizes.get(String(fn.name)) ?? null : null,
  }));
}

export function normalizeOverrides(moduleId: string, reflection: Reflected): GpuOverrideLayout[] {
  return reflection.overrides.map((item: Reflected) => {
    const explicitId = attributeNumber(item.attributes, "id");
    const typeName = String(item.type?.name ?? "f32") as GpuOverrideLayout["type"];
    return {
      moduleId,
      name: String(item.name),
      id: explicitId,
      type: typeName,
      defaultValue: null,
    };
  });
}

export function normalizeVertexInputs(
  pipelines: readonly SerializableGpuPipelineDescriptor[],
  entryPoints: readonly GpuEntryPointInterface[],
): GpuVertexInputLayout[] {
  const result: GpuVertexInputLayout[] = [];
  for (const pipeline of pipelines) {
    if (pipeline.kind !== "render") continue;
    const entry = entryPoints.find((candidate) =>
      candidate.moduleId === pipeline.vertex.moduleId
      && candidate.name === pipeline.vertex.entryPoint
      && candidate.stage === "vertex");
    if (!entry) throw new TypeError(`Vertex entry point ${pipeline.vertex.moduleId}:${pipeline.vertex.entryPoint} was not reflected.`);
    pipeline.vertexBuffers.forEach((buffer, bufferSlot) => {
      for (const attribute of buffer.attributes) {
        const input = entry.inputs.find((candidate) =>
          candidate.locationKind === "location" && candidate.location === attribute.shaderLocation);
        if (!input) throw new TypeError(`Pipeline ${pipeline.pipelineId} location ${attribute.shaderLocation} is absent from WGSL.`);
        result.push({
          pipelineId: pipeline.pipelineId,
          moduleId: pipeline.vertex.moduleId,
          entryPoint: pipeline.vertex.entryPoint,
          shaderLocation: attribute.shaderLocation,
          shaderType: input.type,
          bufferSlot,
          format: attribute.format,
          offset: attribute.offset,
          arrayStride: buffer.arrayStride,
          stepMode: buffer.stepMode,
          semantic: attribute.semantic,
        });
      }
    });
  }
  return result;
}
