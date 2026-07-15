# WGSL shader compatibility and style framework

- Status: Initial implementation
- Date: 2026-07-13
- Rollout flag: `asset.pipeline.shader-store.enabled`
- Style-selection capability: `gpu.shader.style.select`
- Architecture: [ADR 0001](../adrs/adr-0001-final-assembled-wgsl-is-the-interface-source-of-truth.md)
- Qualification: [TDR 0001](../tdrs/tdr-0001-qualification-evidence-and-trusted-runners.md)
- Contract snapshot boundary: [ADR 0004](../adrs/adr-0004-bounded-own-data-contract-snapshot-boundary.md)
- Snapshot limits: [TDR 0003](../tdrs/tdr-0003-bounded-contract-snapshot-policies.md)

## Goals

The framework prevents model/shader layout mismatch from becoming a runtime
surprise. It provides one contract family from final WGSL assembly through
model-storage admission and browser activation, while allowing scenes to pin
or switch exact rendering styles.

The initial delivery must:

- derive CPU layout artifacts from final assembled WGSL;
- keep model and full shader ABI identities distinct;
- publish immutable model, shader, interface, profile and evidence assets
  through the existing model/asset storage lifecycle;
- enforce digest, ABI, semantic and device compatibility at admission and
  runtime;
- support exact-version profiles such as realistic, cartoon and anime;
- qualify every fragment through a final compile unit and every compile unit
  through every required matrix cell; and
- preserve the active/default style when a replacement fails.

## Non-goals

- GLSL or SPIR-V admission.
- Transpiling WGSL from another shading language.
- Treating reflection as a substitute for browser/device compilation.
- Executing candidate-authored tests on physical runner hosts.
- Claiming coverage for every GPU model ever manufactured.
- Moving all existing demo shader source into the asset store immediately.

## System boundaries

```text
shader repository/build
  assemble WGSL + pipeline descriptor + overrides
  reflect final interface -> generate CPU artifacts
  declare compile units + bounded fixtures
                     |
                     v
trusted qualification harness ---- versioned stable WebGPU matrix
                     |
                     v
model/asset storage admission
  regenerate + compare + verify exact evidence
  write immutable bytes, then atomically promote catalog pointer
                     |
                     v
browser runtime
  resolve promoted profile -> verify digests/ABI/capabilities
  prepare pipelines asynchronously -> switch at frame boundary
```

`@plasius/gpu-shader` owns portable contracts and validation behavior. It does
not own Azure credentials, Blob mutation, catalog persistence, model
serialization, UI entitlements, or physical runner provisioning.

## Contract family

### `GpuInterfaceManifest`

Generated from final assembled WGSL and its pipeline descriptors. It records:

- module digests;
- reflected records including effective alignment, logical and occupied sizes,
  offsets, array/matrix strides, runtime-array prefixes and address spaces;
- group/binding resources, access and visibility;
- entry points, stage IO, workgroup sizes, statically used workgroup-storage
  bytes and overrides;
- shader input locations/types paired with validated pipeline vertex-buffer
  facts;
- the selected model-facing records, bindings, vertex inputs and semantics;
- `modelAbiHash` and complete `interfaceAbiHash`; and
- reflector/package provenance.

Selectors identify reflected declarations. They cannot provide layout values.
The package version in `generatedBy` is read from the installed, release-owned
`@plasius/gpu-shader` package metadata. It is not a reflection input and cannot
be replaced by the caller.

### `ShaderVersionManifest`

An immutable shader identity containing exact module URIs, byte lengths and
digests; final pipelines and role mappings; compatible model interfaces;
required semantics, features, limits and formats; `shaderAbiHash`; and an exact
universal validation-evidence reference, including the exact supported matrix
ID, version, and SHA-256. Additive qualification such as XR is represented by
unique scoped evidence references with distinct exact matrix-policy digests.
Evidence fields are excluded from the cycle-free shader-manifest core and can
never replace or relabel universal evidence. The current release registers no
additive policy, so supplemental evidence is rejected until reviewed policy
bytes, additive lanes, validation rules, and an exact policy tuple are released
together.

WGSL modules use the canonical content type `text/wgsl; charset=utf-8`.

### `ShaderStyleProfileManifest`

Maps each render role to an exact `ShaderVersionRef`. Profiles declare their
compatible model interfaces, additional required semantics, and any required
supplemental validation scopes. Each scope pins an exact matrix ID, version,
and SHA-256. Loading fails unless every exact shader version provides that
scope from the same registered matrix policy. The current empty registry means
every non-empty scope list fails closed. Models may reference a default profile,
while the catalog can expose later compatible profiles without republishing
model bytes.

### Model extension

The owning model manifest carries `GpuInterfaceRef`, `modelAbiHash`, provided
semantics, and an optional default `ShaderStyleProfileRef`. The model and
profile contracts independently verify the same model-facing ABI identity.

### Qualification contracts

Compile-unit inventories cover every WGSL fragment. Declarative fixture
manifests describe bounded resources, initial bytes, bind groups, dispatches or
draws, copies and expected readback digests. Shader evidence binds the exact
shader-manifest core, inventory, matrix, harness, interface, model fixtures,
model ABI, modules and CI provenance. A profile is admitted only after its
exact shader manifests exist and each referenced shader's evidence has been
validated; profiles are intentionally not embedded in per-shader evidence, so
there is no profile/evidence/shader-manifest digest cycle.

Fixtures include structured layout probes in addition to ordinary readbacks.
Each model-facing record binding used by a compile unit requires a
`buffer-record` probe: the reflected codec must encode the exact uploaded input
slice, and the GPU output is decoded through the reflected output-record codec.
Each model ABI vertex semantic used by a compile unit requires a `vertex-input`
probe that binds the reflected vertex format, offset, stride, slot, step mode,
draw element and shader location to exact input bytes and a GPU-observed output
record. A matching generic digest does not satisfy either obligation.

Resource descriptors are exact and bounded. Texture extent, dimension, format,
usage, mip count and sample count must agree with every upload, view,
attachment and copy. Initial data additionally fixes mip level, origin, aspect,
row pitch, rows per image and exact byte length. Buffers, texture copies,
readbacks, command counts, memory, texel counts and execution time must remain
inside the declared fixture bounds.

### Derived requirements

`ShaderRequirements` is checked against facts regenerated from the exact
assembled module set, reflected interface, and serializable pipeline
descriptors. The framework:

- strips comments and maps stable WGSL `enable` names to the corresponding
  WebGPU features, rejecting malformed or unmapped enables;
- derives render color, depth/stencil, and storage-texture formats plus the
  `depth-clip-control` requirement for unclipped depth;
- derives bind-group/binding, combined bind-group/vertex-buffer,
  uniform/storage binding-size, per-stage buffer/texture/sampler (including
  external-texture expansion), vertex-buffer/attribute/stride,
  color-attachment, inter-stage variable/component, and compute
  workgroup-size/invocation/storage limits; and
- requires every model-facing semantic represented by the reflected model ABI.

For each compute entry point, independent source analysis walks its transitive
function-call graph and records the sum of `roundUp(16, SizeOf(T))` for every
statically referenced module-scope `var<workgroup>` declaration, matching the
WebGPU pipeline-creation limit calculation. A symbolic override-sized workgroup
array is rejected until its pipeline-resolved count can be represented without
depending on reflector metadata that has discarded the expression.

Admission and runtime both reload every exact digest-verified WGSL module and
repeat derived-requirement validation. A manifest cannot omit a structural
requirement and a partial module set cannot be used to reduce one.

## Build flow

1. Assemble each final WGSL module exactly as it will be compiled.
2. Provide deterministic serializable pipeline descriptors and override values.
3. Call `reflectGpuInterface` through the Node-only export.
4. Independently parse WGSL layout facts and compare them with reflection.
5. Validate reflected shader locations/types against pipeline vertex formats,
   offsets, strides and bind-group declarations.
6. Generate manifest JSON, TypeScript types, byte constants and codecs.
7. Derive and validate shader semantics, features, formats and limits from the
   exact modules, interface and pipeline descriptors.
8. Call `validateAssembledGpuInterface` for every compile unit and reject any
   final module whose model-facing projection differs from the canonical one.
9. Build a compile-unit inventory in which every WGSL fragment is covered and
   every model-facing record binding and vertex semantic has its required
   structured layout probe.
10. Run the required qualification matrix and aggregate exact evidence.

Generation does not write files implicitly. The owning repository decides
where generated artifacts live and verifies them for drift in CI.

## Storage admission and promotion

The model storage pipeline manages separate immutable roots for models,
interfaces, shaders, profiles, fixtures and evidence. Admission follows this
order:

1. intake authenticates the caller and accepts a data-only candidate;
2. candidate bytes are bounded, normalized and SHA-256 verified;
3. the service assembles/refetches final WGSL and regenerates interface facts,
   generated schema and hashes;
4. caller layout claims are absent or exactly equal to regenerated values;
5. model fixtures and required semantics are validated;
6. exact module sources regenerate the same interface and derived requirements;
7. shader evidence is fresh and matches the exact candidate, model fixtures,
   compile-unit inventory, matrix, trusted harness and complete Cartesian
   result set;
8. the external build-provenance bundle and digest-bearing attestation
   reference are cryptographically verified against the exact evidence bytes;
9. the final shader manifest binds that evidence and exact
   attestation-reference asset, then profile admission validates exact
   references to already admitted shader manifests;
10. immutable assets are uploaded and read back/digest verified;
11. manifests are written after their referenced bytes; and
12. the catalog/channel pointer changes atomically with optimistic concurrency.

Any mismatch rejects the batch. Partial uploads remain unpromoted and are not
runtime-visible. Rollback changes a catalog pointer to an older complete
immutable version; it never edits published bytes.

Only the durable catalog can promote assets. During migration, checked-in
artifacts may serve only a separately governed bounded pre-store default using
exact manifest-declared WGSL and JSON. They are not a selectable catalog, a
general fallback, or an independent compatibility authority.

### Qualification artifact flow

The trusted prepare job fetches one immutable Blob version through OIDC and
emits a validated data-only candidate artifact plus qualification-preflight
evidence. The preflight binds the candidate and inventory digests, exact raw
matrix bytes, trusted harness fingerprint, subject binding, workflow
repository/ref/commit/run/attempt, and verified OIDC subject.

Runner preflight records actual GitHub runner API names and their complete
label arrays. Matrix labels are a required subset, not a substitute for those
observations. The hosted SwiftShader route can independently fingerprint its
automation adapter. Physical inventory uses `adapterHarness: null` when it
cannot inspect runner-local executable code; the physical cell must verify and
record that code during execution instead of fabricating an inventory claim.

Each cell consumes the same candidate, exact matrix, qualification preflight,
runner preflight and harness fingerprint. Passing output includes the actual
producer and automation code SHA-256. A timeout or early failure emits only a
non-qualifying diagnostic from the actual cell job. Aggregation retains the raw
matrix artifact, validates exactly one result for every compile-unit/cell pair,
then retains the evidence JSON, external GitHub build-provenance bundle, and a
strict reference containing the evidence and bundle digests.

Workflow artifacts are temporary transport. Model storage must immutably copy
and digest-verify the candidate, matrix, evidence, attestation reference and
attestation bundle. Only storage URIs and SHA-256 digests from that immutable
copy may be written into a final `ShaderValidationEvidenceRef`.

## Runtime flow

1. Resolve a model and optional selected style through promoted catalog refs.
2. Require every resolved model, interface, shader, and profile reference to
   carry an exact immutable version; reject aliases, ranges, wildcards, URLs,
   and path syntax before catalog access.
3. Load profile, shader, interface and module bytes through a
   `PromotedShaderCatalogResolver`; direct arbitrary URLs are not accepted.
4. Parse strict manifests and reject unknown, malformed or inconsistent fields.
5. Verify every manifest and module digest before decoding WGSL.
6. Re-derive requirements from the complete exact WGSL module set and pipeline
   descriptors.
7. Require exact interface identity, `modelAbiHash`, model semantics, formats,
   features and limits.
8. Compile with `createShaderModule` and inspect `getCompilationInfo()`.
9. Create explicit bind-group layouts, pipeline layouts and pipelines under a
   WebGPU validation error scope.
10. Keep prepared resources separate from the active profile.
11. Atomically activate at a frame boundary; dispose the previous profile only
   after the switch succeeds.

Typed diagnostics describe invalid contracts, digests, ABI mismatch, missing
semantics/features/limits/formats, unpromoted assets, compilation/pipeline
failure, device loss and activation failure. Failure retains the current or
default profile.

All JavaScript contract values cross the bounded own-data snapshot described
by ADR 0004 before step 4 reads a schema field. Runtime/model inputs and full
qualification products use the separate finite policies in TDR 0003. The
snapshot copies descriptor values only, rejects accessors and sparse or
behavioral structures, and sanitizes unavoidable Proxy reflection failures
without preserving their cause. This makes the strict parser a resource and
code-execution boundary as well as a schema boundary.

## Style discovery and access

The catalog returns only profiles whose compatible model interface and
required semantics match the selected model. User-facing discovery and
selection require `gpu.shader.style.select`. Loading the model's default
profile remains available without that capability.

`asset.pipeline.shader-store.enabled` gates public candidate submission and
runtime shader/profile discovery, loading and activation. Disabling it fails
closed and does not authorize arbitrary Blob URLs, checked-in catalogs,
unmanaged shaders or a general legacy path. A separately governed, bounded
pre-store default may remain only during the documented migration window.

Private intake, qualification, immutable promotion and rollback rehearsal use
separate operator authorization and must remain functional while the rollout
flag is off. This lets operators prepare and verify complete immutable versions
without exposing public intake or runtime use. Turning the flag off does not
mutate catalog state or immutable assets.

Scenes and releases may pin exact profile versions. Friendly channels such as
`stable` resolve to exact immutable versions and are recorded in scene/release
state for reproducibility.

## Requalification

An ordinary shader change requalifies every affected profile and model fixture.
The complete shader inventory is requalified when any of these change:

- reflection or independent layout analysis;
- generated packing/codecs or canonical model interfaces;
- shared WGSL assembly;
- runtime compatibility or resource creation;
- support-matrix policy;
- qualification fixture/evidence contract;
- trusted harness or WebGPU toolchain.

When an XR policy is registered, an XR profile must pass the universal matrix
plus its genuinely additional XR lanes. A
shader manifest therefore retains its mandatory universal evidence and adds an
`xr` scoped evidence reference bound to the exact XR matrix digest; the profile
declares that same scope, matrix ID, version, and digest in
`requiredValidationScopes`. Reusing or relabelling the universal matrix,
evidence artifact, or attestation is rejected; supplemental evidence IDs,
URIs, digests, attestation URIs, and attestation digests must also be mutually
unique within a manifest and across distinct shaders in the same profile.
Evidence and attestation URIs must be canonical promoted-catalog assets. No XR
policy is registered in this release, so XR evidence currently fails closed.
A platform-limited shader cannot be promoted into the stable
universal catalog.

## Initial regression fixtures

The framework test inventory includes known failure shapes from current
repositories:

- fluid velocity `vec3`/`vec4` packing and solid-mask `u8`/`u32` drift;
- duplicate globals after shader assembly;
- renderer and lighting record-size drift;
- worker hook entry-point signature differences;
- missing bind-group entries for reflected module bindings; and
- using `compilationInfo()` instead of WebGPU's `getCompilationInfo()`.

## Rollout stages

1. Keep `asset.pipeline.shader-store.enabled` off while landing contracts,
   reflection, codecs, strict parsing and trusted qualification tooling.
2. Release the package through the approved GitHub CD workflow.
3. Extend asset contracts, processing, storage, model manifests and runtime
   consumers using released exact package versions.
4. Add compile-unit inventories to existing/demo shader repositories.
5. Provision, attest and calibrate every physical matrix runner.
6. Through separately authorized private operations, qualify the complete
   inventory, promote immutable versions, and rehearse catalog rollback; do not
   promote while any cell is missing.
7. Enable public candidate submission for controlled evaluator cohorts under
   the shader-store flag.
8. Enable catalog-backed runtime discovery, loading, activation and style
   selection for controlled evaluator cohorts under the same flag.
9. Retire the checked-in demo catalog as an independent source after durable
   catalog behavior and rollback have been proven. During migration it may
   serve only a separately governed bounded pre-store default.

## Current blockers

As of 2026-07-13, the declared physical runner fleet has not been verified as
provisioned. No shader can satisfy the universal stable promotion gate until all
15 physical cells plus the required SwiftShader smoke cell produce current,
exact, passing evidence. Repository setup also requires the release and CI
secrets/variables described in the operations runbook before publication.
