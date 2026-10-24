// Token and secret primitives shared by every feature that issues or checks a
// credential: sessions, guest secrets, space invites, and personal access
// tokens. These are infrastructure, not identity domain logic — meetings,
// spaces, transcripts and the public-API adapter all need them, and routing
// that need through `modules/identity` is what made identity a dependency
// magnet in the first place.

import { timingSafeEqual } from "@orbmeet/primitives";

const enc = new TextEncoder();

// Precomputed hex nibbles. `Array.from(bytes).map((b) => b.toString(16).padStart(2,"0")).join("")`
// allocates an intermediate string array AND a per-byte string before joining;
// on the hottest authenticated path (hashSessionToken runs once per request)
// that overhead adds up. This builds the hex string in one pass with no
// intermediate array allocation.
const HEX_DIGITS = "0123456789abcdef";
function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += HEX_DIGITS[b >> 4] + HEX_DIGITS[b & 0x0f];
  }
  return out;
}

/** HMAC-SHA256 of `message` under `secret`, hex encoded. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

/** Hash session token (SHA-256) */
export async function hashSessionToken(token: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(token));
  return bytesToHex(new Uint8Array(hash));
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
