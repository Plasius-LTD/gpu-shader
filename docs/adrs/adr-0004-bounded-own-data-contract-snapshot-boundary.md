# ADR 0004: GPU contracts cross a bounded own-data snapshot boundary

- Status: Accepted
- Date: 2026-07-15
- Decision owners: Plasius shader framework maintainers
- Related work: Plasius-LTD/plasius-ltd-site#902, #1026, #1027;
  Plasius-LTD/gpu-shader#13
- Inherited feature flag: `asset.pipeline.shader-store.enabled`

## Context

Browser APIs accept JavaScript values as well as JSON-decoded bytes. A value
that looks like a manifest can still contain accessors, custom prototypes, a
Proxy, sparse arrays, cycles, or an oversized unknown subgraph. Reading such a
property while making a defensive copy executes caller code before schema
validation. Copying a thrown getter or Proxy error into a public diagnostic or
`error.cause` can also disclose provider data. Descriptor-specific array and
string limits are too late when an unknown field is traversed first.

## Decision

Every browser-safe GPU contract parser first copies its complete data graph
through one bounded own-data snapshot primitive. The primitive accepts JSON
primitives, local-realm plain objects (including null-prototype objects), and
dense ordinary arrays. It obtains values only from own enumerable data
descriptors. It never performs a caller property read, invokes an accessor, or
uses an array iterator supplied by the caller.

The snapshot rejects accessors, symbols, non-enumerable fields, behavioral
prototypes, custom array fields, sparse arrays, unsupported primitives,
invalid Unicode, cycles, and graphs exceeding the versioned depth, node,
property, element, string-byte, aggregate-string-byte, aggregate-byte, or
input-byte policy. Runtime/model manifests use the normal browser policy.
Qualification products use a separately named, larger policy so evidence
scale does not weaken the runtime boundary. Both policies remain finite and
fail closed.

JavaScript cannot reliably identify a transparent Proxy. `getPrototypeOf`,
`ownKeys`, and `getOwnPropertyDescriptor` Proxy traps can therefore run during
inspection. Their thrown values are caught immediately and replaced by a
constant error with no retained cause. The boundary guarantees that property
getters and Proxy `get` traps are not invoked; it does not claim that arbitrary
Proxy reflection code cannot execute. Callers receiving cross-realm or
behavioral objects must JSON-decode or structured-clone them into the current
realm before parsing.

Canonical JSON and ABI hashing operate on the safe snapshot. Valid plain JSON
retains byte-identical JCS ordering and number serialization, including
normalization of negative zero. Parsed contracts remain detached and deeply
frozen after schema validation.

Encoded JSON and catalog module bytes cross a companion TypedArray-intrinsic
copy boundary. Intrinsic brand/length access and `set` copying avoid caller
property, species-constructor, iterator, and index reads while preserving
Buffer, Uint8Array subclass, and cross-realm compatibility. Runtime
style-loading inspects its request and returned asset envelopes through own
data descriptors; behavioral catalog and cryptographic callbacks are invoked
only inside fixed-diagnostic guards.

## Consequences

- Hostile accessors cannot run during model, interface, shader, profile,
  compatibility, matrix, inventory, qualification, evidence, or runtime-ref
  parsing.
- Deep or oversized unknown fields fail before descriptor-specific validation.
- Oversized array length is rejected before requesting the array's full own-key
  set.
- Snapshot failures expose bounded constant diagnostics without provider
  messages or raw causes.
- Objects previously accepted only because JSON serialization ignored hidden,
  symbolic, sparse, or custom fields are intentionally rejected.
- Changing either snapshot policy changes admission/runtime behavior and
  requires coordinated package validation and affected shader inventory
  requalification.

## Alternatives considered

- Continue using `JSON.stringify`/canonicalization directly on caller values.
  Rejected because both perform property reads and may invoke accessors.
- Validate known fields before copying. Rejected because unknown fields and
  nested accessors can still consume resources or execute during inspection.
- Detect and reject all Proxies. Rejected because JavaScript provides no
  portable, browser-safe transparent-Proxy test.
- Apply qualification-scale limits to every manifest. Rejected because it
  unnecessarily expands the browser/runtime resource-exhaustion envelope.

## Validation

Regression tests cover returning and throwing nested accessors, Proxy `get`
and reflection traps, diagnostic serialization, sparse/custom arrays, cycles,
plain/shared objects, canonical JCS parity, every counter, oversized/deep
unknown fields, and all public manifest and qualification parser families.
