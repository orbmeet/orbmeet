/**
 * Compare strings by JavaScript UTF-16 code units.
 *
 * Use this for persisted protocol keys, fractional indices, and values ordered
 * by SQLite's default BINARY collation. Human-facing text should generally use
 * localeCompare or Intl.Collator instead.
 */
export function compareCodeUnitStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
