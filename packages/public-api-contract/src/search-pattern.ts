// D1 `LIKE` search patterns, free of any schema library so query builders can
// use them directly. `searchTextSchema` in `fields.ts` builds on them.

/** D1 rejects a `LIKE` pattern longer than this many UTF-8 bytes. */
export const D1_LIKE_PATTERN_MAX_BYTES = 50;

const encoder = new TextEncoder();

export function escapeSqliteLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function buildD1ContainsPattern(value: string): string {
  return `%${escapeSqliteLike(value)}%`;
}

/**
 * Whether `value` still fits D1's pattern limit once it is trimmed, lowercased,
 * escaped and wrapped in wildcards, the way the queries emit it.
 */
export function fitsD1ContainsPattern(value: string): boolean {
  const pattern = buildD1ContainsPattern(value.trim().toLowerCase());
  return encoder.encode(pattern).byteLength <= D1_LIKE_PATTERN_MAX_BYTES;
}
