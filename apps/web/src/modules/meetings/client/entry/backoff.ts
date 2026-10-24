export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** Delay multiplier applied on each consecutive failure (default 2). */
  factor?: number;
}

/**
 * The next delay given the previous delay and whether the last try
 * succeeded. Success resets to `baseMs`; failure grows geometrically up to
 * `maxMs`.
 */
export function nextBackoffDelay(prevMs: number, ok: boolean, opts: BackoffOptions): number {
  const { baseMs, maxMs, factor = 2 } = opts;
  if (ok) return baseMs;
  return Math.min(maxMs, Math.max(baseMs, prevMs) * factor);
}
