export class ReceiverRateLimiter {
  private windows = new Map<string, number[]>();
  private lastPrunedAt = 0;

  constructor(
    private maxRate = 10,
    private windowMs = 1000
  ) {}

  shouldAllow(senderId: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let timestamps = this.windows.get(senderId);
    if (!timestamps) {
      this.windows.set(senderId, [now]);
      return true;
    }

    // Drop timestamps outside the sliding window
    const firstValid = timestamps.findIndex((t) => t > cutoff);
    if (firstValid > 0) timestamps = timestamps.slice(firstValid);
    else if (firstValid === -1) timestamps = [];

    if (timestamps.length >= this.maxRate) {
      this.windows.set(senderId, timestamps);
      return false;
    }

    timestamps.push(now);
    this.windows.set(senderId, timestamps);

    if (this.windows.size > 50 && now - this.lastPrunedAt > 10_000) {
      this.lastPrunedAt = now;
      for (const [k, v] of this.windows) {
        if (v.length === 0 || v[v.length - 1] < cutoff) this.windows.delete(k);
      }
    }

    return true;
  }
}
