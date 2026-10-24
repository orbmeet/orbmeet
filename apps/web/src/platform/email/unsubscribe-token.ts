import { decodeBase64Url, encodeBase64Url } from "@orbmeet/primitives";
import { normalizeEmailAddress } from "./address";

/**
 * Signed, non-expiring unsubscribe tokens for the `List-Unsubscribe` header.
 *
 * Non-expiring is deliberate: the header lives in a message that stays in the
 * recipient's mailbox indefinitely, and Gmail/Yahoo may exercise it long after
 * the meeting it announced. The token carries no session and grants nothing but
 * "stop mailing this one address", so age costs us nothing.
 *
 * Signed with `AUTH_SECRET` so a token cannot be forged for a third party's
 * address — without the signature anyone could suppress any user's mail.
 */

const TOKEN_VERSION = "u1";

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await hmacKey(secret, "sign");
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return encodeBase64Url(new Uint8Array(signature));
}

/** `u1.<base64url(email)>.<base64url(hmac)>` — URL-safe, no padding. */
export async function createUnsubscribeToken(email: string, secret: string): Promise<string> {
  const normalized = normalizeEmailAddress(email);
  const encoded = encodeBase64Url(new TextEncoder().encode(normalized));
  const payload = `${TOKEN_VERSION}.${encoded}`;
  return `${payload}.${await sign(payload, secret)}`;
}

/** The normalized address a token authorizes, or `null` if it does not verify. */
export async function readUnsubscribeToken(token: string, secret: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [version, encoded, signature] = parts;
  if (version !== TOKEN_VERSION) return null;
  const signatureBytes = decodeBase64Url(signature);
  if (!signatureBytes) return null;
  // WebCrypto's HMAC verify compares in constant time.
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    new Uint8Array(signatureBytes),
    new TextEncoder().encode(`${version}.${encoded}`),
  );
  if (!valid) return null;
  const decoded = decodeBase64Url(encoded);
  if (!decoded) return null;
  const email = new TextDecoder().decode(decoded);
  return email.includes("@") ? email : null;
}

/**
 * The `List-Unsubscribe` / `List-Unsubscribe-Post` pair for one recipient.
 *
 * Both are on the Email Service header allowlist, the URI must be HTTPS (plain
 * HTTP is rejected), and `List-Unsubscribe-Post` must be exactly
 * `List-Unsubscribe=One-Click`. See docs/email-service/reference/headers.md.
 */
export async function buildUnsubscribeHeaders(input: {
  email: string;
  appUrl: string;
  secret: string;
}): Promise<Record<string, string>> {
  const token = await createUnsubscribeToken(input.email, input.secret);
  const base = input.appUrl.replace(/\/$/, "");
  return {
    "List-Unsubscribe": `<${base}/api/email/unsubscribe?token=${token}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
