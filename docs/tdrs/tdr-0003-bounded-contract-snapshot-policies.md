# TDR 0003: Bounded GPU contract snapshot policies

- Status: Accepted
- Date: 2026-07-15
- Related ADR: [ADR 0004](../adrs/adr-0004-bounded-own-data-contract-snapshot-boundary.md)
- Related task: Plasius-LTD/gpu-shader#13

## Runtime and manifest policy

The browser/runtime policy permits at most:

- nesting depth 64;
- 262,144 visited nodes;
- 131,072 object properties;
- 131,072 array elements in total and 100,000 in one array;
- 1 MiB for one UTF-8 string or property key;
- 8 MiB aggregate UTF-8 string/key bytes; and
- 16 MiB aggregate canonical data and 16 MiB encoded JSON input.

The counters include unknown fields and shared subgraphs on every occurrence,
matching JSON serialization work. Circularity uses the current ancestor chain,
so a shared acyclic object is copied by value while an actual cycle fails.

## Qualification policy

Qualification inventory, fixture, and evidence products use the same
descriptor-only algorithm with these explicit larger limits:

- nesting depth 96;
- 4,000,000 visited nodes;
- 2,000,000 object properties;
- 2,000,000 total array elements and 250,000 in one array;
- 4 MiB for one UTF-8 string or property key;
- 128 MiB aggregate UTF-8 string/key bytes; and
- 256 MiB aggregate canonical data and encoded JSON input.

The qualification policy aligns with the existing 256 MiB candidate-bundle
admission ceiling but does not expand it. Candidate binary files are governed
by their separate bundle/resource bounds and are not embedded into JSON.

## Inspection algorithm

For every object or array, the snapshot performs guarded `Array.isArray`,
`Reflect.getPrototypeOf`, `Reflect.ownKeys`, and
`Reflect.getOwnPropertyDescriptor` operations. It copies only
`descriptor.value`; accessor descriptors are rejected. Array keys must be the
exact dense index set plus the non-enumerable data `length` property. New
ordinary objects use `defineProperty`, including for `__proto__`, so the copy
does not mutate its prototype.

Any exception from reflective inspection is replaced with a fixed
`GpuContractSnapshotError`; the original value is not interpolated, attached
as `cause`, or returned in a diagnostic. Schema validation begins only after
the snapshot succeeds.

Array `length` is inspected and checked against both element policies before
`ownKeys` is requested. Encoded bytes use the captured `%TypedArray%`
`byteLength` and `@@toStringTag` getters followed by a trusted allocation and
captured `Uint8Array.prototype.set`. This rejects Proxy-wrapped or non-byte
typed arrays without invoking `get`, while accepting genuine Buffer,
Uint8Array subclass, and cross-realm values without species construction.

## Change control

Limit changes are contract-policy changes. They require security/performance
review, parser and package tests, changelog documentation, and requalification
of affected stored shader evidence before promotion.
