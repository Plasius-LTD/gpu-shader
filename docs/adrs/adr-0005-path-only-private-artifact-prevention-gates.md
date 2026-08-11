# ADR 0005: path-only private-artifact prevention gates

## Status

- Accepted
- Date: 2026-07-15
- Version: 1.0

## Tags

security, privacy, packaging, CI, compliance

## Context

`@plasius/gpu-shader` is distributed as a public source repository and public
npm package. Neither boundary may contain signed contributor agreements,
acceptance registries, or similar personal records. `.gitignore` cannot reject
a path that is already tracked, while package allowlists can drift as compiled
outputs evolve.

The prevention control must not increase exposure while evaluating a candidate
repository. In particular, it must not open, hash, copy, diff, or log the
contents of a suspected private artifact.

## Decision

Contributor agreements and acceptance records are stored only in an approved,
access-controlled system outside source control.

This repository provides a zero-dependency Node.js policy with two enforcement
boundaries:

1. `privacy:check` unions recursive filesystem path metadata with the current
   Git index, without following symbolic links or reading file contents. A
   missing, invalid, or unavailable Git worktree/index fails closed. The gate
   rejects every case variant of the `.csv` extension, singular and plural
   contributor/CLA registry files and path segments, signed-CLA storage
   directories, and any path containing both a privacy marker (`private`,
   `confidential`, `internal`, `personal`, or `pii`) and a registry marker
   (`registry`, `register`, `roster`, or `ledger`). A registry used in ordinary
   code remains allowed when no privacy marker is present.
2. `pack:check` requires the exact `dist` and `matrices` entries in
   `package.json.files` and rejects broad entries such as `.`, `*`, `**/*`, and
   `legal`. It applies the same private-path rules to the path manifest returned
   by `npm pack --dry-run --json --ignore-scripts` and requires an exact match
   with the package's final public-artifact path allowlist.

The rules normalize Windows and POSIX separators, an optional npm `package/`
tar prefix, and protected path categories case-insensitively so workspace and
package nesting cannot bypass the policy. Dependency and tool metadata
directories are excluded from the filesystem walk, while their tracked paths
remain covered by the Git index. Package output is independently covered by the
npm pack manifest. The temporary `.npm-cache-packcheck` directory is removed in
a `finally` boundary on both success and failure.

The policy and tests use only Node.js built-ins. CI runs the repository gate
before dependency installation, then runs its tests and the package gate.
Release preparation checks the exact source tree before release metadata can
change. Both release-authority resolution and CD validation check again before
executing repository release code or installing dependencies. The existing
`prepublishOnly` lifecycle remains a final local defense by calling
`pack:check` after build.

`.gitignore` entries provide an additional accidental-add safeguard but are not
the enforcement boundary.

Feature flags and capabilities do not apply to this decision: this is a
mandatory build-time privacy control and must not be remotely bypassable.

## Alternatives considered

- **Rely on `.gitignore` only:** rejected because ignore rules do not remove or
  reject already tracked files and do not validate package manifests.
- **Scan file contents for personal data:** rejected for this boundary because
  reading and reporting suspected records can increase exposure, while content
  heuristics produce both false positives and false negatives.
- **Rely on `package.json.files` only:** rejected because it does not protect
  the source repository and can regress when package metadata changes.
- **Check only required tarball paths:** rejected because an additional
  unintended path could still be published alongside every required path.

## Consequences

- Repositories, package metadata, and npm package manifests fail closed when a
  protected or non-allowlisted path is present.
- Compiled output name changes require a reviewed update to the exact final
  tarball allowlist.
- The dependency-free repository gate can execute before dependency install.
- New private-artifact path categories require an explicit policy and test
  update.
- The targeted path policy is defense in depth, not a replacement for secret
  scanning, access controls, retention controls, or incident response.

## Related decisions

- [ADR 0001: final assembled WGSL is the interface source of truth](adr-0001-final-assembled-wgsl-is-the-interface-source-of-truth.md)
- [ADR 0002: separate release validation and immutable source authorities](adr-0002-separate-release-validation-and-immutable-source-authorities.md)
