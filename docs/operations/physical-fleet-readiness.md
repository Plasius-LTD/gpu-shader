# Physical WebGPU fleet readiness runbook

- Status: Fleet not yet verified as provisioned
- Matrix: [`stable-webgpu-2026-07-13.json`](../../matrices/stable-webgpu-2026-07-13.json)
- Workflow: [`.github/workflows/shader-qualification.yml`](../../.github/workflows/shader-qualification.yml)

This runbook provisions and validates the representative hardware required by
the stable shader gate. Do not promote a stable shader or claim universal
coverage until every checklist item and every blocking cell has current passing
evidence.

## Required capacity

The matrix defines 15 physical cells and one hosted SwiftShader smoke cell.
Physical capacity must cover:

- Windows 11/D3D12: Chrome on Intel, Edge on NVIDIA, Firefox on AMD;
- Apple Silicon macOS/Metal: stable Chrome, Firefox and Safari;
- Ubuntu/Vulkan: stable Chrome on qualified Intel and NVIDIA adapters;
- ChromeOS/Vulkan: stable Chrome on Intel and ARM devices;
- Android/Vulkan: stable Chrome on physical Adreno and Mali devices;
- iOS/iPadOS/Metal: stable Safari on physical iPhone and iPad; and
- visionOS/Metal: Safari on a physical qualified visionOS device.

One host may serve multiple browser cells only when its adapter and environment
remain identical and capacity prevents overlapping jobs. Device-controller
hosts must have exclusive control of the attached physical device during a job.

## Repository configuration

Configure these GitHub Actions secrets without putting values in the repository:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `RUNNER_SELECTOR_TOKEN`
- `RELEASE_PREP_APP_PRIVATE_KEY`

Configure `RELEASE_PREP_APP_CLIENT_ID` as a repository variable. The installed
GitHub App needs only repository contents and pull-request write access. It must
be allowed to create release and maintenance pull requests, but must not be a
branch-protection or ruleset bypass actor. Store its private key as a repository
or organization Actions secret because both release preparation and the monthly
maintenance workflow use it.

Protect `main` with a branch protection rule or active ruleset that requires
pull requests and the exact repository CI check, enforces the rule for
administrators, and has no bypass actor. Enable repository auto-merge. Protect
the `production` environment with required review, no administrator bypass,
and deployment restricted to protected `main`. Release preparation checks that
`main` is protected and auto-merge is enabled before it mutates package or
changelog metadata.

### Temporary solo-operator governance exception

The only currently visible organization member is `zephod111r`. Requiring an
independent approval or prohibiting that operator from approving the production
deployment would therefore deadlock the protected delivery path. Until a
second qualified maintainer is visible, the explicit temporary exception is:

- keep required pull-request approvals at zero while still requiring a pull
  request and the exact protected CI check; and
- retain `zephod111r` as the required production-environment reviewer while
  allowing self-review.

This exception does not permit an administrative or GitHub App bypass. Keep
branch-protection enforcement for administrators, exact-commit CI, protected
branch-only deployment, the production-environment review gate, disabled
environment administrator bypass, and force-push/deletion protection in place.
When a second qualified maintainer becomes visible, require at least one
independent pull-request approval, add an independent production reviewer, and
prohibit deployment self-review. Review the membership condition whenever
repository governance is audited.

Codecov uses GitHub OIDC and requires no `CODECOV_TOKEN`. `NPM_TOKEN` is a
temporary production-environment secret only for the initial public package
version. After that version exists, configure npm trusted publishing with:

- organization/user: `Plasius-LTD`;
- repository: `gpu-shader`;
- workflow filename: `cd.yml`; and
- GitHub environment: `production`.

Then remove `NPM_TOKEN`; subsequent publication uses short-lived npm OIDC.
For an interrupted initial release, keep the token only until the exact version
has been verified and the GitHub release is no longer a draft.

The runner-selector credential needs only the runner inventory permissions
required by preflight. Azure OIDC needs read-only access to the immutable
candidate Blob version. Physical runner jobs do not receive Azure, npm,
release-app or runner-management credentials. The release GitHub App token is
generated per job and is never stored as a long-lived token.

### Release privilege boundary and two-run preparation

The workflow-dispatch event SHA is immutable for the life of a run. CD requires
that SHA to equal the prepared commit before it builds a release artifact. A
run that creates and merges a package or changelog metadata commit therefore
stops before publication: its event still identifies the earlier `main` commit.
After exact push CI has completed for the prepared commit, dispatch `cd.yml`
again from that new `main` with `bump: none`. Do not use `bump: none` to skip
version preparation; it may only resume the exact version already present on
`main`.

The second run has two deliberately separated stages:

1. `validate-and-pack` has read-only Actions and contents permissions and no
   production environment, write token, npm credential, attestation permission,
   or OIDC permission. It verifies the dispatch/prepared commit identity, waits
   for successful push CI on that exact commit, executes repository validation,
   and packs once. Its attempt-scoped transport artifact contains exactly the
   npm tarball, CycloneDX SBOM, and `release-transport.json`; the transport
   manifest binds the repository, commit, package/version, publication state,
   file sizes, and cryptographic digests.
2. `publish` enters the protected `production` environment and receives only
   the permissions needed to attest and publish. It does not check out the
   repository, install its dependency graph, run lifecycle scripts, or execute
   repository-authored code. It downloads the exact current-run artifact by
   ID, name, and GitHub digest; independently verifies the three-file closure,
   manifest schema, package identity, SBOM identity, sizes, and digests; and
   then resolves live npm state and preflights the full GitHub tag, release, and
   exact one-SBOM asset closure before any mutation. It derives prerelease and
   dist-tag state from the transported version, not the retry input. Only then
   does it attest, reconcile the tag and draft release, publish the exact
   tarball with scripts disabled and provenance enabled, verify registry
   integrity/provenance/signatures, and publish the GitHub release. Unexpected
   assets are removed from drafts and cause published-release recovery to fail
   closed.

An interrupted release is resumed with a new `bump: none` dispatch from the
same prepared `main` commit. Every recovery still repeats the exact-commit CI,
artifact-integrity, provenance, signature, tag, and release checks.
The npm install and signature endpoint may briefly lag the metadata and
attestation endpoints after first publication. CD retries that final
install/signature check for a bounded three minutes, without skipping or
weakening it; if propagation does not converge, the draft remains unpublished
and another `bump: none` run safely resumes the same immutable version.

## Runner labels and attestation

Ensure each runner's actual GitHub API label list contains every label declared
by each matrix cell it serves. Physical runners include `self-hosted`, OS and
architecture, `shader-validation`, `physical-gpu`, an adapter/device-class
label and backend. Device lanes also include `device-controller`. Additional
actual labels are permitted, but preflight evidence retains the complete API
label list and the matrix labels must remain a required subset. Never synthesize
the evidence label list from the requested cell.

Set trusted host environment values through the runner service configuration:

- `PLASIUS_SHADER_CELL_IDS`: comma-separated cells the host is calibrated for;
- `PLASIUS_SHADER_PHYSICAL_GPU=true`;
- `PLASIUS_SHADER_GPU_VENDOR`: exact matrix vendor token;
- `PLASIUS_SHADER_GPU_BACKEND`: `d3d12`, `metal`, or `vulkan`;
- `PLASIUS_SHADER_AUTOMATION_KIND`: exact matrix automation kind;
- `PLASIUS_TRUSTED_FLEET_ADAPTER_URL`: absolute `file:` URL of the
  runner-owned self-contained `.mjs` preload; and
- `PLASIUS_TRUSTED_FLEET_ADAPTER_SHA256`: domain-separated SHA-256 identity of
  that exact preload bundle.

These values are a preflight assertion, not final proof. The harness still
records the actual browser, OS, adapter, driver, features and limits and rejects
a mismatch. GitHub runner inventory cannot inspect local adapter bytes, so
physical runner-preflight evidence normally records `adapterHarness: null`.
That is an honest inventory limitation, not permission to omit executable-code
verification from the physical cell.

## Trusted physical adapter installation

Install one reviewed, self-contained `.mjs` adapter bundle under the fixed
runner-owned root for the host OS:

- Linux: `/opt/plasius/webgpu-fleet`;
- macOS: `/Library/Application Support/Plasius/WebGPUFleet`; or
- Windows: `C:\ProgramData\Plasius\WebGPUFleet`.

The module URL must resolve beneath that root and end in `.mjs`. The bundle may
not use transitive imports, `require`, dynamic code evaluation, or other runtime
code loading. Build it as one file so the recorded identity covers the complete
automation code closure.

The preload registers its module URL and adapter driver/version/SHA with the
trusted global registration symbol, and binds itself to the exact runner name,
allowed cell IDs, and qualification-harness SHA-256. Compute
`PLASIUS_TRUSTED_FLEET_ADAPTER_SHA256` as SHA-256 of the UTF-8 string
`plasius.trusted-fleet-adapter-single-file/v1\n<raw-file-sha256>`, where the
placeholder is the lowercase 64-character SHA-256 of the exact `.mjs` bytes.
Do not use the raw file digest alone. Fix both URL and digest in the runner
service configuration with permissions that candidate jobs cannot modify.

For a physical cell, the trusted workflow invokes its checked-in bootstrap with
Node `--import`. That bootstrap resolves the configured adapter's real path,
requires a regular non-symlinked file beneath the fixed OS root, checks the
self-contained-code policy, verifies the domain-separated digest, and imports
an in-memory data-URL snapshot of the already-verified bytes. It never imports
the runner path directly. Runtime registration then re-verifies the file,
runner/cell/harness bindings, and requires the created adapter to report the
same driver, version and digest. Candidate archives and workflow-dispatch
inputs must never supply the preload URL, registration or factory.

Each physical job stores its downloaded candidate, preflights, and evidence in
a run/attempt/cell-specific directory below `RUNNER_TEMP`. The job removes any
stale directory before use and deletes the directory on every outcome. The
checked-out harness remains candidate-independent and is verified against the
prepare job's exact commit and content fingerprint.

## Host hardening

- Use dedicated runner/service accounts with no interactive user data.
- Keep the runner service's adapter URL, digest, and adapter root read-only to
  the job account; jobs must not be able to rewrite runner calibration.
- Install only the pinned runner, browser, driver and device-controller stack.
- Disable unneeded inbound services and restrict outbound access to GitHub
  Actions/artifacts plus required device/browser endpoints.
- Keep long-lived cloud/npm/release credentials off runner hosts.
- Use ephemeral job workspaces and remove artifacts after upload.
- Prevent candidate-controlled environment variables, launch flags, browser
  extensions, profiles and executable search paths.
- Make the fixed adapter root and runner-service environment writable only by
  fleet administrators, not the runner job account.
- Mount or copy candidate data without execute permission.
- Enable OS disk encryption, security updates, audit logs and monitored runner
  service health.
- Quarantine a runner immediately after unexplained adapter, driver, browser,
  device-loss or attestation drift.

## Browser and device setup

- Chrome/Edge: install the stable branded channel required by the cell and the
  trusted Playwright integration.
- Firefox: pin stable Firefox plus the trusted compatible geckodriver/Selenium
  stack; do not substitute Playwright's patched Firefox build.
- macOS Safari: enable `safaridriver` under the dedicated account and record the
  OS/Safari build.
- Android: enroll the physical device, lock ADB authorization to the controller,
  install stable Chrome and prevent emulator fallback.
- ChromeOS: use a managed physical device controller that can report browser,
  Vulkan adapter and semantic readback evidence.
- iPhone/iPad/visionOS: enroll physical devices in the trusted Safari automation
  controller; simulator output cannot satisfy a physical cell.

If the controller cannot prove physical device identity, actual adapter/backend
and required WebGPU behavior, keep that cell unavailable and therefore failing.

## Calibration

For each cell:

1. confirm at least one runner is online whose actual labels contain the full
   calibrated matrix label set and that it is not shared with unrelated
   workloads;
2. run a signed calibration bundle with known module, layout and semantic
   outputs;
3. verify the runner API preflight retains the actual runner name and complete
   label list, with every matrix label present;
4. verify the harness records independently observed OS/browser/adapter/backend,
   driver, features and limits rather than copying the requested cell;
5. verify cell evidence records the installed automation driver/version and
   exact adapter preload SHA-256 while physical inventory leaves an
   unobservable adapter identity null;
6. deliberately mismatch the URL, adapter digest, runner name, cell binding,
   harness digest and one host attestation, and confirm each fails;
7. deliberately trigger a compilation error, layout mismatch, timeout and
   semantic mismatch and confirm each fails closed;
8. verify no candidate script or executable file is accepted;
9. verify the result artifact contains all ten required phases, including
   structured probes for every model-facing buffer record and vertex semantic;
   and
10. record the calibration run, date and owner in the tracked fleet Task.

Repeat calibration after browser, OS, driver, firmware, controller, harness or
matrix updates.

## Evidence handoff audit

For a qualifying attempt, confirm the workflow retains and cross-binds all of
these exact artifacts:

1. the data-only candidate from the immutable source Blob version;
2. `qualification-preflight.json`, including candidate, inventory, raw matrix,
   harness and subject-binding SHA-256 values plus exact workflow/OIDC
   provenance;
3. one runner-preflight JSON per matrix cell, containing the actual runner API
   name and complete labels (and hosted adapter identity where independently
   observable);
4. one cell-evidence JSON from each successful actual cell job, or a
   non-qualifying failure/timeout diagnostic from that same producer;
5. the exact raw matrix retained as `stable-webgpu-matrix.json`;
6. the strictly revalidated Cartesian aggregate as
   `qualification-evidence.json`; and
7. the external GitHub build-provenance bundle plus
   `qualification-evidence.attestation-ref.json`, which binds the evidence and
   bundle digests to the caller run/attempt and pinned trusted workflow.

GitHub artifact retention is transport only. The model-storage admission path
must copy the exact candidate, matrix, aggregate evidence, attestation
reference and attestation bundle to immutable Blob versions, read them back,
and verify every digest. A shader manifest may reference only those durable
evidence and attestation-reference URIs/digests. Style-profile admission is a
second stage and may start only after every referenced exact shader version is
evidence-bound and admitted.

## Feature-flag readiness

Keep `asset.pipeline.shader-store.enabled` disabled while provisioning and
calibrating the fleet. Separately authorized operator flows must still be able
to submit private intake, run qualification, write immutable versions, move a
private/promoted catalog pointer, and rehearse rollback while the public/runtime
flag is off.

Before rollout, verify all of these behaviors explicitly:

- a public candidate submission is rejected while the flag is off;
- runtime catalog discovery, shader/profile loading and activation are rejected
  while the flag is off;
- direct Blob URLs, checked-in catalogs and unmanaged shaders remain rejected;
- the separately authorized private qualification/promotion path still works;
- catalog rollback can be rehearsed without public or runtime exposure; and
- the only migration fallback, if one is required, is a separately governed
  bounded pre-store default with an owner and removal date.

Do not treat the flag as storage authorization. Private operations use their
own identities and permissions, and all manifest, digest, evidence and
compatibility gates remain mandatory regardless of flag state.

## Readiness audit

Before enabling stable admission:

- [ ] all 15 physical cells have at least one eligible runner/device path;
- [ ] actual runner API names/labels are retained, and every matrix label is a
      subset of the selected runner's complete actual label list;
- [ ] all trusted host assertions match the matrix;
- [ ] each physical adapter preload is inside its fixed OS root, self-contained,
      digest-bound and registered for the exact runner/cells/harness;
- [ ] browser/device channels are stable and default-enabled WebGPU is used;
- [ ] no cell relies on nightly, preview, hidden flags, emulator or software GPU;
- [ ] OIDC candidate read access and credential separation are verified;
- [ ] public/runtime flag-off behavior fails closed while authorized private
      qualification and rollback rehearsal remain functional;
- [ ] no checked-in, arbitrary-URL or unmanaged fallback is reachable;
- [ ] malicious archive and stale/duplicate evidence tests pass;
- [ ] buffer-record and vertex-input probes cover every model-facing byte
      interface in every compile unit;
- [ ] one full compile-unit-by-cell attempt passes with exact aggregate counts;
- [ ] the exact matrix, evidence, attestation ref and attestation bundle are
      copied to immutable model storage and digest verified;
- [ ] admission independently accepts that exact evidence;
- [ ] a failed cell prevents promotion; and
- [ ] rollback to an older immutable catalog version is tested.

## Failure handling

Absence of an online eligible runner, inability to inspect the inventory, wrong
labels, missing or changed preload, wrong runner/cell/harness binding, wrong
adapter, unverifiable actual environment, browser drift, unsupported WebGPU,
timeout, skip or device loss fails the attempt. Do not remove the cell, mark it
non-blocking, use a hosted fallback or reuse evidence from another attempt to
make a release pass.

Open or update the tracked physical-fleet Task, quarantine the lane, repair and
recalibrate it, then run a new coherent qualification attempt.

## Current blocker

No complete physical runner inventory has been verified for this repository as
of 2026-07-13. The workflow is intentionally expected to fail its physical
preflight until the fleet is provisioned. This is correct fail-closed behavior,
not a reason to weaken the support matrix.
