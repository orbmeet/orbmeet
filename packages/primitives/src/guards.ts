/** A non-null, non-array object: the shape a parsed JSON object has. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `value`, held within `min` and `max` (which must not be inverted). */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** {@link clamp} for untrusted input: anything but a finite number is `fallback`. */
export function clampFinite(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}
