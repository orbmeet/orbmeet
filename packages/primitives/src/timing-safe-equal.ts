let timingSafeKeyPromise: Promise<CryptoKey> | null = null;

function getTimingSafeKey(): Promise<CryptoKey> {
  timingSafeKeyPromise ??= crypto.subtle.importKey(
    "raw",
    crypto.getRandomValues(new Uint8Array(32)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return timingSafeKeyPromise;
}

/**
 * Timing-safe string comparison using HMAC-SHA256 with an ephemeral key.
 *
 * HMAC normalizes the digest length before comparison, avoiding early exits on
 * differing input lengths while keeping the key non-public for this process.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await getTimingSafeKey();
  const [macA, macB] = await Promise.all([
    crypto.subtle.sign("HMAC", key, enc.encode(a)),
    crypto.subtle.sign("HMAC", key, enc.encode(b)),
  ]);
  const bufA = new Uint8Array(macA);
  const bufB = new Uint8Array(macB);
  if (bufA.byteLength !== bufB.byteLength) return false;
  let result = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}
