/**
 * Canonical cross-runtime base64url primitives.
 *
 * The single implementation for every package that needs base64url. It runs
 * in browsers, workers, and Node on the global `btoa`/`atob` pair, so it
 * must stay dependency-free.
 */

/** Encode bytes as unpadded, URL-safe base64url. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * Decode unpadded base64url, or return null for anything else.
 *
 * Deliberate strictness (this is the canonical behavior for every consumer):
 * the standard base64 alphabet (`+`, `/`), explicit `=` padding, whitespace,
 * impossible lengths (a lone trailing half-byte), and the empty string are
 * all rejected. Decoders that feed signature or key bytes into WebCrypto
 * must fail closed rather than silently decode adjacent encodings.
 */
export function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  try {
    const padded = value
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    // `atob` accepts encodings with non-zero unused trailing bits (for
    // example YR, YS, and YT all decode to the byte encoded canonically as
    // YQ). Re-encoding makes the one accepted spelling explicit.
    return encodeBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}
