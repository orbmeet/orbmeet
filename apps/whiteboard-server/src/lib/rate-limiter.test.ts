import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimiter } from "./rate-limiter.ts";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a limited key blocked until the window expires", () => {
    const limiter = new RateLimiter(2, 1000);

    try {
      expect(limiter.check("user-1")).toBe(true);
      expect(limiter.check("user-1")).toBe(true);
      expect(limiter.check("user-1")).toBe(false);

      vi.setSystemTime(999);
      expect(limiter.check("user-1")).toBe(false);

      vi.setSystemTime(1000);
      expect(limiter.check("user-1")).toBe(true);
    } finally {
      limiter.destroy();
    }
  });

  it("applies the byte budget within the same window", () => {
    const limiter = new RateLimiter(100, 1000, { maxBytesPerSecond: 10 });

    try {
      expect(limiter.check("user-1", 6)).toBe(true);
      expect(limiter.check("user-1", 5)).toBe(false);

      vi.setSystemTime(1000);
      expect(limiter.check("user-1", 10)).toBe(true);
      expect(limiter.check("user-1", 11)).toBe(false);
    } finally {
      limiter.destroy();
    }
  });

  it("ignores message sizes when no byte budget is configured", () => {
    const limiter = new RateLimiter(3, 1000);

    try {
      expect(limiter.check("user-1", 10 * 1024 * 1024)).toBe(true);
      expect(limiter.check("user-1", 10 * 1024 * 1024)).toBe(true);
      expect(limiter.check("user-1", 10 * 1024 * 1024)).toBe(true);
      // Still bounded by the message count.
      expect(limiter.check("user-1", 1)).toBe(false);
    } finally {
      limiter.destroy();
    }
  });

  it("admits a single message equal to the whole window budget", () => {
    // The composed invariant the sync server relies on: a message at the
    // assembly ceiling must fit in one fresh window, or it is fatal rather
    // than throttled. See WHITEBOARD_CONFIG.CLIENT_INGRESS_BYTES_PER_SECOND.
    const limiter = new RateLimiter(300, 1000, { maxBytesPerSecond: 1000 });

    try {
      expect(limiter.check("user-1", 1000)).toBe(true);
      expect(limiter.check("user-1", 1)).toBe(false);
    } finally {
      limiter.destroy();
    }
  });

  it("does not charge a reservation unless it is committed", () => {
    const limiter = new RateLimiter(1, 1000);

    try {
      expect(limiter.reserve("user-1")).not.toBeNull();
      // A room-wide limiter can reject after this reservation is made. Dropping
      // it must leave the user's own budget untouched.
      expect(limiter.check("user-1")).toBe(true);
      expect(limiter.check("user-1")).toBe(false);
    } finally {
      limiter.destroy();
    }
  });
});

describe("RateLimiter key bounds", () => {
  it("caps tracked keys, evicting the least-recently-started window", () => {
    const limiter = new RateLimiter(300, 1000, { maxKeys: 3 });

    try {
      for (let i = 0; i < 10; i += 1) {
        expect(limiter.check(`user-${i}`)).toBe(true);
      }
      // Eviction bounds memory; it never rejects the caller being admitted.
      expect(limiter.check("user-9")).toBe(true);
    } finally {
      limiter.destroy();
    }
  });

  it("reclaims expired windows before evicting live ones", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new RateLimiter(2, 1000, { maxKeys: 2 });

    try {
      limiter.check("stale-1");
      limiter.check("stale-2");
      // Both windows have long since rolled over, so admitting a third key
      // sweeps them instead of evicting anything still counting.
      vi.setSystemTime(5_000);
      expect(limiter.check("fresh")).toBe(true);
      expect(limiter.check("fresh")).toBe(true);
      expect(limiter.check("fresh")).toBe(false);
    } finally {
      limiter.destroy();
      vi.useRealTimers();
    }
  });
});

describe("RateLimiter reservations", () => {
  it("charges every committed reservation, even when taken back-to-back", () => {
    const limiter = new RateLimiter(2, 60_000);

    const first = limiter.reserve("user-a");
    const second = limiter.reserve("user-a");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    first!.commit();
    second!.commit();

    expect(limiter.check("user-a")).toBe(false);
    limiter.destroy();
  });

  it("evicts the least-recently-active key at the key cap", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // limit 1: a still-tracked key is refused, an evicted one reads as fresh.
    const limiter = new RateLimiter(1, 1_000, { maxKeys: 2 });

    expect(limiter.check("ip-a")).toBe(true);
    vi.setSystemTime(500);
    expect(limiter.check("ip-b")).toBe(true);
    vi.setSystemTime(1_000);
    expect(limiter.check("ip-a")).toBe(true); // window rolled: ip-a is now most recent
    vi.setSystemTime(1_001);
    expect(limiter.check("ip-c")).toBe(true); // at the cap: evicts ip-b

    expect(limiter.check("ip-a")).toBe(false);
    expect(limiter.check("ip-b")).toBe(true);
    limiter.destroy();
    vi.useRealTimers();
  });

  it("counts refused attempts as activity, so a flooding key is not evicted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new RateLimiter(1, 1_000, { maxKeys: 2 });

    expect(limiter.check("flood")).toBe(true);
    vi.setSystemTime(1);
    expect(limiter.check("other")).toBe(true);
    vi.setSystemTime(2);
    expect(limiter.check("flood")).toBe(false); // refused, but now most recent
    expect(limiter.check("fresh")).toBe(true); // at the cap: evicts "other"

    expect(limiter.check("flood")).toBe(false);
    limiter.destroy();
    vi.useRealTimers();
  });
});
