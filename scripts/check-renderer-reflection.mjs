// Development-only integration check; not a physical qualification harness.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WgslReflect } from "wgsl_reflect/wgsl_reflect.module.js";
import { reflectGpuInterface, generateGpuInterfaceArtifacts } from "../dist/node.js";

const root = process.argv[2];
if (!root) throw new Error("Pass the gpu-renderer checkout path; this check does not fetch or modify it.");
const rendererCommit = "ec6176de8d02e2ca6e9e6a3d7f9ac5172f1bd2e0";
const sourceSha256 = "6314e7ac17898b87cd8fc0b9bce46743237b8c5f8099ca31b8040c49726564d0";
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
// Check every runtime source against the retained commit before importing it.
for (const file of git("ls-tree", "-r", "--name-only", rendererCommit, "src").trim().split("\n")) {
  assert.equal(readFileSync(resolve(root, file), "utf8"), git("show", `${rendererCommit}:${file}`), file);
}
const { WAVEFRONT_COMPUTE_WGSL: source } = await import(pathToFileURL(resolve(root, "src/wavefront-shaders.js")).href);
const sha = (value) => createHash("sha256").update(value).digest("hex");
assert.equal(sha(source), sourceSha256);
const reflection = new WgslReflect(source);
// Derived descriptors test the complete source interface, not the renderer's
// host-side bind-group construction or a device's resource limits.
const pipelines = reflection.entry.compute.map((fn) => ({
  kind: "compute", pipelineId: fn.name,
  compute: { moduleId: "wavefront", entryPoint: fn.name, constants: {} },
  layout: { bindGroups: [{ group: 0, entries: fn.resources.map((value) => {
    const type = value.type.name;
    const resource = type === "sampler"
      ? { kind: "sampler", samplerType: "filtering" }
      : type === "texture_2d"
        ? { kind: "texture", sampleType: "float", viewDimension: "2d", multisampled: false }
        : type === "texture_storage_2d"
          ? { kind: "storage-texture", access: "write-only", format: value.type.format.name, viewDimension: "2d" }
          : { kind: "buffer", addressSpace: reflection.uniforms.some((item) => item.name === value.name) ? "uniform" : "storage",
            access: value.access, recordName: value.type.isStruct ? value.type.name : null,
            minimumBindingSize: value.size || value.type.stride };
    return { group: 0, binding: value.binding, visibility: ["compute"], resource };
  }) }] },
}));
const manifest = await reflectGpuInterface({
  interfaceId: "renderer.full", interfaceVersion: "1",
  modules: [{ moduleId: "wavefront", source }], pipelines,
  modelFacingRecordNames: ["RayRecord", "FrameConfig", "EnvironmentPortal"],
  modelFacingBindings: [], semantics: [],
});
const portal = manifest.records.find((record) => record.name === "EnvironmentPortal");
assert.equal(portal.members.find((member) => member.name === "_pad0").offset, 8);
assert.equal(portal.members.find((member) => member.name === "_pad1").offset, 12);
assert.equal(manifest.records.length, 18);
assert.equal(manifest.bindings.length, 45);
assert.equal(manifest.entryPoints.length, 11);
const artifacts = generateGpuInterfaceArtifacts(manifest);
console.log(JSON.stringify({
  kind: "local-full-assembled-interface-check", rendererCommit, sourceSha256,
  sourceBytes: Buffer.byteLength(source), records: manifest.records.length,
  bindings: manifest.bindings.length, entryPoints: manifest.entryPoints.map((entry) => entry.name),
  interfaceAbiHash: manifest.interfaceAbiHash,
  artifacts: Object.fromEntries(Object.entries(artifacts).map(([name, content]) => [name, sha(content)])),
  physicalQualification: false, hostPipelineQualification: false, adaptivePerformanceClaim: false,
}, null, 2));
