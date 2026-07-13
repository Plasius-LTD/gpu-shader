# @plasius/gpu-shader documentation

## Architecture

- [WGSL shader compatibility and style framework](design/wgsl-shader-compatibility-and-style-framework.md)
- [ADR 0001: final assembled WGSL is the interface source of truth](adrs/adr-0001-final-assembled-wgsl-is-the-interface-source-of-truth.md)
- [ADR 0003: immutable GPU asset versions before catalog access](adrs/adr-0003-immutable-gpu-asset-versions-before-catalog-access.md)
- [ADR index](adrs/index.md)

## Technical direction

- [TDR 0001: qualification evidence and trusted runners](tdrs/tdr-0001-qualification-evidence-and-trusted-runners.md)
- [TDR 0002: exact immutable GPU asset version grammar](tdrs/tdr-0002-exact-immutable-gpu-asset-version-grammar.md)
- [TDR index](tdrs/index.md)

## Verification and operations

- [Testing strategy](testing.md)
- [Physical fleet readiness runbook](operations/physical-fleet-readiness.md)

The physical runner fleet described by the baseline matrix has not been
verified as provisioned. These documents define the required gate; they do not
assert that the gate has passed or that any shader has universal physical
support.

Physical execution additionally depends on runner-owned, fixed-root,
digest-bound adapter preloads that are not candidate inputs. GitHub workflow
artifacts are evidence transport only: the exact matrix, aggregate evidence,
attestation reference, and attestation bundle must be copied to and verified in
immutable model storage before shader admission, and profile admission follows
as a separate second stage.
