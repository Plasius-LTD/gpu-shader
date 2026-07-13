import { canonicalizeGpuContract } from "../../canonical-json.js";
import { createGpuRecordCodec } from "../../codec/codec.js";
import { encodeGpuVertexFormat } from "../../codec/vertex-format.js";
import type {
  GpuRecordCodec,
  GpuRecordValue,
  ShaderCompileUnitManifest,
  ShaderQualificationFixtureManifest,
} from "../../contracts.js";
import { computeSha256 } from "../../hash.js";
import type { AdmittedQualificationBundle } from "../../node/bundle-admission.js";
import type { TrustedBrowserUnitPayload } from "./types.js";

type BrowserLayoutProbe = TrustedBrowserUnitPayload["layoutProbes"][number];

export interface PreparedLayoutProbe {
  readonly browser: BrowserLayoutProbe;
  readonly outputCodec: GpuRecordCodec;
  readonly expectedOutput: ArrayBuffer;
  readonly expectedDecoded: GpuRecordValue;
}

function exactBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

/** Binds declarative probe values to reflected codecs and exact admitted bytes. */
export async function prepareReflectedLayoutProbes(input: {
  readonly admitted: AdmittedQualificationBundle;
  readonly unit: ShaderCompileUnitManifest;
  readonly fixture: ShaderQualificationFixtureManifest;
}): Promise<readonly PreparedLayoutProbe[]> {
  const { admitted, unit, fixture } = input;
  if (fixture.layoutProbes.length === 0) throw new TypeError(`Compile unit ${unit.compileUnitId} requires a reflected layout probe.`);
  const records = admitted.gpuInterface.records;
  const result: PreparedLayoutProbe[] = [];
  for (const probe of fixture.layoutProbes) {
    if (probe.kind === "vertex-input") {
      const modelInput = admitted.gpuInterface.modelAbi.vertexInputs.find((candidate) => candidate.source.pipelineId === probe.source.pipelineId
        && candidate.source.shaderLocation === probe.source.shaderLocation && candidate.semantic === probe.source.semantic);
      const reflectedInput = admitted.gpuInterface.vertexInputs.find((candidate) => candidate.pipelineId === probe.source.pipelineId
        && candidate.shaderLocation === probe.source.shaderLocation && candidate.semantic === probe.source.semantic);
      if (!modelInput || !reflectedInput || modelInput.format !== reflectedInput.format || modelInput.offset !== reflectedInput.offset
        || modelInput.arrayStride !== reflectedInput.arrayStride || modelInput.stepMode !== reflectedInput.stepMode) {
        throw new TypeError(`Vertex probe ${probe.probeId} is not an exact reflected model-facing vertex input.`);
      }
      const pipeline = unit.pipelines.find((candidate) => candidate.pipelineId === probe.source.pipelineId);
      const command = fixture.commands[probe.commandIndex];
      if (!pipeline || pipeline.kind !== "render" || !command || command.kind !== "draw"
        || command.pipelineId !== pipeline.pipelineId || probe.input.vertexBufferSlot !== reflectedInput.bufferSlot) {
        throw new TypeError(`Vertex probe ${probe.probeId} does not identify its exact render pipeline, draw, and buffer slot.`);
      }
      const vertexBinding = command.vertexBuffers.find((candidate) => candidate.slot === probe.input.vertexBufferSlot);
      if (!vertexBinding || vertexBinding.resourceId !== probe.input.resourceId) {
        throw new TypeError(`Vertex probe ${probe.probeId} input is not bound as its exact draw vertex buffer.`);
      }
      const firstElement = modelInput.stepMode === "vertex" ? command.firstVertex : command.firstInstance;
      const elementCount = modelInput.stepMode === "vertex" ? command.vertexCount : command.instanceCount;
      if (probe.input.elementIndex < firstElement || probe.input.elementIndex >= firstElement + elementCount) {
        throw new TypeError(`Vertex probe ${probe.probeId} element is not fetched by its exact draw command.`);
      }
      const resource = fixture.resources.find((candidate) => candidate.resourceId === probe.input.resourceId);
      if (!resource || resource.kind !== "buffer" || !resource.initialData || !resource.usage.includes("vertex")) {
        throw new TypeError(`Vertex probe ${probe.probeId} requires exact admitted vertex buffer bytes.`);
      }
      const encoded = encodeGpuVertexFormat(modelInput.format, probe.input.value);
      const byteOffset = vertexBinding.offset + modelInput.offset + probe.input.elementIndex * modelInput.arrayStride;
      const end = byteOffset + encoded.byteLength;
      if (byteOffset < vertexBinding.offset || end > vertexBinding.offset + vertexBinding.size || end > resource.byteLength) {
        throw new TypeError(`Vertex probe ${probe.probeId} reflected byte range exceeds its exact draw binding.`);
      }
      const bytes = admitted.fileBytes.get(resource.initialData.path);
      if (!bytes || !exactBytes(encoded, bytes.slice(byteOffset, end))) {
        throw new TypeError(`Vertex probe ${probe.probeId} admitted bytes differ from the reflected GPUVertexFormat encoder.`);
      }
      const outputRecord = records.find((candidate) => candidate.name === probe.output.recordName);
      const readback = fixture.readbacks[probe.output.readbackIndex];
      if (!outputRecord || !readback) throw new TypeError(`Vertex probe ${probe.probeId} output record/readback is missing.`);
      const outputCodec = createGpuRecordCodec(outputRecord, records);
      const expectedOutput = outputCodec.encode(probe.output.expectedValue as GpuRecordValue);
      if (expectedOutput.byteLength !== readback.byteLength || await computeSha256(new Uint8Array(expectedOutput)) !== readback.expectedSha256) {
        throw new TypeError(`Vertex probe ${probe.probeId} expected GPU-fetched value differs from its reflected output codec/readback digest.`);
      }
      result.push({
        browser: {
          probeId: probe.probeId,
          kind: "vertex-input",
          sourceIdentity: `${probe.source.pipelineId}:${probe.source.shaderLocation}:${probe.source.semantic}:${modelInput.format}`,
          inputResourceId: probe.input.resourceId,
          inputPath: resource.initialData.path,
          inputByteOffset: byteOffset,
          inputByteLength: encoded.byteLength,
          inputSha256: await computeSha256(encoded),
          outputReadbackIndex: probe.output.readbackIndex,
        },
        outputCodec,
        expectedOutput,
        expectedDecoded: outputCodec.decode(expectedOutput),
      });
      continue;
    }
    const identity = `${probe.source.moduleId}:${probe.source.group}:${probe.source.binding}`;
    if (!unit.modules.some((module) => module.moduleId === probe.source.moduleId)) {
      throw new TypeError(`Layout probe ${probe.probeId} source module is outside compile unit ${unit.compileUnitId}.`);
    }
    const reflected = admitted.gpuInterface.bindings.find((binding) => binding.moduleId === probe.source.moduleId
      && binding.group === probe.source.group && binding.binding === probe.source.binding);
    const projected = admitted.gpuInterface.modelAbi.bindings.find((binding) => binding.source.moduleId === probe.source.moduleId
      && binding.source.group === probe.source.group && binding.source.binding === probe.source.binding);
    if (!reflected || !projected || reflected.resource.kind !== "buffer" || projected.resource.kind !== "buffer"
      || reflected.resource.recordName !== probe.source.recordName || projected.resource.recordName !== probe.source.recordName) {
      throw new TypeError(`Layout probe ${probe.probeId} is not an exact reflected model-facing buffer record.`);
    }
    const record = records.find((candidate) => candidate.name === probe.source.recordName);
    const outputRecord = records.find((candidate) => candidate.name === probe.output.recordName);
    if (!record || !outputRecord) throw new TypeError(`Layout probe ${probe.probeId} references a missing reflected record.`);
    const pipeline = unit.pipelines.find((candidate) => candidate.pipelineId === probe.pipelineId);
    const command = fixture.commands[probe.commandIndex];
    if (!pipeline || !command || (command.kind !== "dispatch" && command.kind !== "draw") || command.pipelineId !== pipeline.pipelineId) {
      throw new TypeError(`Layout probe ${probe.probeId} does not identify its exact dispatch/draw pipeline command.`);
    }
    const fixtureGroup = fixture.bindGroups.find((group) => group.group === probe.source.group && command.bindGroupIds.includes(group.bindGroupId));
    const fixtureEntry = fixtureGroup?.entries.find((entry) => entry.binding === probe.source.binding);
    if (!fixtureEntry || fixtureEntry.resource.kind !== "buffer" || fixtureEntry.resource.resourceId !== probe.input.resourceId) {
      throw new TypeError(`Layout probe ${probe.probeId} input is not bound at reflected source ${identity}.`);
    }
    const resource = fixture.resources.find((candidate) => candidate.resourceId === probe.input.resourceId);
    if (!resource || resource.kind !== "buffer" || !resource.initialData) {
      throw new TypeError(`Layout probe ${probe.probeId} requires exact admitted initial buffer data.`);
    }
    const end = probe.input.byteOffset + probe.input.byteLength;
    const bindingEnd = fixtureEntry.resource.offset + fixtureEntry.resource.size;
    if (probe.input.byteOffset < fixtureEntry.resource.offset || end > bindingEnd || end > resource.byteLength) {
      throw new TypeError(`Layout probe ${probe.probeId} input range exceeds its exact reflected binding slice.`);
    }
    const bytes = admitted.fileBytes.get(resource.initialData.path);
    if (!bytes || end > bytes.byteLength) throw new TypeError(`Layout probe ${probe.probeId} admitted input bytes are incomplete.`);
    const codec = createGpuRecordCodec(record, records);
    const encoded = new Uint8Array(codec.encode(probe.input.value as GpuRecordValue));
    if (encoded.byteLength !== probe.input.byteLength || !exactBytes(encoded, bytes.slice(probe.input.byteOffset, end))) {
      throw new TypeError(`Layout probe ${probe.probeId} admitted bytes differ from the reflected CPU codec output.`);
    }
    const decodedInput = codec.decode(encoded);
    if (canonicalizeGpuContract(decodedInput) !== canonicalizeGpuContract(probe.input.value)) {
      throw new TypeError(`Layout probe ${probe.probeId} CPU codec roundtrip differs.`);
    }
    const readback = fixture.readbacks[probe.output.readbackIndex];
    if (!readback) throw new TypeError(`Layout probe ${probe.probeId} output readback is missing.`);
    const outputCodec = createGpuRecordCodec(outputRecord, records);
    const expectedOutput = outputCodec.encode(probe.output.expectedValue as GpuRecordValue);
    if (expectedOutput.byteLength !== readback.byteLength || await computeSha256(new Uint8Array(expectedOutput)) !== readback.expectedSha256) {
      throw new TypeError(`Layout probe ${probe.probeId} expected GPU output differs from its reflected codec/readback digest.`);
    }
    result.push({
      browser: {
        probeId: probe.probeId,
        kind: "binding",
        sourceIdentity: `${identity}:${probe.source.recordName}`,
        inputResourceId: probe.input.resourceId,
        inputPath: resource.initialData.path,
        inputByteOffset: probe.input.byteOffset,
        inputByteLength: probe.input.byteLength,
        inputSha256: await computeSha256(encoded),
        outputReadbackIndex: probe.output.readbackIndex,
      },
      outputCodec,
      expectedOutput,
      expectedDecoded: outputCodec.decode(expectedOutput),
    });
  }
  return result;
}

/** Decodes actual mapped GPU bytes with the same reflected codec and compares values. */
export function verifyReflectedLayoutProbeOutputs(input: {
  readonly prepared: readonly PreparedLayoutProbe[];
  readonly outputs: readonly { readonly probeId: string; readonly bytesBase64: string }[];
}): void {
  if (input.outputs.length !== input.prepared.length) throw new TypeError("GPU layout probe output set is incomplete.");
  const outputs = new Map(input.outputs.map((item) => [item.probeId, item.bytesBase64]));
  if (outputs.size !== input.outputs.length) throw new TypeError("GPU layout probe output set contains duplicates.");
  for (const probe of input.prepared) {
    const encoded = outputs.get(probe.browser.probeId);
    if (!encoded) throw new TypeError(`GPU layout probe ${probe.browser.probeId} output is missing.`);
    const actual = Uint8Array.from(Buffer.from(encoded, "base64"));
    if (!exactBytes(actual, new Uint8Array(probe.expectedOutput))) {
      throw new TypeError(`GPU layout probe ${probe.browser.probeId} output bytes differ from its reflected codec.`);
    }
    const decoded = probe.outputCodec.decode(actual);
    if (canonicalizeGpuContract(decoded) !== canonicalizeGpuContract(probe.expectedDecoded)) {
      throw new TypeError(`GPU layout probe ${probe.browser.probeId} decoded value differs.`);
    }
  }
}
