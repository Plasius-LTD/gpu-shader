# ADR 0003: Immutable GPU asset versions are enforced before catalog access

- Status: Accepted
- Date: 2026-07-13
- Decision owners: Plasius shader framework maintainers
- Related work: Plasius-LTD/plasius-ltd-site#902, #1026, #1027;
  Plasius-LTD/gpu-shader#10

## Context

Models, reflected interfaces, shader manifests, and rendering-style profiles
are independently versioned immutable assets. Friendly catalog channels such
as `stable` are useful for discovery, but allowing a channel, range, wildcard,
or URL to occupy an immutable reference makes a scene resolve different bytes
without changing its recorded identity. The browser loader is itself a trust
boundary: it consumes GPU contracts directly and must not depend on a later
storage-envelope check to distinguish an exact version from a mutable alias.

## Decision

The browser-safe root package exports one `assertImmutableAssetVersion`
validator. Strict model, GPU-interface, shader, and style-profile parsers apply
that validator to their own versions and every nested immutable version
reference. `loadShaderStyleProfile` applies it to the caller's profile
reference before invoking any catalog method; nested shader and interface
references are rejected while parsing their parent bytes and before their
resolvers run.

The accepted grammar is a bounded token beginning with an ASCII alphanumeric
character and continuing with ASCII alphanumerics, dot, underscore, or hyphen.
It rejects reserved mutable channel aliases case-insensitively, `x` segment and
`*` wildcards, range syntax, URLs, and path syntax. This is an asset identity
grammar, not a requirement that every asset version use Semantic Versioning.
Catalog channels remain separate mutable pointers that resolve to an exact
version before producing a runtime reference.

Storage and lifecycle packages retain equivalent validation as defense in
depth. The dependency direction remains from asset contracts to this package;
the browser package does not depend on storage or asset-contract packages.

## Consequences

- Exact scene and profile pins remain reproducible across catalog changes and
  rollback.
- Invalid versions fail before their corresponding referenced asset is resolved
  or any GPU work begins.
- Existing callers that placed `latest`, `stable`, or another channel into an
  immutable reference must resolve that channel first.
- Numeric, SemVer-like, date/build, and opaque exact token versions remain
  supported.
- A future grammar change is a public contract change and requires coordinated
  lifecycle validation plus shader inventory requalification when runtime
  compatibility behavior changes.

## Alternatives considered

- Rely only on asset-storage admission. Rejected because browser consumers
  parse and load shader contracts directly.
- Infer immutability from a manifest URI. Rejected because URI shape is not the
  version identity and catalog resolvers are the only allowed byte source.
- Require strict Semantic Versioning. Rejected because immutable interface and
  build versions may legitimately use numeric, date, or opaque exact tokens.

## Validation

Unit tests cover accepted exact tokens and rejected aliases, ranges,
wildcards, URLs, paths, and oversized input. Parser tests cover every manifest
and nested-reference position. Runtime tests prove invalid profile, shader, and
interface versions are rejected before their corresponding catalog method is
called. Package export and browser-bundle checks keep the validator available
without adding Node dependencies.
