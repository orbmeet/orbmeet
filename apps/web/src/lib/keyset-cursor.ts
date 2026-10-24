import { decodeBase64Url, encodeBase64Url } from "@orbmeet/primitives";

/**
 * A position in a list ordered by a timestamp and then an id. The cursor
 * carries both, so the next page never looks up the row it ended on: that
 * row may have been deleted in between.
 */
export interface KeysetCursor {
  at: Date;
  id: string;
}

export function encodeKeysetCursor(cursor: KeysetCursor): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify([cursor.at.toISOString(), cursor.id])));
}

/** Null for anything `encodeKeysetCursor` did not produce. */
export function decodeKeysetCursor(value: string): KeysetCursor | null {
  try {
    const bytes = decodeBase64Url(value);
    if (!bytes) return null;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [rawAt, id] = parsed;
    if (typeof rawAt !== "string" || typeof id !== "string" || !id) return null;
    const at = new Date(rawAt);
    return Number.isFinite(at.getTime()) ? { at, id } : null;
  } catch {
    return null;
  }
}

type CursorValue = string | number;
type CursorKind = "string" | "number";
type CursorValues<K extends readonly CursorKind[]> = { -readonly [I in keyof K]: K[I] extends "number" ? number : string };

/**
 * A position in a list ordered by several values, ending in a unique id. The
 * cursor carries the row's own values in order, so like `KeysetCursor` it
 * never depends on the row it ended on still existing, or still sorting where
 * it did.
 */
export function encodeTupleCursor(values: readonly CursorValue[]): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(values)));
}

/** Null unless `value` is a tuple of exactly these kinds, as `encodeTupleCursor` writes it. */
export function decodeTupleCursor<const K extends readonly CursorKind[]>(
  value: string,
  kinds: K,
): CursorValues<K> | null {
  try {
    const bytes = decodeBase64Url(value);
    if (!bytes) return null;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(parsed) || parsed.length !== kinds.length) return null;
    const valid = parsed.every((item, index) =>
      kinds[index] === "number" ? Number.isFinite(item) : typeof item === "string",
    );
    return valid ? (parsed as CursorValues<K>) : null;
  } catch {
    return null;
  }
}
