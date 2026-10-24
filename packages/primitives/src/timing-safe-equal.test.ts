import { describe, expect, it } from "vitest";

import { timingSafeEqual } from "./timing-safe-equal.ts";

describe("timingSafeEqual", () => {
  it("accepts identical strings and rejects differing ones", async () => {
    await expect(timingSafeEqual("secret-value", "secret-value")).resolves.toBe(true);
    await expect(timingSafeEqual("secret-value", "secret-walue")).resolves.toBe(false);
  });

  it("rejects inputs of different lengths", async () => {
    await expect(timingSafeEqual("short", "shorter")).resolves.toBe(false);
    await expect(timingSafeEqual("", "short")).resolves.toBe(false);
    await expect(timingSafeEqual("", "")).resolves.toBe(true);
  });
});
