// Token and secret primitives shared by every feature that issues or checks a
// credential: sessions, guest secrets, space invites, and personal access
// tokens. These are infrastructure, not identity domain logic — meetings,
// spaces, transcripts and the public-API adapter all need them, and routing
// that need through `modules/identity` is what made identity a dependency
// magnet in the first place.

import { bytesToHex, sha256Hex, timingSafeEqual } from "@orbmeet/primitives";

export { hmacSha256Hex } from "@orbmeet/primitives";

/** Hash session token (SHA-256) */
export function hashSessionToken(token: string): Promise<string> {
  return sha256Hex(token);
}

/** Generate 256-bit session token (64-char hex) */
export function generateSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHex(bytes);
}

// A-Z then a-z: 52 letters. Kept letters-only so shared invite URLs stay clean
// and unambiguous (no digits/symbols to misread when spoken or pasted).
const INVITE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Generate a short invite code for shareable Space URLs (…/join/<code>). Eight
 * letters over the 52-letter alphabet is 52^8 ≈ 5.3e13 (~46 bits) — unguessable
 * for a link that is IP-rate-limited on lookup and one-click rotatable, while
 * keeping the URL tiny versus the 64-char hex session token.
 *
 * Rejection sampling (discard bytes ≥ 208, the largest multiple of 52 under 256)
 * keeps the distribution uniform; a plain byte % 52 would bias the first 48
 * letters. The UNIQUE constraint on the token column is the collision backstop —
 * callers retry generation on a UNIQUE violation.
 */
export function generateInviteCode(): string {
  const length = 8;
  const unbiasedCeiling = 208;
  let out = "";
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length - out.length));
    for (let i = 0; i < bytes.length && out.length < length; i++) {
      if (bytes[i] < unbiasedCeiling) out += INVITE_ALPHABET[bytes[i] % 52];
    }
  }
  return out;
}

/**
 * Verify a raw guest secret against the stored hash.
 * Hashes the raw secret and compares timing-safely against the stored SHA-256 hash.
 */
export async function verifyGuestSecret(storedHash: string, rawSecret: string): Promise<boolean> {
  const providedHash = await hashSessionToken(rawSecret);
  return timingSafeEqual(storedHash, providedHash);
}
