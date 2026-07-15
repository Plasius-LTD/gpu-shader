# Testing strategy

The framework uses layered verification because reflection, WebGPU validation,
semantic correctness and platform support answer different questions.

## Local quality gates

Run with Node.js 24:

```bash
npm ci
npm run lint
npm run typecheck
npm run build
npm run test:coverage
npm run shader:matrix
npm run pack:check
```

TypeScript framework source must remain at or above 80% LCOV line coverage.
Every changed source file must appear in combined LCOV. Browser-safe ESM/CJS,
Node-only, testing, and CLI entry points require import/smoke coverage.
CI runs package code without OIDC authority. Only after every required gate
passes is the exact attempt-scoped `lcov.info` transported to a separate,
data-only Codecov job that holds `id-token: write` and executes no checkout,
package lifecycle, or repository-authored command.

WGSL is exempt from line coverage, not from verification: every fragment must
belong to at least one compile unit and every required unit/cell pair must pass
before stable promotion.

## Unit tests

### Reflection and independent source analysis

Cover nested records, fixed and runtime arrays, matrices, atomics, all host
address spaces, `@align`, `@size`, explicit padding, entry-point IO, overrides,
workgroup dimensions, vertex inputs, binding resources and access modes.
For module-scope workgroup variables, cover scalar/array/record sizes, WebGPU's
16-byte per-variable rounding, unused declarations, and references reached
through called functions. Verify compute entry points serialize exact storage
bytes and non-compute entry points serialize `null`; reject symbolic
override-sized arrays rather than accepting an understated reflector result.

Reject duplicate globals/bindings/overrides/entry points, invalid address-space
types, illegal runtime-array placement, reflected/source disagreement, missing
selected records and pipeline descriptors that contradict shader IO.

Verify `generatedBy.packageVersion` comes from the package's release-owned
metadata and cannot be supplied by a reflection caller. A package version,
reflector, generator or trusted-harness change must alter the relevant
provenance and trigger the documented requalification scope.

### Derived shader requirements

Strip line and nested block comments before parsing WGSL `enable` directives.
Test comma-separated supported enables and their WebGPU feature mappings, plus
malformed, unterminated and unmapped enables. Verify requirements are derived
from the complete exact module set, not a subset.

Test structural format and limit derivation for render color/depth targets,
storage textures, unclipped depth, bind groups and entries, combined
bind-group/vertex-buffer use, per-stage buffer/texture/sampler counts,
external-texture slot expansion, uniform/storage binding sizes, vertex buffers,
attributes and stride, inter-stage variables/components, color attachments, literal and
override-resolved compute workgroup sizes, total invocations, and
`maxComputeWorkgroupStorageSize` from statically used workgroup bytes. Require the
full reflected model-semantic set. Admission and runtime tests must reject an
omitted/understated derived semantic, feature, format or limit and a
missing/extra source module before resource creation.

### Canonicalization and hashes

Verify fixed code-unit key ordering, deterministic tuple ordering, rejection of
cycles/unsupported/non-finite JSON, SHA-256 format, model projection isolation,
full interface sensitivity and locale independence.

Exercise the bounded own-data snapshot before every parser family. Returning
and throwing nested accessors must be rejected with zero reads. Proxy `get`
traps must not run; unavoidable prototype/key/descriptor traps must produce a
constant diagnostic with no raw message or cause. Cover sparse and custom
arrays, symbols, non-enumerable fields, behavioral prototypes, revoked Proxies,
cycles, shared acyclic objects, invalid Unicode, depth/nodes/properties/elements,
single and aggregate string bytes, aggregate canonical bytes, encoded-input
bytes, and oversized/deep unknown fields. Assert valid plain JSON preserves
byte-identical JCS and ABI hashes.

### Generated artifacts and codecs

Verify generated manifest/type/constants/codec text is deterministic. Test
little-endian scalars, vector/matrix padding, nested records, fixed arrays,
runtime-array prefix/stride, atomics, finite floating-point values, integer
ranges, strict members, zeroed padding, subview bounds, decode bounds and
runtime byte-length divisibility.

For a buffer root ending in a runtime array, separately verify the WebGPU bind
group-layout minimum: the trailing array is treated as containing one element.
The record's fixed `minimumByteSize` remains the codec prefix and must not be
used as `minBindingSize`. Model-facing buffer roots must be named WGSL records;
scalar, vector and array roots are rejected rather than hashed without their
complete element type.

### Strict manifests

Use adversarial unknown-field tests at every nested object. Validate enums,
digests, uniqueness, stable ordering, cross-references, pipeline/entry-point
relationships, evidence subject identity, exact counts and canonical content
type.

### Runtime

Test promoted-only catalog behavior, exact manifest/module digests, model ABI,
semantics/features/formats/limits, correct `getCompilationInfo()` use, explicit
layouts/pipelines, error scopes, device loss, atomic activation, previous-style
retirement, and failure fallback. Mutate caller-visible Maps and module bytes
after loading and prove private trusted snapshots remain unchanged; reject
structurally forged loaded/prepared values and re-hash private WGSL bytes
immediately before module creation. Verify every supplemental profile scope,
matrix ID, version, and SHA-256 against every exact referenced shader; reject a
relabelled universal matrix or a different supplemental matrix policy. Also
reject any supplemental scope that reuses the universal or another
supplemental evidence ID, URI, artifact digest, attestation URI, or attestation
digest, including cross-kind reuse and reuse by distinct shaders in one
profile. Reject noncanonical and non-catalog evidence/attestation URIs. While
the additive-policy registry is empty, require every supplemental manifest or
profile scope to fail closed; when a real policy is introduced, test its exact
raw bytes and genuinely additive lanes before adding any positive scope case.

## Regression fixtures

Keep dedicated failing fixtures for:

- fluid `vec3` CPU packing against WGSL `vec4` stride;
- fluid byte solid masks against WGSL `u32` storage;
- duplicate globals after WGSL assembly;
- renderer/lighting record-size drift;
- worker entry-point hook signature differences;
- reflected bindings omitted from a pipeline layout; and
- calling the nonexistent `compilationInfo()` instead of
  `getCompilationInfo()`.

## Compile-unit qualification

For each final compile unit, the trusted harness requires:

- exact final assembly and module digest;
- regenerated schema/model ABI equality;
- module compilation with zero errors;
- explicit pipeline-layout and pipeline creation;
- explicit bind-group creation;
- one `buffer-record` probe for every model-facing record binding used by the
  unit, proving reflected-codec bytes and reflected output-record decoding;
- one `vertex-input` probe for every model ABI vertex semantic used by the
  unit, proving exact vertex format/offset/stride/slot/step mode/element bytes
  and reflected output-record decoding;
- one bounded dispatch or draw; and
- semantic readback equal to the fixture expectation.

The inventory validator fails when a WGSL fragment is uncovered or a referenced
module, pipeline, interface, override or fixture is absent/inconsistent. A
generic readback digest cannot satisfy a required structured layout probe.

Qualification fixture tests must reject a texture whose dimension, extent,
format, usages, mip count or sample count conflicts with its upload, view,
attachment or copy. Test exact initial-data mip/origin/aspect, `bytesPerRow`,
`rowsPerImage`, and byte length; exact texture-copy extents and row layout;
buffer/view/readback bounds; unsupported formats/aspects; and every declared
memory, texel, command and timeout limit.

## Admission integration tests

Reject modified module/fixture bytes, stale or cross-subject evidence,
incompatible ABI hashes, missing model semantics, unsupported device
requirements, incomplete/duplicate/unexpected matrix results, executable
candidate content and non-schema-driven new shaders.

Test immutable batch upload, digest readback, manifest-last ordering, atomic
promotion, optimistic concurrency, orphaned unpromoted cleanup, rollback and
cache invalidation.

Test rollout boundaries independently: with
`asset.pipeline.shader-store.enabled` disabled, public candidate submission and
runtime discovery/loading/activation fail closed, while separately authorized
private qualification, immutable promotion and rollback rehearsal remain
available. Verify that flag-off behavior cannot reach a checked-in catalog,
arbitrary Blob URL or unmanaged shader. A migration-only bounded pre-store
default requires separate governance and an explicit removal condition.

### Trusted workflow and fleet tests

Verify the qualification-preflight subject binds the immutable Blob version,
candidate, inventory, exact raw matrix, harness, workflow run/attempt and OIDC
claims. Runner-preflight tests must retain actual runner API names and complete
label arrays while accepting only runners whose labels contain the matrix's
required set. Physical inventory may use `adapterHarness: null`; it must never
invent an executable identity from requested labels or host assertions.

Test the fixed Linux, macOS and Windows preload roots, absolute `file:` URL,
`.mjs` restriction, self-contained-code policy, domain-separated adapter
SHA-256, runner/cell/harness binding, and runtime driver/version/digest match.
Candidate data and ordinary CLI arguments must be unable to select a physical
adapter. A physical adapter must independently observe OS, browser,
adapter/device/backend/driver, features and limits rather than copying matrix
targets.

Aggregation tests consume the exact candidate, raw matrix,
qualification-preflight, runner-preflight and cell artifacts. Reject wrong
producer run/attempt/ref/SHA, missing/duplicate/cross-attempt cells, changed
automation digest, non-qualifying diagnostics presented as evidence, mutated
evidence bytes, stale external references and failed cryptographic attestation.
Explicitly reject trusted-workflow refs pinned directly to a raw SHA or any ref
other than protected `refs/heads/main`, even when the separately recorded
workflow SHA is well formed.
Storage integration must prove the exact matrix, evidence, attestation ref and
attestation bundle are copied into immutable model storage and digest verified
before the final shader manifest is admitted. Profile admission remains a
separate second stage against evidence-bound exact shader versions.

## End-to-end tests

Exercise model load, compatible-profile discovery, exact-version pinning,
realistic-to-cartoon/anime switching without repacking for a shared
`modelAbiHash`, semantic-based profile exclusion, preparation failure fallback,
frame-boundary activation, channel rollback and stale-cache invalidation.

## Matrix acceptance

The baseline declares 16 blocking cells: 15 physical and one SwiftShader smoke
cell. All must pass with one exact result per compile unit. Missing adapters,
skips, timeouts, runner unavailability and device loss are failures. SwiftShader
does not satisfy a physical cell.

Until every physical runner is provisioned and calibrated, matrix validation
can prove policy shape and SwiftShader can provide smoke feedback, but neither
is a stable universal support claim.
