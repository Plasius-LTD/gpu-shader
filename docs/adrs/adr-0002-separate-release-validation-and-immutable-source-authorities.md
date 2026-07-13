# ADR 0002: Separate release validation and immutable source authorities

- Status: Accepted
- Date: 2026-07-13
- Decision owners: Plasius shader framework maintainers
- Related Feature: [Plasius-LTD/plasius-ltd-site#1026](https://github.com/Plasius-LTD/plasius-ltd-site/issues/1026)
- Related Story: [Plasius-LTD/plasius-ltd-site#1027](https://github.com/Plasius-LTD/plasius-ltd-site/issues/1027)
- Package Task: [Plasius-LTD/gpu-shader#1](https://github.com/Plasius-LTD/gpu-shader/issues/1)

## Context

An npm publication can succeed before its GitHub draft release is finalized.
Recovery may then require a workflow fix on a newer protected-main commit. A
single `commit_sha` cannot safely represent both that newer workflow authority
and the older commit already embedded in immutable npm SLSA provenance and the
release tag. Moving the tag or expecting new provenance would misrepresent the
published artifact; requiring the workflow to remain on the old commit would
prevent a corrected recovery path.

## Decision

CD maintains two explicit commit authorities:

- `validation_commit_sha` is the current protected-main workflow-dispatch
  commit. It must equal `GITHUB_SHA`, have successful exact push CI, and bind
  the workflow run and attempt-scoped artifact identity.
- `release_commit_sha` is the immutable package source commit. Build, test,
  pack, npm provenance, tag, draft release, and final release identity bind to
  this commit.

For every unpublished version the commits must be identical. They may differ
only for recovery of an exact npm version that already exists. In that case CD
semantically resolves the unique protected-main source commit from the bounded
npm provenance record, cross-checks the existing dereferenced tag, requires the
commit to be an ancestor of current protected main, and checks out that source
for all package validation and packing. Registry signatures and provenance are
still cryptographically verified before the draft becomes a public release.

Transport schema v2 carries both commits and the privileged publisher
independently validates them. Live npm disappearance, changed package bytes,
ambiguous provenance, a missing or moved tag, unrelated branch history, or a
split authority for an unpublished version all fail closed. Recovery skips new
tarball and SBOM attestations because those would describe the newer validation
commit rather than the existing npm publication. The release Node/npm toolchain
is fixed, and SBOM UUID and timestamp fields are normalized from the immutable
release commit and content so reruns reproduce the same release asset bytes
after the GitHub release becomes non-draft.

## Consequences

- Workflow fixes can safely finish an interrupted immutable release.
- Published bytes, npm provenance, and the GitHub tag are never rebound to a
  newer commit.
- Recovery reruns validation against the original source tree as well as CI
  against the current workflow tree.
- The transport contract has two explicit commit fields and schema version 2.
- Recovery depends on the original release commit remaining reachable from
  protected main and on its toolchain remaining reproducible.

## Alternatives considered

### Move the existing tag to current main

Rejected because the npm provenance dependency would continue to identify the
original commit and the release would make a false source claim.

### Treat current main as the package source during recovery

Rejected because excluded workflow-only changes happen to preserve the current
tarball but future source or README changes may not. Recovery must rebuild the
source that actually produced the immutable package.

### Run the old workflow unchanged

Rejected because the interrupted workflow may contain the defect that requires
recovery. Workflow authority and package-source authority are related but not
identical after publication.

## Validation

Supply-chain tests resolve the release commit from exact provenance, reject
duplicate provenance and source dependencies, enforce commit routing throughout
CD, validate transport schema v2, and require new-publication equality. Recovery
also performs live registry integrity checks, bounded npm signature/provenance
verification, tag dereferencing, branch-ancestry checks, and final one-SBOM
release-closure verification.
