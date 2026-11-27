const encoder = new TextEncoder();

const HEX_TABLE: readonly string[] = Array.from({ length: 256 }, (_, byte) =>
  byte.toString(16).padStart(2, "0"),
);

type CryptoInput = string | ArrayBuffer | Uint8Array<ArrayBuffer>;

function toBytes(input: CryptoInput): ArrayBuffer | Uint8Array<ArrayBuffer> {
  return typeof input === "string" ? encoder.encode(input) : input;
}

/** Encode raw bytes as lowercase hexadecimal. */
export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    hex += HEX_TABLE[view[i]];
  }
  return hex;
}

/** Compute the lowercase hex SHA-256 digest of a UTF-8 string or byte buffer. */
export async function sha256Hex(data: CryptoInput): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", toBytes(data)));
}

/** Import a raw UTF-8 secret or byte buffer as an HMAC-SHA256 key. */
export function importHmacSha256Key(
  secret: CryptoInput,
  usages: Parameters<typeof crypto.subtle.importKey>[4],
): ReturnType<typeof crypto.subtle.importKey> {
  return crypto.subtle.importKey(
    "raw",
    toBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

/** Compute an HMAC-SHA256 tag over `message` using `secret`. */
export async function hmacSha256(
  secret: CryptoInput,
  message: CryptoInput,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await importHmacSha256Key(secret, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, toBytes(message)));
}

/** Compute a lowercase hex HMAC-SHA256 tag over `message` using `secret`. */
export async function hmacSha256Hex(
  secret: CryptoInput,
  message: CryptoInput,
): Promise<string> {
  return bytesToHex(await hmacSha256(secret, message));
}
