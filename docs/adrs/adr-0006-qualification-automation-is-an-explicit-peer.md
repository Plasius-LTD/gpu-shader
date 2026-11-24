# ADR 0006: Qualification automation is an explicit optional peer

Status: Accepted for implementation; publication and consumer adoption pending.

## Context

Task #49 belongs to site Story #2416 / Feature #2384 / Epic #2382. Runtime GPU
consumers transitively install this package through asset contracts. An optional
dependency still installs browser automation by default, including Playwright's
bundled Picomatch implementation. Browser-safe API separation alone does not
separate installed dependencies.

## Decision

Move the existing exact playwright-core pin to optional peer metadata and retain
the same exact development pin. Repository CI and qualification workflows keep
their real adapter and full tests. Published qualification operators explicitly
install that peer; ordinary runtime consumers do not need it. The root, Node and
testing APIs remain unchanged, and automation remains lazily loaded.

The trusted harness derives its expected adapter version from release-owned peer
metadata and rejects missing optional markers or non-exact pins. Validate the
actual installed package name/version before hashing the full adapter/browser
trees. Do not weaken source fingerprints, matrix matching, hardware requirements,
missing-adapter failures or publishing controls. Fresh harness bytes require fresh
qualification evidence.

## Validation and consequences

Requirements tests first reproduce the auto-install declaration and absent peer
identity check. Verify exact manifest pins, malformed metadata rejection, real
installed peer integrity and existing runner behavior. A clean packed consumer
must import all public subpaths without installing Playwright, using normal npm
peer/optional behavior. Missing automation remains an explicit failure.

Keep >=80% coverage with every changed source in LCOV, plus types/lint/build,
matrix and public artifact checks. Only main cd.yml/production can publish the
fix; consumers adopt the verified registry release. This is a runtime dependency
boundary change, not a claim that the qualification development graph is free of
Picomatch or that any shader has new hardware qualification. No rollout control,
capability or production entitlement changes.
