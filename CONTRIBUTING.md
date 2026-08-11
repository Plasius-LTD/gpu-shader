# Contributing to @plasius/gpu-shader

Thank you for helping make WGSL delivery safer. Contributions are welcome for
contracts, reflection, generated codecs, runtime compatibility, qualification
tooling, documentation, and test fixtures.

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Before a
first contribution, sign the appropriate [Contributor License Agreement](legal/CLA.md).
Report vulnerabilities privately through [SECURITY.md](SECURITY.md), never in a
public issue or pull request.

Signed agreements and contributor acceptance records are retained only in the
approved access-controlled system. Do not add them to source control, an npm
package, issues, pull requests, or build logs.

## Before implementation

Search existing issues first. Non-trivial work must be represented in the
Plasius GitHub Project hierarchy (`Epic -> Feature -> Story -> Task`) and follow
[WORKFLOW.md](WORKFLOW.md). Architecture changes require a new ADR in
[`docs/adrs/`](docs/adrs/index.md); do not rewrite an accepted ADR to erase
history.

The parent Feature for shader-store work uses:

- rollout flag: `asset.pipeline.shader-store.enabled`;
- style-selection capability: `gpu.shader.style.select` when user-visible style
  discovery or selection is involved.

The flag gates public candidate submission and runtime discovery/loading/
activation. It does not block separately authorized private qualification,
immutable promotion, or rollback rehearsal, and disabling it never authorizes
an unmanaged shader fallback.

## Local development

Use Node.js 24 from `.nvmrc` and npm:

```bash
npm ci
npm run lint
npm run typecheck
npm run privacy:check
npm run test:privacy
npm run build
npm run test:coverage
npm run shader:matrix
npm run pack:check
```

Do not edit `dist/`, `coverage/`, or package tarballs by hand.

## Design constraints

- Support WebGPU WGSL only.
- Treat final assembled WGSL as the source of truth for GPU record layout.
- Never add sidecar fields for caller-supplied offsets, sizes, alignment, or
  strides.
- Keep the root export browser-safe. Node reflection belongs in
  `@plasius/gpu-shader/node`; qualification tooling belongs in
  `@plasius/gpu-shader/testing`.
- Keep manifests deterministic, strict about unknown fields, and digest bound.
- Preserve the distinction between model-facing `modelAbiHash` and complete
  `shaderAbiHash`.
- Fail closed for unpromoted assets, digest mismatch, stale evidence, incomplete
  matrices, missing semantics, unsupported features, or insufficient limits.
- Keep runtime style replacement asynchronous and atomic at a frame boundary;
  a failed replacement must preserve the active/default profile.

## Tests and coverage

Derive tests from acceptance criteria before implementation. Fixes should add a
regression that fails before the fix when practical.

Framework TypeScript must maintain at least 80% LCOV line coverage. Every
changed source file must appear in combined LCOV. WGSL is the standing line
coverage exception, replaced by both of these gates:

1. every WGSL fragment belongs to at least one declared final compile unit;
2. every required cell in the versioned support matrix passes.

Compile-unit tests should cover strict schema equality, module compilation,
explicit pipeline and bind-group creation, CPU-to-GPU and GPU-to-CPU layout
probes, one bounded dispatch or draw, and semantic readback.

## Qualification fixture safety

Qualification candidates are declarative data, not test programs. Candidate
archives may contain only validated JSON, WGSL, and bounded binary resources.
Do not add candidate JavaScript, shell commands, executables, symlinks, native
libraries, browser extensions, or callbacks.

Physical runner workflows execute a fixed trusted harness from this repository.
SwiftShader is a required deterministic smoke cell but does not count as
physical coverage. Missing or mismatched physical runners, unavailable
adapters, skips, timeouts, and device loss must fail; do not introduce hosted
fallbacks for physical cells.

## Pull requests

Use a focused branch and Conventional Commit title, for example:

- `feat: reflect runtime array record layouts`
- `fix: reject stale qualification evidence`
- `test: cover vec3 storage padding`
- `docs: describe profile rollback`

Pull requests should explain the problem, solution, compatibility impact, test
evidence, and any operational follow-up. Update `README.md`, `CHANGELOG.md`
under `Unreleased`, and the applicable ADR/TDR/design document.

Before requesting review, confirm:

- [ ] the tracked Task is linked to its Story and parent Feature;
- [ ] no secrets or real PII are present;
- [ ] browser and Node export boundaries remain valid;
- [ ] tests, coverage, lint, typecheck, build, matrix validation, and package
      verification pass;
- [ ] changed source files appear in LCOV;
- [ ] WGSL fragments have compile-unit coverage when applicable;
- [ ] docs and `CHANGELOG.md` are updated;
- [ ] CI is green after push.

## Releases

Maintainers release with `.github/workflows/cd.yml` on `main` through the
protected GitHub `production` environment. Never run `npm publish` locally and
never bypass the approved workflow. A support or release claim is valid only
after its required CI, qualification, publication, and post-release checks have
actually succeeded. The release-preparation GitHub App must not bypass branch
protection: it opens a pull request, enables auto-merge, and lets required
checks and reviews control the merge. For an interrupted release, dispatch CD
with `bump: none` only when `main` already contains that exact version; recovery
still validates the packed bytes, npm provenance and signatures, tag, and
GitHub release identity. If recovery runs from newer protected `main`, it
rebuilds the immutable source commit resolved jointly by npm provenance and the
existing tag; it never rebinds published bytes to the newer workflow commit.
