# Task 31: source-name validation evidence

Local revalidation on 19 September 2026 of implementation commit
`0c2b02e74232266b0cb531e5c9b3a33199b66b19`.

The requirements-first padding/invalid-name regression failed before the fix.
The final suite passes 590 tests across 35 files. Coverage is 93.83% lines and
81.03% branches overall. Both changed runtime files occur in LCOV:
`manifest-validation.ts` has 98.65% lines / 90.06% branches;
`wgsl-identifier.ts` has 100% lines / branches.

Passed: typecheck, lint, build, public package contents, public artifact source
integrity, matrix **metadata** validation, all nine Zero-Three checks using the
renderer checker, and the complete npm dependency audit (zero reported findings).
No dependencies or locks were changed. No package was published locally.

The [retained receipt](task-31-renderer-reflection.json) binds the complete
121,229-byte renderer WGSL to immutable renderer and shader revisions. All 18
records, 45 resources and 11 compute entry points passed reflection, including
`EnvironmentPortal._pad0` at offset 8 and `_pad1` at offset 12. Generated manifest,
schema, type, constant and codec hashes are retained. Reproduce after building:

```sh
node scripts/check-renderer-reflection.mjs /path/to/pinned/gpu-renderer-checkout
```

The checker requires every runtime source file to equal the pinned commit before
importing the assembled source. It does not rename shader fields or reflect a
simplified copy. Its pipeline descriptors are reflection-derived: this validates
the source interface, **not** the renderer's host bind-group creation, physical
device limits or GPU execution. The matrix command also does not run physical
cells. Physical shader/transport and matched-quality renderer qualification remain
separate gates. No adaptive speed or memory improvement is claimed here.

The fix retains the existing bounded ASCII source-name profile. Full Unicode-14
source analysis remains unqualified; legal ASCII source names are not normalized
or renamed. Unrelated contract ID and semantic-token validation is unchanged.

Post-push CI and approved main/CD release gates remain outstanding. The four
organization self-hosted runners were observed offline on 19 September; earlier
renderer/site check queues had expired. No checks were waived or replaced with a
local qualification claim.
