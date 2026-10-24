/**
 * Signed service-to-service requests.
 *
 * Each direction of a service link has its own keyring: a JSON object mapping
 * key ids to secrets. The first entry signs; every entry verifies. Rotation is
 * "add the new key first, deploy the verifier, deploy the signer, drop the old
 * key" — no lockstep deploy, and a leaked key of one direction cannot forge the
 * other.
 *
 * The signature covers the method, the path with its query string, a
 * timestamp and the SHA-256 of the body, so a captured request can be replayed
 * only verbatim and only inside the skew window.
 */

export const SIGNATURE_HEADER = "X-Orbmeet-Signature";

export type Keyring = ReadonlyMap<string, string>;

const KEY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_KEYS = 32;
const MIN_SECRET_LENGTH = 32;
const MAX_SECRET_LENGTH = 512;
const DEFAULT_MAX_SKEW_SECONDS = 60;

/** Parse a serialized keyring, or null when it is absent or malformed. */
export function parseKeyring(serialized: string | undefined | null): Keyring | null {
  if (!serialized) return null;
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_KEYS) return null;
  const keys = new Map<string, string>();
  for (const [keyId, secret] of entries) {
    if (
      !KEY_ID_RE.test(keyId)
      || typeof secret !== "string"
      || secret.length < MIN_SECRET_LENGTH
      || secret.length > MAX_SECRET_LENGTH
      || secret !== secret.trim()
    ) {
      return null;
    }
    keys.set(keyId, secret);
  }
  return keys;
}

/** The key that signs outgoing requests: the keyring's first entry. */
export function signingKey(keyring: Keyring): { keyId: string; secret: string } {
  const first = keyring.entries().next();
  if (first.done) throw new Error("Keyring is empty");
  const [keyId, secret] = first.value;
  return { keyId, secret };
}

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(body: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof body === "string" ? encoder.encode(body) : body;
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

function canonicalString(method: string, target: string, timestamp: number, bodyHash: string) {
  return `v1\n${method.toUpperCase()}\n${target}\n${timestamp}\n${bodyHash}`;
}

/** `pathname + search` of a URL, which is what the signature covers. */
export function signatureTarget(url: string | URL): string {
  const parsed = typeof url === "string" ? new URL(url) : url;
  return `${parsed.pathname}${parsed.search}`;
}

export interface SignRequestInput {
  method: string;
  /** `pathname + search`; see `signatureTarget`. */
  target: string;
  body: string | Uint8Array<ArrayBuffer>;
  keyring: Keyring;
  nowSeconds?: number;
}

/** The `X-Orbmeet-Signature` header value for one request. */
export async function signRequest(input: SignRequestInput): Promise<string> {
  const { keyId, secret } = signingKey(input.keyring);
  const timestamp = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const bodyHash = await sha256Hex(input.body);
  const signature = await hmacHex(
    secret,
    canonicalString(input.method, input.target, timestamp, bodyHash),
  );
  return `v1,kid=${keyId},ts=${timestamp},sig=${signature}`;
}

export type SignatureVerification =
  | { ok: true; keyId: string }
  | { ok: false; reason: "missing" | "malformed" | "unknown_key" | "expired" | "invalid" };

export interface VerifyRequestInput {
  header: string | null;
  method: string;
  target: string;
  body: string | Uint8Array<ArrayBuffer>;
  keyring: Keyring;
  nowSeconds?: number;
  maxSkewSeconds?: number;
}

const HEADER_RE = /^v1,kid=([A-Za-z0-9_-]{1,64}),ts=(\d{10}),sig=([a-f0-9]{64})$/;

/** Verify a signed request against every key in the keyring's entry for its key id. */
export async function verifySignedRequest(input: VerifyRequestInput): Promise<SignatureVerification> {
  if (!input.header) return { ok: false, reason: "missing" };
  const match = HEADER_RE.exec(input.header);
  if (!match) return { ok: false, reason: "malformed" };
  const [, keyId, timestampText, supplied] = match;
  const secret = input.keyring.get(keyId);
  if (!secret) return { ok: false, reason: "unknown_key" };
  const timestamp = Number(timestampText);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (input.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS)) {
    return { ok: false, reason: "expired" };
  }
  const expected = await hmacHex(
    secret,
    canonicalString(input.method, input.target, timestamp, await sha256Hex(input.body)),
  );
  let difference = 0;
  for (let index = 0; index < expected.length; index++) {
    difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  }
  return difference === 0 ? { ok: true, keyId } : { ok: false, reason: "invalid" };
}
