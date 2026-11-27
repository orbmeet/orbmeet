import { afterEach, describe, expect, it, vi } from "vitest";
import { sinceFor } from "./library-search";

describe("sinceFor", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("starts at the same instant wherever it is computed", () => {
    const now = Date.UTC(2026, 10, 27, 3, 30);
    const at = (zone: string) => {
      vi.stubEnv("TZ", zone);
      return sinceFor("week", now);
    };
    const utc = at("UTC");
    expect(utc).toBe(Date.UTC(2026, 10, 20));
    expect(at("America/Los_Angeles")).toBe(utc);
    expect(at("Asia/Dhaka")).toBe(utc);
  });

  it("is absent for any time", () => {
    expect(sinceFor(undefined)).toBeUndefined();
  });
});
