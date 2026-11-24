# ADR 0006: Source identifiers are not contract tokens

- Status: Accepted
- Date: 2026-09-14
- Task: https://github.com/Plasius-LTD/gpu-shader/issues/31
- Parent Feature: https://github.com/Plasius-LTD/plasius-ltd-site/issues/2114

## Context

The complete renderer contains `EnvironmentPortal._pad0`. Reflection succeeds,
but manifest validation rejects this legal source name using the safe-token
grammar intended for interface IDs. Conversely, that grammar accepts source
names with punctuation, leading digits and reserved words.

## Decision

Separate source-name validation from unchanged contract-token validation.
Apply it to records, members, nested type references, runtime-array tails,
variables, entry points, override names and source selectors. Pipeline override
keys may also be numeric IDs; they are not exclusively source identifiers.

The existing reflection framework's supported source-name profile remains ASCII
and bounded to 160 characters. Within that profile use WGSL identifier syntax and
the keywords/reserved words in the [31 August 2026 WGSL edition](https://www.w3.org/TR/2026/CRD-WGSL-20260831/#identifiers).
Reject a lone underscore and double-underscore prefixes. Do not normalize or
rename source names. Full Unicode WGSL identifier support remains outside this
fix: the independent source analyzer and pinned reflector need a separately
qualified Unicode-14 implementation before that contract can be expanded.

Preserve own-data snapshots, object-key safety, strict reference validation and
all resource limits. Do not weaken contract IDs, semantics, paths or URIs.
Generated offsets, schemas and codecs must preserve the original member names;
constant-name collisions must remain disambiguated.

## Verification and consequences

Require padding and nested/runtime-array reflection, source-selector and override
tests, generated-artifact and codec round trips, invalid/reserved-name negatives,
and the existing snapshot-security tests. Retain a commit-pinned reflection result
for the unmodified complete renderer source. This is interface validation, not
physical transport or adaptive performance qualification. Physical fleet and CI/CD
gates remain mandatory. No renderer shader rename, package alias, local publication
or Three.js fallback is permitted. The fix is unconditional validation correctness;
the parent adaptive Feature remains separately controlled and default disabled.
