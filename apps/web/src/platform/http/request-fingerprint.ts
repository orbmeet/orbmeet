function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new TypeError("Cannot fingerprint an invalid Date");
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Request fingerprints accept only JSON-compatible objects");
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** Match the second precision used by SQLite timestamp columns. */
export function canonicalSecondPrecisionInstant(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return value;
  return new Date(Math.floor(milliseconds / 1_000) * 1_000).toISOString();
}

/** Stable SHA-256 identity for an already validated and normalized request. */
export async function requestFingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
