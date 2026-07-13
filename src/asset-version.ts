const ASSET_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/u;

const MUTABLE_VERSION_ALIASES = new Set([
  "latest",
  "current",
  "stable",
  "preview",
  "default",
  "production",
  "canary",
  "next",
  "head",
  "main",
]);

const X_WILDCARD_SEGMENT_PATTERN = /^(?:[vV])?[xX](?:\.|-|$)|\.[xX](?:\.|-|$)/u;
const IMMUTABLE_VERSION_ERROR_MESSAGE =
  "Immutable asset version must be an exact token up to 128 characters; mutable aliases, ranges, wildcards, and URLs are not allowed.";

/**
 * Validates an immutable, reproducible model, interface, shader, or profile
 * version before catalog access.
 *
 * The diagnostic is deliberately constant and never interpolates untrusted
 * input, keeping runtime and storage-boundary failures bounded.
 */
export function assertImmutableAssetVersion(value: unknown): string {
  if (
    typeof value !== "string"
    || !ASSET_VERSION_PATTERN.test(value)
    || MUTABLE_VERSION_ALIASES.has(value.toLowerCase())
    || X_WILDCARD_SEGMENT_PATTERN.test(value)
  ) {
    throw new TypeError(IMMUTABLE_VERSION_ERROR_MESSAGE);
  }
  return value;
}
