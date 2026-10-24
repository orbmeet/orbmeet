import { afterEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "./with-timeout";

afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  it("clears its timer when a factory throws synchronously", async () => {
    vi.useFakeTimers();
    const factory = (() => {
      throw new Error("synchronous setup failure");
    }) as (signal: AbortSignal) => Promise<never>;

    await expect(withTimeout(factory, 10_000))
      .rejects.toThrow("synchronous setup failure");
    expect(vi.getTimerCount()).toBe(0);
  });
});
