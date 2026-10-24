interface RateLimiterOptions {
  /**
   * Per-window byte budget, expressed as a sustained per-second rate and scaled
   * to `windowMs`. Omit for count-only limiting: callers that never pass
   * `messageBytes` to `check` have no byte dimension, and a default budget here
   * would silently cap a caller that later starts passing sizes.
   */
  maxBytesPerSecond?: number;
  /**
   * Hard ceiling on tracked keys. Entries are bounded in practice by the number
   * of distinct users in one room (or, for per-IP buckets, by the cap), and
   * the cap makes that a property of the limiter rather than of its callers.
   */
  maxKeys?: number;
}

const DEFAULT_MAX_KEYS = 10_000;

export interface RateLimitReservation {
  commit(): void;
}

export class RateLimiter {
  private limits = new Map<string, { count: number; bytes: number; windowStart: number }>();
  private callCount = 0;
  private readonly maxBytesPerWindow: number | null;
  private readonly maxKeys: number;
  private cleanupInterval: ReturnType<typeof setInterval>;

  private readonly maxMessages: number;
  private readonly windowMs: number;

  constructor(
    maxMessages: number,
    windowMs: number,
    options: RateLimiterOptions = {},
  ) {
    this.maxMessages = maxMessages;
    this.windowMs = windowMs;
    this.maxBytesPerWindow =
      options.maxBytesPerSecond === undefined
        ? null
        : Math.ceil(options.maxBytesPerSecond * (windowMs / 1000));
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    this.cleanupInterval = setInterval(() => this.cleanup(), windowMs * 10);
    this.cleanupInterval.unref?.();
  }

  check(key: string, messageBytes = 0): boolean {
    const reservation = this.reserve(key, messageBytes);
    if (!reservation) return false;
    reservation.commit();
    return true;
  }

  /**
   * Check a budget without charging it. The caller may compose reservations
   * from multiple limiters and commit all of them only after every budget has
   * admitted the operation. Reservations must be committed synchronously;
   * they intentionally do not survive intervening limiter activity.
   */
  reserve(key: string, messageBytes = 0): RateLimitReservation | null {
    this.callCount++;
    if (this.callCount % 100 === 0) this.cleanup();

    const now = Date.now();
    const limit = this.limits.get(key);
    const byteBudget = this.maxBytesPerWindow;

    if (!limit || now - limit.windowStart >= this.windowMs) {
      if (byteBudget !== null && messageBytes > byteBudget) return null;
      return {
        commit: () => {
          const current = this.limits.get(key);
          if (current && now - current.windowStart < this.windowMs) {
            // Another synchronous reservation for this key committed first.
            // Merge into the live window rather than overwriting its charge.
            this.limits.delete(key);
            current.count++;
            current.bytes += messageBytes;
            this.limits.set(key, current);
            return;
          }
          if (!current) this.admitNewKey(now);
          else this.limits.delete(key);
          this.limits.set(key, { count: 1, bytes: messageBytes, windowStart: now });
        },
      };
    }

    if (limit.count >= this.maxMessages || (byteBudget !== null && limit.bytes + messageBytes > byteBudget)) {
      // A refused attempt is still activity: refreshing its place keeps cap
      // pressure from evicting (and so resetting) a key that is flooding.
      this.limits.delete(key);
      this.limits.set(key, limit);
      return null;
    }
    return {
      commit: () => {
        // Map insertion order is the eviction order. Refresh it on committed
        // activity so cap pressure drops an idle key rather than resetting a
        // hot user's budget.
        this.limits.delete(key);
        limit.count++;
        limit.bytes += messageBytes;
        this.limits.set(key, limit);
      },
    };
  }

  // Make room for a key we are about to track. Sweeping expired windows first
  // keeps eviction off live keys; only a genuinely saturated limiter drops the
  // least-recently-started window, which costs that key one window's budget.
  private admitNewKey(now: number): void {
    if (this.limits.size < this.maxKeys) return;
    this.cleanup(1, now);
    while (this.limits.size >= this.maxKeys) {
      const oldestKey = this.limits.keys().next().value;
      if (oldestKey === undefined) break;
      this.limits.delete(oldestKey);
    }
  }

  cleanup(staleMultiplier = 3, now = Date.now()): void {
    const threshold = this.windowMs * staleMultiplier;
    for (const [key, limit] of this.limits) {
      if (now - limit.windowStart > threshold) {
        this.limits.delete(key);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.limits.clear();
  }
}
