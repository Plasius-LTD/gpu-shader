// ASCII source-name profile. Unicode source analysis is not yet qualified.
// WGSL CRD 2026-08-31, sections 3.6, 16.1 and 16.2.
const reserved = new Set(`
alias break case const const_assert continue continuing default diagnostic discard
else enable false fn for if let loop override requires return struct switch true var while
NULL Self abstract active alignas alignof as asm asm_fragment async attribute auto
await become cast catch class co_await co_return co_yield coherent column_major common
compile compile_fragment concept const_cast consteval constexpr constinit crate debugger
decltype delete demote demote_to_helper do dynamic_cast enum explicit export extends
extern external fallthrough filter final finally friend from fxgroup get goto groupshared
highp impl implements import inline instanceof interface layout lowp macro macro_rules
match mediump meta mod module move mut mutable namespace new nil noexcept noinline
nointerpolation non_coherent noncoherent noperspective null nullptr of operator package
packoffset partition pass patch pixelfragment precise precision premerge priv protected
pub public readonly ref regardless register reinterpret_cast require resource restrict
self set shared sizeof smooth snorm static static_assert static_cast std subroutine super
target template this thread_local throw trait try type typedef typeid typename typeof
union unless unorm unsafe unsized use using varying virtual volatile wgsl where with
writeonly yield
`.trim().split(/\s+/u));

/** Validates the framework's bounded ASCII WGSL source-identifier profile. */
export function wgslIdentifier(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length > 160
    || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value) || value === "_"
    || value.startsWith("__") || reserved.has(value)) {
    throw new TypeError(`${path} must be a supported ASCII WGSL identifier (not a keyword or reserved name).`);
  }
  return value;
}
