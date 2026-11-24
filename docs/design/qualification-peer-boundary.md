# Qualification automation dependency boundary

24 November 2026. Task gpu-shader #49. Parent: site Story #2416, Feature #2384,
Epic #2382.

The arcade's published GPU dependencies reach gpu-shader through asset contracts.
Its optional dependency on playwright-core is installed for ordinary runtime
consumers even though only the trusted qualification runner uses it. The locked
Playwright distribution embeds Picomatch; an external matcher override cannot
replace that bundled implementation. Keep browser automation out of runtime
consumer installations by expressing the existing exact pin as an optional peer.

Reuse the existing Playwright qualification adapters. Do not replace them, omit
their tests or claim that their own development dependency has been removed.
Keep the identical exact version as a development dependency so repository CI and
qualification workflows continue to install it normally. Operators using the
published qualification subpath explicitly install that exact peer and its browser.
Preserve root/node/testing exports, actual adapters, hardware gates and CD.

The release-owned harness metadata reads the exact peer pin and requires the
optional-peer marker. Before hashing an installed adapter, compare its actual
package identity/version to that pin; reject missing, malformed or mismatched
installations. Retain full code/browser-tree hashing and all existing integrity
checks. A peer declaration is not evidence that a particular installed adapter
has the expected bytes. The changed harness requires fresh qualification evidence;
no old hardware evidence is promoted by this dependency change.

Requirements and tests precede implementation:

- The manifest has no runtime/optional Playwright dependency; exact development
  and optional-peer pins agree. All existing runtime dependencies stay unchanged.
- Trusted metadata rejects malformed package identity/version, missing/invalid
  peer containers, non-exact pins and absent/false optional-peer metadata.
- Actual adapter identity/version mismatch and malformed JSON fail before browser
  work. The real pinned installation still produces deterministic tree hashes.
- A clean packed runtime consumer using normal npm peer/optional behavior does
  not install playwright-core. Root/node/testing module loading and existing
  public package inventory checks pass; using the automation adapter without the
  explicit peer fails clearly. A separately provisioned runner retains its tests.
- Every changed source is represented in LCOV at >=80%, with full required
  coverage, types, lint, build, artifact/privacy checks and exact pushed CI.

Update README, Unreleased and an ADR. Release only through approved main cd.yml
and production; arcade adoption waits for that verified registry release. This
fix changes no product access and inherits the stored arcade.runtime.enabled
control for its parent Feature. The dependency integrity checks are unconditional.

## Local verification

The new requirements first failed on the optional dependency, peer metadata and
missing installed-version check. After implementation, all 568 tests pass.
Full LCOV is 93.91% lines, 88.75% statements, 91.31% functions and 81.05% branches.
Both changed sources are represented: metadata is fully covered; adapter integrity
has 100% lines/functions and 80.95% branches. Types, lint, production build, matrix
policy validation, all 30 packed paths, source privacy and full audit pass.

A clean packed consumer installed with normal npm defaults (no peer/optional omit
switches) contains no playwright-core and imports matching ESM/CJS exports for
the root, node and testing entries. The repository still clean-installs and tests
the real exact Playwright development dependency. These are package/runner-boundary
checks; they do not exercise a physical GPU or qualify game content.
