# ADR 0001: Final assembled WGSL is the interface source of truth

- Status: Accepted
- Date: 2026-07-13
- Decision owners: Plasius shader framework maintainers
- Related Feature: [Plasius-LTD/plasius-ltd-site#1026](https://github.com/Plasius-LTD/plasius-ltd-site/issues/1026)
- Related Story: [Plasius-LTD/plasius-ltd-site#1027](https://github.com/Plasius-LTD/plasius-ltd-site/issues/1027)
- Package Task: [Plasius-LTD/gpu-shader#1](https://github.com/Plasius-LTD/gpu-shader/issues/1)

## Context

Plasius shaders are assembled from reusable WGSL fragments, while CPU code
allocates and packs their model data. Hand-maintained TypeScript offsets,
strides, and record sizes can silently diverge from WGSL alignment rules. A
module may compile and a pipeline may be created even though model bytes are
read from the wrong locations. Existing examples include `vec3`/`vec4`
packing drift, duplicated assembled globals, differing renderer and lighting
records, and worker entry-point signature drift.

Sidecar metadata cannot be an equal source of truth: it can repeat the same
incorrect layout and make a mismatch appear self-consistent. Source fragments
are also insufficient because assembly can introduce collisions, conditional
declarations, different overrides, or a different entry-point interface.

WGSL does not encode every pipeline fact. A vertex shader declares locations
and shader types, while the pipeline descriptor supplies vertex buffer format,
offset, stride, and step mode. Compatibility must validate the pair without
allowing a sidecar to invent host-shareable record layout.

## Decision

### 1. Reflect final compile units

The package reflects each final assembled WGSL module together with its exact
entry points, pipeline descriptors, and overrides. Reflection is cross-checked
with independent WGSL source analysis and then validated by a real WebGPU
implementation. Reflection alone is not a WGSL compiler or a support claim.

Reusable WGSL fragments may define canonical records, but every final compile
unit must reproduce an identical model-facing projection. A fragment is not
qualified until it belongs to at least one compile unit.

### 2. Generate CPU layout from reflection

Reflected WGSL records determine member order, offsets, effective alignment,
logical and occupied sizes, array and matrix strides, runtime-array prefix
size, address space, and binding access. Generated schemas, TypeScript types,
byte constants, and codecs are downstream products of this manifest.

Metadata may select reflected declarations and attach semantic names. It may
not provide offsets, sizes, alignments, strides, or a replacement record shape.
Admission regenerates the manifest and rejects differing caller claims.
Generator provenance uses the release-owned package version read from
`@plasius/gpu-shader` package metadata; callers cannot provide a different
version as reflection input.

For vertex data, WGSL reflection supplies shader location and shader type. The
serializable pipeline descriptor supplies format, byte offset, buffer stride,
slot, and step mode. Pipeline validation must prove that those facts form a
valid WebGPU vertex interface. They are hashed as pipeline facts, not treated
as an independently authored WGSL record layout.

Qualification proves both model-facing input paths structurally. Every used
model record binding requires a reflected-codec `buffer-record` probe, and
every used model ABI vertex semantic requires a reflected-format
`vertex-input` probe. Each probe binds exact CPU bytes to a bounded GPU command
and reflected output-record decoding; a generic readback digest is not an
equivalent layout proof.

### 3. Maintain two ABI identities

`modelAbiHash` covers the model-facing projection: selected reflected records,
model-facing binding resource shapes, validated vertex byte consumption, and
semantic mappings. Models and style profiles use this identity to determine
whether buffers can be reused without repacking.

`shaderAbiHash` covers the complete assembled shader version: module digests,
entry points, pipeline descriptors, overrides, bindings, formats, requirements,
and the referenced GPU interface. It identifies an exact pipeline contract but
does not replace `modelAbiHash`.

Hashes use deterministic canonical JSON and SHA-256. Locale-sensitive ordering,
timestamps, URIs that do not affect interface semantics, and mutable labels are
excluded from ABI projections.

### 4. Enforce compatibility twice

Storage admission regenerates layouts and hashes, validates fixtures, and
requires exact complete qualification evidence before promotion. Runtime loads
only promoted exact-version manifests, verifies every digest, checks model ABI,
semantics, features, limits and formats, and creates resources only after those
checks pass.

Both boundaries also derive requirements from the complete exact WGSL module
set, reflected interface, and pipeline descriptors. WGSL enables,
model-facing semantics, target/storage formats, per-stage resource and binding
size limits, inter-stage variables/components, structural pipeline limits, and compute
workgroup dimensions, invocations, and statically used storage-byte limits
cannot be understated in sidecar metadata or hidden by
supplying only part of the module set.

Both boundaries fail closed. An arbitrary Blob URL cannot bypass catalog,
manifest, digest, compatibility, or device validation.

### 5. Keep immutable asset identities separate

Models, GPU interface manifests, shader versions, style profiles, fixtures, and
qualification evidence are independently versioned immutable assets. A style
profile maps render roles to exact shader versions. A promoted catalog/channel
pointer may move atomically for rollout or rollback, but referenced bytes do
not mutate.

## Consequences

### Positive

- CPU packing cannot be accepted merely because it agrees with duplicated
  sidecar numbers.
- Realistic, cartoon, anime, and future styles can switch without model
  repacking when they share a `modelAbiHash`.
- Evidence and runtime decisions are reproducible from exact immutable bytes.
- Existing and demo shaders can adopt compile units without first moving their
  source ownership into the shader store.

### Costs and constraints

- Build tooling must assemble WGSL before schema/type generation.
- Pipeline descriptors become versioned contract inputs and must be
  deterministic.
- Every shader-related change must requalify affected compile units, profiles,
  and model fixtures; framework or policy changes can requalify the inventory.
- Stable promotion remains unavailable until every declared physical matrix
  cell is provisioned and passes.
- A model needing a new semantic requires a new model version or a profile that
  is discoverable only for models already providing that semantic.

## Alternatives considered

### TypeScript or JSON sidecars as source of truth

Rejected because sidecars can drift from final assembled WGSL and can encode
invalid WGSL layout assumptions.

### Source-fragment reflection only

Rejected because final assembly, overrides, entry points, and pipeline layout
determine the executable interface.

### One hash for every compatibility decision

Rejected because styles can legitimately change lighting or post-processing
while retaining identical model bytes. One full hash would force unnecessary
model repacking; one model-only hash would fail to identify pipeline drift.

### Runtime validation only

Rejected because it allows incompatible assets into durable storage and moves
avoidable failures to users' devices.

### Admission validation only

Rejected because runtime devices have different features and limits, cached
bytes can be corrupted, and callers may attempt to bypass promoted references.

## Validation

The decision is verified by reflection/codec unit tests, mismatch regression
fixtures, admission rejection tests, digest and compatibility runtime tests,
and exact compile-unit-by-matrix evidence. The detailed evidence and runner
rules are in [TDR 0001](../tdrs/tdr-0001-qualification-evidence-and-trusted-runners.md).
