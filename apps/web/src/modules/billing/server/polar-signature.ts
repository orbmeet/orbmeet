/**
 * Polar webhook signatures (Standard Webhooks framing): the signed content is
 * `${webhook-id}.${webhook-timestamp}.${body}`, HMAC-SHA256.
 */

const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

function decodeBase64(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * The HMAC keys a `whsec_…` secret can stand for. Polar signs with Standard
 * Webhooks for secrets generated since 8 September 2026 (the key is the base64
 * after `whsec_`), and with its older scheme before that (the key is the whole
 * secret string's bytes). Nothing in the secret says which, so both are tried,
 * as Polar's own SDKs do.
 */
function webhookKeys(secret: string): Uint8Array<ArrayBuffer>[] {
  const trimmed = secret.trim();
  const keys: Uint8Array<ArrayBuffer>[] = [];
  const standard = decodeBase64(trimmed.replace(/^whsec_/, ""));
  if (standard && standard.length > 0) keys.push(standard);
  if (trimmed) keys.push(new TextEncoder().encode(trimmed));
  return keys;
}

/**
 * Verify a webhook signature. The signed content is
 * `${webhook-id}.${webhook-timestamp}.${body}`. The header can carry several
 * space-separated `v1,<base64>` signatures — Polar signs with old and new
 * secrets while one is rotated — and any one of them matching is enough.
 */
export async function verifyPolarWebhookSignature(
  rawBody: string,
  headers: { id: string; timestamp: string; signature: string },
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  if (!/^\d+$/.test(timestamp)) return false;
  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (Math.abs(Math.floor(now / 1000) - timestampSeconds) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const signatures = signature.split(" ").flatMap((entry) => {
    const [version, encoded] = entry.split(",", 2);
    const bytes = version === "v1" && encoded ? decodeBase64(encoded) : null;
    return bytes ? [bytes] : [];
  });
  if (signatures.length === 0) return false;
  const signedContent = new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`);

  for (const keyBytes of webhookKeys(secret)) {
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    for (const signatureBytes of signatures) {
      if (await crypto.subtle.verify("HMAC", key, signatureBytes, signedContent)) return true;
    }
  }
  return false;
}
