# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Release sections are created and promoted by the approved release workflow; do
not manually create a versioned release section.

## [Unreleased]

- **Added**
  - (placeholder)

- **Changed**
  - Bound npm publication to the exact prepared `main` commit after successful push-triggered CI.
  - (placeholder)

- **Fixed**
  - Added exact-commit CI dispatch and disabled package-manager cache finalization in both hosted Node.js jobs.
  - (placeholder)

- **Security**
  - Removed the npm write-token path, added a fail-closed npm 11.5.1-or-newer OIDC guard, and denied fork PR code access to reviewed CI.
  - Pinned patched transitive npm dependencies to clear the current audit baseline.
  - Moved reviewed CI to explicit GitHub-hosted runners and pinned the npm OIDC release client to 11.6.2.
  - Added fail-closed source and npm-package admission for the administrative contributor registry and pinned the CI/CD runtime to Node.js 24.18.0 LTS.
  - (placeholder)

## [0.1.3] - 2026-07-15

- **Added**
  - (placeholder)

- **Changed**
  - Canonical JSON and ABI hashing now operate on bounded descriptor-only
    snapshots. Runtime/model contracts and full qualification products use
    separate named finite policies; changing those policies requires affected
    shader requalification.

- **Fixed**
  - Strict model, interface, shader, profile, compatibility, matrix, inventory,
    qualification, evidence, and runtime-reference parsers now reject
    accessor-backed, sparse, behavioral, cyclic, deep, and oversized values
    before schema field access.
  - UTF-8 byte parsing and catalog asset copying now use TypedArray intrinsics
    without caller property/species reads, while retaining Buffer, subclass,
    and cross-realm Uint8Array compatibility. Runtime request envelopes and
    attestation verifiers also sanitize accessor/provider failures.
  - The build graph now resolves `esbuild` 0.28.1 or later, removing the
    Windows development-server arbitrary-file-read advisory from the audited
    dependency closure.

- **Security**
  - Caller property getters and Proxy `get` traps are no longer invoked while
    detaching GPU contracts. Unavoidable Proxy reflection failures are replaced
    with constant bounded diagnostics without retaining raw causes or provider
    messages.

## [0.1.2] - 2026-07-15

- **Added**
  - A browser-safe `assertImmutableAssetVersion` contract shared by direct
    runtime loaders and strict GPU manifest parsers.

- **Changed**
  - (placeholder)

- **Fixed**
  - Model, GPU-interface, shader, and style-profile manifests and references
    now reject mutable aliases, ranges, wildcards, URLs, and path syntax before
    catalog access.
  - Strict manifest, compile-unit, and qualification parsers now validate and
    return detached frozen JSON snapshots, preventing accessor/prototype
    mutation between validation and use.

- **Security**
  - Browser runtime loading fails closed before invoking a promoted-catalog
    resolver when a top-level or nested asset reference does not carry an
    exact immutable version.
  - Compatibility diagnostics now fail closed on hostile capability access and
    cap untrusted diagnostic text at 512 Unicode code points.

## [0.1.1] - 2026-07-13

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - Canonicalized the shipped stable-WebGPU matrix and corrected its supported
    policy digest so the exact artifact accepted by qualification is also
    admissible at canonical JSON boundaries. The policy-identity change
    requires complete shader-inventory requalification and does not itself
    claim any shader passed the physical matrix.
  - Post-publication npm install and signature verification retry for a bounded
    interval so registry-edge propagation cannot strand an otherwise verified
    immutable release; every retry still requires signatures to pass.
  - Interrupted published-version recovery now separates the current
    protected-main validation commit from the immutable npm-provenance release
    commit, rebuilding the original source and preserving its tag identity.
  - Draft release recovery now discovers authenticated draft and published
    releases through the complete release listing instead of the published-only
    tag lookup, preventing duplicate-release creation attempts.

- **Security**
  - Release transport schema v2 binds both validation and release commits,
    rejects split authorities for unpublished versions, cross-checks published
    provenance against the existing tag and protected-main ancestry, and skips
    misleading replacement attestations during recovery. The Node/npm release
    toolchain is fixed, and CycloneDX UUID and timestamp fields are normalized
    from immutable release inputs so completed release recovery reproduces the
    exact SBOM bytes.

## [0.1.0] - 2026-07-13

### Added

- Initial browser-safe contracts for reflected GPU interfaces, immutable shader
  versions, exact-version style profiles, model compatibility, and typed
  diagnostics.
- Strict final-WGSL reflection, deterministic ABI hashes, generated TypeScript
  artifacts, and CPU record codecs through the Node-only build subpath.
- Promoted-catalog loading, digest verification, device compatibility checks,
  asynchronous pipeline preparation, and atomic frame-boundary style switching.
- Compile-unit inventory, a versioned stable-WebGPU matrix, declarative bounded
  qualification fixtures, per-cell evidence, and fail-closed aggregation
  contracts.
- Mandatory universal evidence plus scoped additive qualification evidence and
  independent evidence/attestation identity for every supplemental scope, and
  exact matrix-policy-pinned profile requirements for targets such as XR. The
  initial additive-policy registry is empty and fails closed until reviewed
  supplemental lanes and exact policy bytes ship in a later framework release.
- Mandatory reflected `buffer-record` and `vertex-input` qualification probes,
  with strict texture upload/view/copy layouts and bounded resource execution.
- Requirement derivation from exact WGSL enables, reflected model semantics,
  per-stage resources and binding sizes, inter-stage variables/components, compute
  workgroup dimensions/invocations/statically used storage bytes, and structural
  pipeline features/formats/limits at admission and runtime.
- Exact candidate/preflight/runner/cell/matrix/aggregate evidence flow with
  external build-provenance references for immutable model-storage admission.
- Preload-only, fixed-root, digest-bound physical fleet adapter registration
  that records actual runner labels and execution automation identity.
- Repository governance, architecture and technical decision records, testing
  policy, legal files, public-package verification, and protected CI/CD release
  workflows.

### Changed

- Reflection provenance now obtains the package version from release-owned
  package metadata rather than caller input.
- Shader evidence is admitted before exact-version style profiles, avoiding a
  profile/evidence/shader digest cycle while preserving profile validation.
- Release metadata now lands only through a protected, auto-merged pull request.
  A metadata-changing run stops before publication because its workflow-dispatch
  SHA no longer equals the prepared commit; a second `bump: none` run from the
  new `main` performs exact-commit validation and publication.
- Release validation and packing now run without write, production-environment,
  npm, attestation, or OIDC privileges and emit one exact digest-bound transport
  artifact for the separately authorized publisher.
- Repository operations document the temporary solo-operator exception: zero
  required pull-request approvals and permitted production self-review only
  while `zephod111r` is the sole visible qualified maintainer, without weakening
  admin enforcement, exact CI, environment review, or no-bypass controls.
- Monthly dependency repair now reinstalls and validates the repaired graph and
  opens its pull request with the release-preparation GitHub App.

### Fixed

- Runtime-array buffer bindings now use the WebGPU one-element minimum instead
  of the fixed codec prefix.
- Model-facing buffer roots without named WGSL records are rejected, preventing
  scalar/array element-type collisions in `modelAbiHash`.
- Qualification reruns use attempt-scoped artifacts and atomically select one
  typed cell outcome, including setup-failure diagnostics.
- Qualification-bundle admission now independently re-reflects exact final
  WGSL and regenerates model, interface, and shader ABI hashes before accepting
  caller manifests, including otherwise self-consistent rehashed claims.

### Security

- Qualification archives are data-only and physical runners execute only the
  pinned trusted harness; candidate code is not executable on runner machines.
- Physical automation code must be a runner-owned, self-contained adapter
  preload bound to its fixed OS root, exact SHA-256, runner, cells, and harness.
- npm delivery now packs one bounded immutable tarball into an exact
  digest-bound tarball/SBOM/transport-manifest closure. The privileged publisher
  runs no checked-out package code, independently verifies that closure, binds
  duplicate-release recovery to authoritative live registry state, preflights
  the complete tag/release/one-SBOM asset closure before mutation, derives
  prerelease state from the transported version, verifies exact-workflow SLSA
  provenance and registry signatures, and fails closed on drift or ambiguous
  partial releases.
- Codecov uses OIDC and release/maintenance actions are pinned to reviewed
  Node-24-compatible revisions.

[Unreleased]: https://github.com/Plasius-LTD/gpu-shader/compare/v0.1.3...HEAD


[0.1.0]: https://github.com/Plasius-LTD/gpu-shader/releases/tag/v0.1.0
[0.1.1]: https://github.com/Plasius-LTD/gpu-shader/releases/tag/v0.1.1
[0.1.2]: https://github.com/Plasius-LTD/gpu-shader/releases/tag/v0.1.2
[0.1.3]: https://github.com/Plasius-LTD/gpu-shader/releases/tag/v0.1.3
