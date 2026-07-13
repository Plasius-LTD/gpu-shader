# @plasius/gpu-shader

Reflection-first contracts, CPU codecs, compatibility checks, style-profile
activation, and qualification tooling for WebGPU WGSL shaders.

> **Qualification status:** the declared physical WebGPU runner fleet has not
> been verified as provisioned, so this repository does not currently make a
> universal hardware-support claim for any shader. Missing physical cells fail
> closed.

## Why this package exists

A WGSL module can compile while its CPU producer still writes the wrong bytes.
`@plasius/gpu-shader` makes the final assembled WGSL the source of truth for
host-shareable layout and carries that truth through model storage and runtime:

- reflect records, bindings, entry points, overrides, and shader inputs from
  final assembled WGSL;
- generate TypeScript record types, byte constants, and CPU codecs from the
  reflected manifest;
- distinguish the model-facing `modelAbiHash` from the complete
  `shaderAbiHash`;
- load only promoted, immutable, digest-verified shader and style manifests;
- validate model semantics and device capabilities before resource creation;
- prepare a replacement style off-frame and activate it atomically at a frame
  boundary; and
- bind qualification evidence to exact shader bytes, compile units, fixtures,
  matrix policy, harness, and CI provenance.

Only WGSL is in scope. GLSL, SPIR-V, caller-supplied byte layouts, arbitrary
Blob URLs, and executable qualification bundles are rejected by design.

## Package boundaries

The package has three explicit exports:

| Export | Environment | Purpose |
| --- | --- | --- |
| `@plasius/gpu-shader` | Browser and Node.js | Contracts, strict manifest parsers, hashes, codecs, compatibility checks, catalog loading, and style activation |
| `@plasius/gpu-shader/node` | Node.js only | WGSL reflection, final-interface validation, and generated artifacts |
| `@plasius/gpu-shader/testing` | Test and qualification tooling | Compile-unit inventory, stable-matrix validation, trusted cell execution, and evidence aggregation |

The root export must remain browser-safe. Reflection and qualification tooling
are loaded through subpaths so browser bundles do not eagerly include Node.js
or browser-automation dependencies.

The primary browser-safe APIs are `assertImmutableAssetVersion`,
`createGpuRecordCodec`, `computeGpuAbiHash`, `validateModelShaderCompatibility`,
`loadShaderStyleProfile`, `prepareStyleProfile`,
`createShaderStyleController`, and `activateStyleProfile`, together with the
strict manifest parsers and versioned contracts. The build APIs
`reflectGpuInterface`, `validateAssembledGpuInterface`, and
`generateGpuInterfaceArtifacts` are exposed only from the Node subpath.

## Installation

After an approved GitHub CD release publishes the package:

```bash
npm install @plasius/gpu-shader
```

Do not publish from a local machine. Releases are produced only by
`.github/workflows/cd.yml` from `main` through the protected `production`
environment.

### Release controls

Release preparation always opens a short-lived `release/v*` pull request with
an installation token from the repository's release-preparation GitHub App.
The workflow refuses to mutate metadata unless `main` is protected and
repository auto-merge is enabled. The workflow-dispatch SHA must equal the
protected-main validation commit before any release artifact is built. If
preparation merges package or changelog metadata, the original run remains
bound to its earlier SHA and stops before publication. Start a second
`bump: none` run from the newly prepared `main` commit; `bump: none` resumes
that exact version and does not replace version preparation.

CD then crosses an explicit privilege boundary. The read-only,
unprivileged `validate-and-pack` job waits for successful push CI on the exact
validation commit, checks out the immutable release source commit, installs
dependencies, runs all release gates, and packs the package once. For a new
publication those commits must be identical. During recovery of an exact
already-published version, the release commit is derived from npm SLSA
provenance, must match the existing tag, and must remain an ancestor of the
validation commit. The attempt-scoped artifact contains exactly the npm
tarball, reproducible CycloneDX SBOM, and transport manifest; the release uses
a fixed Node/npm toolchain, and npm's volatile SBOM UUID and timestamp are
deterministically derived from the release source before schema v2 binds both
commit authorities, the file sizes and digests, package identity, and workflow
run.
The production `publish` job does not check out the repository or execute
checked-out package code. It downloads the artifact by its exact run-scoped identity
and GitHub artifact digest, revalidates the three-file closure and every bound
digest, resolves authoritative live npm state, and preflights the complete
GitHub tag/release/SBOM state before any mutation. Prerelease status and the npm
dist-tag are derived from the transported semantic version rather than retry
inputs. For a new publication, only then does the job attest, tag, publish, and
finalize the release. For an already-published recovery it verifies and
reconciles the same immutable state but does not create replacement tarball or
SBOM attestations.

Publication and recovery use that same tarball identity: an existing registry
version is accepted only when its SHA-512 integrity is identical. CD requires
npm SLSA provenance for the immutable release commit and protected-main
`cd.yml`, verifies npm registry signatures, and confirms the GitHub tag and
non-draft release point to that release commit. Recovery does not create new
tarball or SBOM attestations under the newer validation commit.

The first public version requires the production-environment `NPM_TOKEN`
because npm trusted publishing cannot be configured until the package exists.
After that version is published, configure npm trusted publishing for
`Plasius-LTD/gpu-shader`, workflow `cd.yml`, environment `production`, and
remove `NPM_TOKEN`. See the
[fleet and repository setup runbook](docs/operations/physical-fleet-readiness.md#repository-configuration).

## Reflect final assembled WGSL

Reflection is a build-time Node.js operation. Selectors identify which
reflected declarations are model-facing; they cannot provide offsets, sizes,
alignment, or strides.

```ts
import {
  generateGpuInterfaceArtifacts,
  reflectGpuInterface,
} from "@plasius/gpu-shader/node";

const gpuInterface = await reflectGpuInterface({
  interfaceId: "plasius.model.surface",
  interfaceVersion: "1.0.0",
  modules: [{ moduleId: "material", source: finalAssembledWgsl }],
  pipelines: [materialPipelineDescriptor],
  modelFacingRecordNames: ["Vertex", "Material"],
  modelFacingBindings: [
    { moduleId: "material", group: 0, binding: 0, semantic: "model.vertices" },
  ],
  semantics: [
    {
      semantic: "model.vertices",
      source: { kind: "binding", moduleId: "material", group: 0, binding: 0 },
    },
  ],
});

const generated = generateGpuInterfaceArtifacts(gpuInterface);
// Write generated.manifestJson, generated.typescriptTypes,
// generated.jsonSchemas, generated.byteConstants, and generated.codecs in the
// owning build step.
```

Every final compile unit should also call `validateAssembledGpuInterface` to
regenerate its interface and compare it with the canonical model-facing ABI.
`generatedBy.packageVersion` is read from this package's release-owned package
metadata. Reflection callers cannot supply or override that version, so
generated artifacts and qualification evidence identify the implementation
that actually produced them.

Qualification-bundle admission performs that regeneration again from the
digest-verified final module bytes and exact shader pipeline descriptors. It
requires the complete regenerated interface, `modelAbiHash`,
`interfaceAbiHash`, and `shaderAbiHash` to match the submitted contracts, so a
caller cannot admit a stale layout by merely rebuilding a self-consistent
manifest and digest graph. Every compile-unit pipeline and interface reference
must also exactly match the ABI-hashed shader core, and the inventory must
exercise every core pipeline.

Shader requirements are regenerated from the exact module set and pipeline
descriptors rather than trusted as an unconstrained sidecar. Comment-free WGSL
`enable` directives map to stable WebGPU feature names (`f16`,
`clip_distances`, `dual_source_blending`, `subgroups`, `primitive_index`, and
`subgroup_size_control`); an unknown or malformed enable fails admission.
Render target, depth/stencil, and storage-texture formats, unclipped-depth
support, bind-group and binding counts, per-stage buffer/texture/sampler usage,
uniform and storage binding sizes, vertex-buffer facts, inter-stage variables
and components, color-attachment counts, and compute workgroup dimensions,
invocations, and statically used storage bytes are derived and checked against
the manifest. Workgroup storage follows WebGPU's per-variable
`roundUp(16, SizeOf(T))` accounting across the entry point's transitive call
graph. External textures use their expanded WebGPU resource-slot costs. Every
model-facing semantic comes from the reflected ABI and must be present in the
declared requirements.
Admission and runtime repeat this check after loading the complete exact WGSL
module set, so declared requirements cannot understate the executable shader.

Each compute `GpuEntryPointInterface` records `workgroupStorageSize`; non-compute
entry points record `null`. Override-sized workgroup arrays currently fail
reflection closed because `wgsl_reflect` 1.5.0 does not retain the symbolic
element count needed to bind exact per-pipeline storage bytes.

## Encode CPU records from reflected layout

```ts
import {
  createGpuRecordCodec,
  parseGpuInterfaceManifest,
} from "@plasius/gpu-shader";

const manifest = parseGpuInterfaceManifest(JSON.parse(interfaceJson));
const material = manifest.records.find((record) => record.name === "Material");
if (!material) throw new Error("Material is not present in final WGSL");

const codec = createGpuRecordCodec(material, manifest.records);
const bytes = codec.encode({
  baseColor: [1, 0.4, 0.1, 1],
  roughness: 0.65,
});
```

The codec is little-endian, bounds checked, strict about unknown or missing
members, and writes deterministic zero padding. Unsupported or non-finite
values fail before upload.

## Validate a model and shader

```ts
import { validateModelShaderCompatibility } from "@plasius/gpu-shader";

const result = validateModelShaderCompatibility({
  model: modelManifest.gpu,
  shader: shaderManifest,
  gpuInterface: loadedGpuInterfaceManifest,
  capabilities: {
    features: [...device.features],
    limits: device.limits,
    formats: runtimeFormats,
  },
});

if (!result.ok) {
  reportShaderDiagnostics(result.diagnostics);
  // Fail closed: do not create model resources or pipelines.
}
```

Compatibility requires the exact model interface identity and
`modelAbiHash`, required model semantics, formats, WebGPU features, and device
limits. A full `shaderAbiHash` identifies the assembled pipeline interface but
does not replace the model-facing hash.

## Load and switch a style profile

Style profiles map roles such as `material`, `lighting`, `outline`, `shadow`,
and `post-processing` to exact immutable shader versions.

Every model, GPU-interface, shader, and profile version carried by a manifest
or immutable reference is checked with `assertImmutableAssetVersion`.
Reference versions are rejected before their corresponding catalog resolver
runs; loaded manifest versions are rejected before any child asset resolves.
Exact tokens such as `1`, `v1`, `1.2.3`, and
`2026.07.13-a1` are valid. Mutable aliases (`latest`, `stable`, `default`,
`main`, and similar), ranges, wildcards, URLs, and path syntax are rejected.
Catalog channels may use friendly names, but a resolved reference must contain
the exact immutable version.

```ts
import {
  activateStyleProfile,
  createShaderStyleController,
  loadShaderStyleProfile,
  prepareStyleProfile,
} from "@plasius/gpu-shader";

const loaded = await loadShaderStyleProfile({
  ref: cartoonProfileRef,
  catalog: promotedCatalogResolver,
});
if (!loaded.ok) throw new Error("Profile failed immutable loading");

const prepared = await prepareStyleProfile({
  loaded: loaded.value,
  model: modelManifest.gpu,
  capabilities,
  device,
});
if (!prepared.ok) throw new Error("Profile failed GPU preparation");

const controller = createShaderStyleController({ scheduler: frameScheduler });
const activation = await activateStyleProfile({
  controller,
  prepared: prepared.value,
});
```

Preparation verifies digests, compiles modules with
`getCompilationInfo()`, creates layouts and pipelines, and leaves the current
profile untouched on failure. Activation swaps only after preparation and at a
frame boundary. Styles sharing a `modelAbiHash` do not require model-buffer
repacking; profiles needing extra semantics are offered only to models that
provide them.

## Qualification policy

A compile unit is final assembled WGSL plus its entry point, serializable
pipeline descriptor, override set, interface reference, resources, and a
bounded declarative semantic fixture. Every WGSL fragment must be included in
at least one compile unit.

The versioned baseline matrix is
[`matrices/stable-webgpu-2026-07-13.json`](matrices/stable-webgpu-2026-07-13.json).
It contains 15 representative physical cells and one required Ubuntu Chromium
SwiftShader smoke cell. All 16 are blocking; only the 15 physical cells count
toward stable physical support. A skip, timeout, unavailable runner or adapter,
device loss, missing result, stale evidence, or unexpected result fails the
gate. The checked-in file is the exact canonical JSON policy artifact; its byte
digest must equal `SUPPORTED_STABLE_WEBGPU_MATRIX_POLICIES[0].matrixSha256`.
Any policy-byte or digest change requires complete shader-inventory
requalification and does not itself qualify a shader.

Candidate archives may contain only declarative JSON, WGSL, and bounded binary
fixtures. Physical runners execute a pinned trusted harness from this
repository. Candidate JavaScript, shell code, executables, symlinks, devices,
and executable callbacks are not qualification inputs.

Every compile unit must probe both directions of every model-facing byte
interface it uses:

- a `buffer-record` probe is required for each model-facing record binding;
  the reflected CPU codec must reproduce the exact uploaded byte slice, and
  the GPU result is decoded with the reflected output-record codec before its
  semantic value is compared; and
- a `vertex-input` probe is required for each model ABI vertex semantic; the
  reflected `GPUVertexFormat`, offset, stride, slot, step mode, draw element,
  and semantic determine the exact uploaded byte range, and shader-observed
  output is decoded and compared.

A generic readback digest does not replace either structured layout probe.
Fixture resources are also exact contracts: texture dimension, extent,
format, usages, mip count, sample count, upload mip/origin/aspect,
`bytesPerRow`, `rowsPerImage`, and byte length must agree. Texture views,
attachments, copies, buffer ranges, and readback ranges must stay within those
declared resources and the fixture's bounded command, memory, texel, and
timeout limits.

Qualification evidence binds a shader-manifest core rather than a profile.
After that evidence is bound into the final immutable shader manifest, profile
admission validates its exact shader-version references and their evidence.
This two-stage sequence keeps profiles exact-version pinned without creating a
profile/evidence/shader-manifest digest cycle.

`validationEvidence` is always bound to one exact supported universal
stable-WebGPU matrix ID, version, and SHA-256. Optional
`additionalValidationEvidence` entries are uniquely named scopes such as `xr`,
each carrying its own exact matrix-policy digest. A style profile pins every
`requiredValidationScopes` entry to that same scope and exact matrix identity;
loading rejects a missing or different matrix. Supplemental evidence must be
an independently identified artifact and attestation: it cannot reuse the
universal evidence ID, URI, digest, attestation URI, attestation digest, matrix,
or any corresponding identity from another supplemental result or distinct
shader version in the profile. Evidence and attestation URIs must use canonical
URL serialization and remain inside the promoted catalog root.

This release intentionally has an empty additive-policy registry. Any
non-empty `additionalValidationEvidence` or `requiredValidationScopes` fails
closed until reviewed supplemental matrix bytes, genuinely additive lanes,
their validator, and their exact scope/ID/version/SHA-256 tuple ship together
in a framework release. An `xr` label alone can never create XR qualification.

### Exact workflow evidence flow

1. The trusted prepare job fetches one immutable Blob version through OIDC,
   validates the data-only archive, rebuilds the pinned harness, fingerprints
   its exact source and built output, and emits the candidate artifact plus a
   qualification-preflight manifest bound to the candidate, inventory, raw
   matrix bytes, harness, workflow run, attempt, and OIDC subject.
2. Runner preflight records the actual runner API name and complete label list
   for every eligible route. Matrix labels are a required subset of those
   actual labels. Hosted SwiftShader can independently fingerprint its adapter
   harness; physical inventory normally records `adapterHarness: null` because
   the GitHub runner API cannot inspect runner-local executable bytes.
3. Each execution job rebuilds and verifies the same harness fingerprint,
   consumes the exact candidate, matrix, qualification preflight, and runner
   preflight artifacts, and emits either cell evidence from the actual runner
   or a non-qualifying diagnostic from that job. A timeout, failure, missing
   adapter, or missing artifact never becomes passing evidence.
   Candidate, preflight, runner-preflight, cell, and aggregate transport
   artifacts include the GitHub run attempt so immutable artifacts from a
   rerun cannot collide with or be mixed into another attempt. Cell output is
   published atomically, and the first executable job step creates a typed
   fallback diagnostic for later setup failures.
4. Aggregation retains the exact raw matrix artifact, requires one result for
   every compile-unit-by-cell pair, validates the aggregate again, and retains
   `qualification-evidence.json`, its GitHub build-provenance bundle, and the
   strict digest-bearing attestation-reference JSON.
5. GitHub artifacts are transport, not durable admission state. Model storage
   must copy and digest-verify the exact candidate, matrix, evidence,
   attestation reference, and attestation bundle into immutable roots before a
   final shader manifest can reference their storage URIs and SHA-256 digests.
   Profile admission follows only after those evidence-bound shader versions
   exist.

Physical execution additionally requires a runner-owned, self-contained
`.mjs` automation adapter registered through Node's preload-only path. Its
absolute `file:` URL and domain-separated SHA-256 are fixed in runner service
configuration, and it must live under the platform root documented in the
[physical fleet readiness runbook](docs/operations/physical-fleet-readiness.md).
Before execution, a fixed bootstrap resolves the real path, validates the
reviewed single-file policy and exact digest, and imports an in-memory snapshot
of those verified bytes. Candidate, preflight, and evidence data live in a
run/attempt/cell-specific `RUNNER_TEMP` directory that is removed after every
outcome. The candidate and workflow inputs cannot select or replace executable
code.

See [Qualification evidence and trusted runners](docs/tdrs/tdr-0001-qualification-evidence-and-trusted-runners.md)
and the [physical fleet readiness runbook](docs/operations/physical-fleet-readiness.md).

## Storage and runtime trust boundary

This package defines contracts and validation; it does not own Blob or catalog
state. Model storage owns immutable model, shader, interface, profile, fixture,
and evidence bytes. The durable asset catalog owns promoted exact-version
pointers and rollback. Runtime resolvers must expose only promoted assets and
must verify manifest and module digests before returning bytes.

The rollout flag is `asset.pipeline.shader-store.enabled`. It gates public
candidate submission and runtime shader/profile discovery, loading and
activation. Disabling it fails closed; it does not authorize arbitrary Blob
URLs, checked-in catalogs or unmanaged shaders as a fallback. A separately
governed, bounded pre-store default may exist only for the documented migration
window.

Separately authorized private intake, qualification, immutable promotion and
rollback rehearsal remain operable while the flag is off so operators can make
the store ready without exposing it. The user-visible style-selection
capability is `gpu.shader.style.select`; rendering a model's promoted default
profile does not require that capability once runtime store access is enabled.

## Development

Use Node.js 24 and npm:

```bash
npm ci
npm run lint
npm run typecheck
npm run build
npm run test:coverage
npm run shader:matrix
npm run pack:check
```

Framework TypeScript must maintain at least 80% LCOV line coverage. WGSL is the
standing line-coverage exception, replaced by 100% compile-unit inventory and
100% required matrix-cell passage. See [Testing strategy](docs/testing.md).

## Documentation

- [Documentation index](docs/index.md)
- [Framework design](docs/design/wgsl-shader-compatibility-and-style-framework.md)
- [ADR: final WGSL is the source of truth](docs/adrs/adr-0001-final-assembled-wgsl-is-the-interface-source-of-truth.md)
- [ADR: immutable GPU asset versions before catalog access](docs/adrs/adr-0003-immutable-gpu-asset-versions-before-catalog-access.md)
- [TDR: qualification evidence and trusted runners](docs/tdrs/tdr-0001-qualification-evidence-and-trusted-runners.md)
- [TDR: exact immutable GPU asset version grammar](docs/tdrs/tdr-0002-exact-immutable-gpu-asset-version-grammar.md)
- [Physical fleet readiness](docs/operations/physical-fleet-readiness.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License

Apache-2.0. See [LICENSE](LICENSE).
