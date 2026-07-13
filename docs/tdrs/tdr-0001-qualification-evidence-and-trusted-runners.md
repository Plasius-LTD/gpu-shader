# TDR 0001: Qualification evidence and trusted runners

- Status: Accepted for initial implementation
- Date: 2026-07-13
- Matrix: [`stable-webgpu-2026-07-13.json`](../../matrices/stable-webgpu-2026-07-13.json)
- Related architecture: [ADR 0001](../adrs/adr-0001-final-assembled-wgsl-is-the-interface-source-of-truth.md)

## Problem

Shader admission needs evidence from real WebGPU implementations, but a shader
candidate is untrusted input. Running candidate-provided JavaScript or shell
hooks on long-lived physical runners would turn a compatibility test into a
remote-code-execution boundary. At the same time, accepting incomplete or
loosely identified results could promote a shader that was not tested against
the declared matrix.

The qualification design must therefore prove two things independently:

1. the exact shader/interface candidate and its model compatibility fixtures
   passed the exact required compile-unit-by-cell product; and
2. physical runner hosts executed only a fixed, reviewed harness against a
   bounded declarative candidate.

## Decision

### Compile units and inventory

A compile unit declares final assembled WGSL modules, module digests, entry
points, serializable pipeline descriptors, interface version, override values,
fragment membership, and an exact qualification fixture reference. An inventory
is valid only when every fragment is covered by at least one unit and every
referenced module, entry point, pipeline, fixture and interface is consistent.

The fixture is data, not executable code. Its versioned DSL can describe:

- bounded buffers, textures and samplers;
- exact initial binary resources and digests;
- bind-group resource references;
- bounded dispatch, draw and copy commands;
- exact readback ranges and expected digests;
- `buffer-record` probes for reflected model-facing binding records; and
- `vertex-input` probes for reflected model ABI vertex semantics.

The trusted harness interprets this closed command set. Unknown resource kinds,
commands, usage flags, formats, paths or fields fail validation.

For every model-facing record binding used by a compile unit, a
`buffer-record` probe must prove that `createGpuRecordCodec` produces the exact
uploaded byte slice and that GPU output decodes through the reflected output
record to the expected value. For every model ABI vertex semantic used by the
unit, a `vertex-input` probe must prove the exact `GPUVertexFormat`, attribute
offset, buffer stride/slot/step mode, draw element and shader location, then
decode the GPU-observed value through a reflected output record. A raw readback
digest cannot stand in for these structured proofs.

Texture declarations are exact rather than advisory. Dimension, extent,
format, usages, mip count and sample count constrain all views, render/depth
attachments and copies. Initial bytes additionally fix mip, origin, aspect,
`bytesPerRow`, `rowsPerImage`, and exact byte length. All buffer ranges,
texture-copy extents, views, readbacks, commands, bytes, texels and time remain
within the fixture bounds.

### Candidate archive

The archive is an immutable, version-pinned Azure Blob whose digest is supplied
with the request. It may contain only normalized regular files/directories and
only `.json`, `.wgsl`, and bounded `.bin` data. The preparation job rejects:

- absolute, parent-relative, duplicate or non-normalized paths;
- scripts, executable bits, native libraries, archives within archives,
  symlinks, hard links, devices, sockets and browser extensions;
- unbounded file counts, individual resources or total extracted size;
- missing or extra manifest references; and
- bytes whose SHA-256 does not match their declarative reference.

Executable callbacks may exist only in explicitly non-qualifying local/hosted
developer test APIs. Their output cannot be transformed into physical support
evidence or admitted into the stable catalog.

### Trusted harness identity

Every runner checks out the harness from the workflow commit, builds it from the
repository lockfile, and invokes its fixed CLI. Candidate contents cannot
replace the CLI, package manifest, dependencies or browser launch policy.

Evidence records a harness ID, version and SHA-256 plus package, reflector and
workflow provenance. A harness or toolchain change invalidates prior evidence
for promotion and triggers complete inventory requalification.

The harness fingerprint covers the exact tracked source and rebuilt `dist/`
files under a domain-separated SHA-256 identity. Each cell and the aggregator
rebuild and verify that same fingerprint. The package version recorded by
reflection/tooling comes from the checked-out release-owned package metadata;
candidate callers cannot provide a substitute package version.

Requirements are independently derived from the exact module set, reflected
interface and pipeline descriptors. Supported WGSL `enable` directives map to
stable WebGPU feature names; malformed or unmapped enables fail. Pipeline
formats, unclipped depth, structural bind-group/vertex/attachment limits and
resolved compute workgroup dimensions, invocation counts and statically used
storage bytes are regenerated. Workgroup storage is calculated per entry point
from its transitive call graph using WebGPU's
`sum(roundUp(16, SizeOf(T)))` rule and is enforced through
`maxComputeWorkgroupStorageSize`. Admission and runtime repeat the derivation
after exact module digest verification, so a caller cannot lower requirements
with a sidecar or partial module set. Override-sized workgroup arrays fail
closed while the pinned reflector cannot preserve their symbolic element count.

### Stable matrix

The baseline matrix contains 16 blocking cells:

- one deterministic Chromium/SwiftShader Ubuntu smoke cell; and
- 15 representative physical cells spanning Windows/D3D12, macOS/Metal,
  Ubuntu/Vulkan, ChromeOS/Vulkan, Android/Vulkan, iPhone/iPad/Metal and
  visionOS/Metal.

SwiftShader must pass but does not count toward the physical stable-support
claim. Every physical cell has `countsTowardStableCoverage: true`. The matrix
policy requires 15 physical and 16 total blocking cells.

Each physical job runs only on a required self-hosted label class that includes
`shader-validation`, `physical-gpu`, the OS/architecture, adapter family or
device class, and backend. Device-controlled lanes also require
`device-controller`. There is no hosted fallback.

Before dispatch, preflight queries the runner inventory and requires at least
one online runner whose actual GitHub API label list contains every required
matrix label for the cell. Evidence keeps the runner's actual name and complete
label list; it does not replace those values with requested labels. Additional
actual labels are allowed, while the matrix label set remains a required
subset. Multiple interchangeable runners for the same calibrated cell are
allowed, and a busy eligible runner may queue within the workflow's bounded
timeout. Absence of an online eligible runner, or inability to inspect the
inventory, fails qualification.

Runner inventory cannot normally read executable adapter bytes from a physical
host, so a physical preflight may honestly contain `adapterHarness: null`.
Only a completed cell may claim an automation adapter identity, and that cell
must record the actual driver, version and SHA-256 verified during execution.
The hosted SwiftShader route fingerprints its locally observable Playwright
adapter during hosted preflight. The selected execution job rechecks actual
host identity, runner labels and adapter registration before invoking the
harness.

### Preload-only physical automation adapters

Physical browser/device implementations are installed by fleet operators as
one reviewed, self-contained `.mjs` bundle. The runner service fixes
`PLASIUS_TRUSTED_FLEET_ADAPTER_URL` to its absolute `file:` URL and
`PLASIUS_TRUSTED_FLEET_ADAPTER_SHA256` to the domain-separated digest of that
exact file. The trusted workflow preloads a fixed bootstrap, not that path
directly. The bootstrap resolves the real path beneath the fixed OS root,
rejects links and transitive code-loading syntax, verifies the exact digest,
and imports an in-memory snapshot of the verified bytes. Neither candidate data
nor workflow-dispatch input can select executable code.

The bundle must live under the platform's runner-owned root:

- Linux: `/opt/plasius/webgpu-fleet`;
- macOS: `/Library/Application Support/Plasius/WebGPUFleet`; or
- Windows: `C:\ProgramData\Plasius\WebGPUFleet`.

Registration binds the module URL and digest to the automation driver/version,
runner name, allowed matrix cell IDs, and exact qualification-harness digest.
The file must be self-contained with no transitive imports or runtime code
loading. Execution rejects a missing preload, path escape, changed file
identity, wrong runner/cell/harness binding, or adapter whose runtime identity
differs from its registration.

Candidate, preflight, and evidence artifacts are isolated under a unique
`RUNNER_TEMP` directory for the workflow run, attempt, and matrix cell. The
workflow clears stale state before execution and removes the directory on every
outcome so a persistent physical host cannot reuse a prior candidate or result.
Transport artifact names also contain the run attempt. Each cell creates a
typed non-qualifying fallback before checkout/setup, writes final JSON through
an exclusive atomic publication step, and retains exactly one parseable cell
evidence document or typed diagnostic before upload.

### Required phases

Each compile-unit/cell result records all required phases:

1. assembly;
2. reflection/schema equality;
3. shader compilation and `getCompilationInfo()` messages;
4. explicit pipeline layout creation;
5. explicit pipeline creation;
6. bind-group creation;
7. CPU-to-GPU layout probes covering every model-facing record binding and
   every model ABI vertex semantic used by the unit;
8. GPU-to-CPU reflected-record decoding for every structured probe;
9. one bounded dispatch or draw; and
10. semantic readback with expected and actual digests.

The observed environment records runner ID/labels; browser name, stable channel
and exact version; OS/version/architecture; physical adapter vendor,
architecture, device, backend and driver; WebGPU features; and limits.

`skipped`, `timeout`, `device-lost`, `runner-unavailable`,
`adapter-unavailable`, or any failed/missing phase is a failed result.

The environment is observed rather than inferred from the request. Matrix OS
and browser version constraints are requirements; evidence records the actual
OS/build, browser version, adapter/device/backend/driver, features and limits.
A physical adapter/controller must not copy requested target facts into its
observations. If it cannot independently observe and prove them, the cell
fails.

### Aggregation

The aggregator receives trusted subject, inventory, matrix, harness identity,
workflow provenance and per-cell result files. It computes the required
Cartesian product of compile-unit IDs and matrix cell IDs and requires exactly
one result for each pair.

Aggregation rejects:

- missing, duplicate or unexpected unit/cell pairs;
- results for a different module, interface, model ABI, shader ABI, inventory,
  matrix, fixture, bundle or harness digest;
- non-passing status or missing required phases;
- an observed browser, OS, adapter, backend, runner label, feature or limit that
  contradicts the requested cell;
- timestamps outside the qualification attempt or evidence past the admission
  freshness policy; and
- result or aggregate JSON whose parsed value differs from its supplied bytes,
  or whose strict contract contains unknown fields. Canonical JSON is used for
  identities and structural hashes; the separately attested artifact bytes may
  use the workflow's deterministic pretty-printed representation.

The aggregate includes counts for compile units, cells, expected pairs and
passed pairs. `status: passed` is legal only when expected equals passed and all
other invariants hold. Admission independently parses and validates the
aggregate; storage does not trust a caller-provided `passed` boolean.

The artifact sequence is exact and one-directional:

1. prepare emits the validated data-only candidate plus
   `qualification-preflight.json`, bound to the immutable source Blob version,
   candidate/inventory/matrix/harness digests, subject and workflow provenance;
2. runner selection emits one runner-preflight JSON per cell containing actual
   runner API names/labels, while hosted SwiftShader also includes its
   independently observed adapter-harness identity;
3. each actual cell job emits either digest-bound cell evidence or a
   non-qualifying failure/timeout diagnostic with that job's producer;
4. aggregation consumes the same candidate, exact raw matrix,
   qualification-preflight, all runner preflights and all cell outputs, then
   retains `stable-webgpu-matrix.json` and `qualification-evidence.json`; and
5. successful evidence receives a GitHub build-provenance bundle plus
   `qualification-evidence.attestation-ref.json`, whose strict contract binds
   evidence and bundle names/digests to the caller run/attempt, the trusted
   workflow's protected-main ref, and the exact observed workflow SHA. A raw
   commit-SHA workflow ref is not accepted as an independent trust root.

The GitHub artifacts' retention period is not an immutable storage guarantee.
Before admission completes, model storage must copy the exact candidate,
matrix, aggregate evidence, attestation reference and attestation bundle into
immutable storage and verify their bytes and SHA-256 digests. The final shader
manifest references the stored evidence and stored attestation-ref URI/digest;
profile admission happens afterward against those evidence-bound exact shader
versions.

### Provenance and credential boundaries

The preparation job uses GitHub OIDC and least-privilege read access to fetch
one immutable candidate Blob version. Candidate bytes never receive Azure,
GitHub, npm or runner-management credentials. Physical jobs consume a verified
GitHub artifact produced by preparation and do not reauthenticate to candidate
storage.

Evidence distinguishes the caller repository from the pinned trusted reusable
workflow. Preparation provenance captures repository, commit SHA, ref,
workflow identity, run ID, attempt, event and verified OIDC subject. Each cell
requires the reusable workflow identity to be
`Plasius-LTD/gpu-shader/.github/workflows/shader-qualification.yml@refs/heads/main`;
the separately recorded workflow SHA is evidence of the resolved revision, not
authority to run an unreviewed revision. Each cell
also records the producing job and runner identity. The final aggregate and
candidate identity are bound by the aggregate subject, and the exact aggregate
evidence receives the retained GitHub build-provenance bundle and strict
attestation reference. Promotion authorization remains in the asset storage
service; a successful workflow artifact does not itself move a catalog
pointer.

Shader qualification deliberately omits a style-profile manifest. Evidence is
bound to the shader manifest core, final interface, model compatibility
fixtures, modules, compile units, matrix and harness. After the evidence-bound
final shader manifest exists, profile admission separately verifies its exact
`ShaderVersionRef` values and each referenced shader's evidence. This
two-stage admission avoids a profile/evidence/shader-manifest digest cycle
without weakening exact-version profile validation.

Universal and supplemental evidence references retain the exact matrix ID,
version, and raw-policy SHA-256. Supported universal policy identities are
versioned with the framework. Each profile supplemental requirement pins the
same tuple, and every referenced shader must supply matching evidence. A
supplemental scope cannot reuse the universal matrix digest, evidence ID, URI,
artifact digest, attestation URI, or attestation digest. Those identities must
also be unique across supplemental scopes and distinct shader versions in one
profile. URI identities use canonical URL serialization and must remain in the
promoted catalog root. This release's additive-policy registry is intentionally
empty; supplemental evidence and profile requirements fail closed until exact
reviewed policy bytes, additive lanes, validation rules, and the registered
scope/ID/version/SHA-256 tuple are released together. A label such as `xr`
cannot relabel universal coverage.

## Automation mapping

- Branded stable Chrome and Edge use pinned Playwright browser channels.
- Stable Firefox physical lanes use a trusted WebDriver/geckodriver stack.
- macOS, iPhone, iPad and visionOS Safari lanes use trusted Safari/WebDriver or
  device-farm controllers appropriate to the platform.
- Android Chrome uses ADB/CDP through a dedicated controller.
- ChromeOS lanes use a dedicated trusted device controller.

The harness must record actual versions and adapter data rather than inferring
them from labels. A platform controller that cannot expose the required WebGPU
environment and semantic readback cannot qualify that cell.

## Failure and retry behavior

A transient retry creates a new run attempt and new result identity. It does not
convert a failed or missing result in an older attempt into success. Aggregation
uses one coherent attempt; mixing result attempts is rejected.

Timeouts are finite at archive, cell and workflow levels. Device loss fails the
cell even if a retry later succeeds; a new coherent qualification attempt is
required for promotable evidence.

## Current operational state

The matrix policy and fail-closed workflow exist, but the complete physical
runner fleet has not been verified as provisioned as of 2026-07-13. Therefore:

- full physical qualification cannot currently complete;
- no shader should be promoted to the stable universal catalog using this
  matrix; and
- documentation, unit tests or SwiftShader passage must not be reported as
  universal hardware coverage.

Provisioning and calibration steps are tracked in the
[physical fleet readiness runbook](../operations/physical-fleet-readiness.md).

## Consequences

- Physical qualification is more operationally expensive than hosted smoke
  testing, but support claims are tied to real declared devices.
- The declarative DSL must evolve carefully; a fixture feature requires a
  trusted harness release and requalification.
- Runner labels are routing input, not sufficient proof; observed environment
  and semantic evidence remain mandatory.
- Missing fleet capacity blocks promotion rather than weakening the matrix.
