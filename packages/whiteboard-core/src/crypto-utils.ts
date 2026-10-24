import { decodeBase64Url } from "@orbmeet/primitives";

export { encodeBase64Url as base64urlEncode } from "@orbmeet/primitives";

/**
 * Decode unpadded base64url, throwing on anything else.
 *
 * The canonical decoder reports invalid input as `null` so caption parsers
 * can fail closed; token parsers here prefer exceptions, so this wrapper
 * converts. Canonical strictness applies unchanged: padding, the standard
 * base64 alphabet, whitespace, impossible lengths, and the empty string are
 * all rejected ("" once decoded to zero bytes here — a token with an empty
 * segment now fails its encoding check instead, which every caller already
 * treats as an invalid token).
 */
export function base64urlDecode(str: string): Uint8Array {
  const bytes = decodeBase64Url(str);
  if (!bytes) throw new Error("Invalid base64url encoding");
  return bytes;
}

export function importHmacSha256Key(
  secret: string,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

/**
 * Lowercase hex of a SHA-256 digest, optionally shortened.
 *
 * Shortening is safe for the identifier use this exists for — naming a
 * resource after an input — because collision resistance, not preimage
 * resistance, is what such a name needs: 128 bits puts the birthday bound at
 * 2^64 distinct inputs, far past anything this system can hold.
 */
export async function sha256Hex(input: string, chars = 64): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex.slice(0, chars);
}
