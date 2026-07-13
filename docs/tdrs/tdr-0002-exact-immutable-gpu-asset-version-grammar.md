# TDR 0002: Exact immutable GPU asset version grammar

- Status: Accepted
- Date: 2026-07-13
- Implements: ADR 0003

## Contract

`assertImmutableAssetVersion(value)` returns the original string only when all
of these conditions hold:

- length is 1 through 128 ASCII characters;
- the first character is alphanumeric;
- remaining characters are alphanumeric, `.`, `_`, or `-`;
- the lowercase value is not `latest`, `current`, `stable`, `preview`,
  `default`, `production`, `canary`, `next`, `head`, or `main`; and
- no standalone `x`/`X` wildcard segment is present.

The token grammar rejects `*`, comparison/range operators, whitespace, URL
schemes, query strings, fragments, and slash or backslash paths without
separate special cases. A literal `x` inside a larger opaque component, such
as `build-x`, is not a wildcard and remains valid.

## Boundary placement

- `GpuInterfaceManifest.interfaceVersion` uses the validator.
- `ShaderVersionManifest.version`, its `gpuInterface.interfaceVersion`, and
  every compatible-model interface version use the validator.
- `ShaderStyleProfileManifest.version`, every role's shader version, and every
  compatible-model interface version use the validator.
- `ModelGpuCompatibilityDescriptor.version`, its interface version, and its
  optional default-profile version use the validator.
- Runtime profile, shader, and interface references are checked before their
  respective promoted-catalog resolver methods run.

Parsers wrap the public bounded diagnostic with the field path but never echo
the untrusted version. This keeps logs useful without allowing oversized or
control-character input to amplify diagnostics.

## Compatibility and rollout

This correction does not change hash projections or WGSL layout. It closes a
runtime identity ambiguity and therefore ships as a patch release. Catalog
APIs may continue accepting channel names as lookup inputs, but they must emit
only exact-version references. Storage and asset-contract validation remains
enabled as an independent admission check.

`asset.pipeline.shader-store.enabled` still controls runtime shader/profile
discovery, loading, and activation; it does not weaken exact-version checks.
The `gpu.shader.style.select` capability controls user-visible selection, not
reference validity.
