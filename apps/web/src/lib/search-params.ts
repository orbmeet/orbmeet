/**
 * Small, reusable narrowing helpers for hand-rolled `validateSearch`
 * functions. Search params arrive as `Record<string, unknown>` (whatever the
 * URL happened to contain), so every route needs to narrow them before use.
 * Centralizing the common shapes here avoids re-typing the same
 * `typeof x === "string" ? x : undefined` / enum checks per route.
 */

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}
