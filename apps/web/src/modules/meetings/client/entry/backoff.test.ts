import { describe, expect, it } from "vitest";
import { nextBackoffDelay } from "./backoff";

const opts = { baseMs: 5_000, maxMs: 60_000 };

describe("nextBackoffDelay", () => {
  it("resets to base on success", () => {
    expect(nextBackoffDelay(40_000, true, opts)).toBe(5_000);
    expect(nextBackoffDelay(5_000, true, opts)).toBe(5_000);
  });

  it("grows geometrically on consecutive failures", () => {
    let d = opts.baseMs;
    d = nextBackoffDelay(d, false, opts);
    expect(d).toBe(10_000);
    d = nextBackoffDelay(d, false, opts);
    expect(d).toBe(20_000);
    d = nextBackoffDelay(d, false, opts);
    expect(d).toBe(40_000);
  });

  it("caps at maxMs", () => {
    expect(nextBackoffDelay(40_000, false, opts)).toBe(60_000);
    expect(nextBackoffDelay(60_000, false, opts)).toBe(60_000);
  });

  it("starts from at least base when the previous delay was below it", () => {
    expect(nextBackoffDelay(0, false, opts)).toBe(10_000);
  });

  it("honors a custom factor", () => {
    expect(nextBackoffDelay(5_000, false, { ...opts, factor: 3 })).toBe(15_000);
  });
});
