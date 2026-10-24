import { describe, expect, it } from "vitest";
import { coerceSuggestedTimeZone, formatCalendarDay } from "./time-zone";

describe("coerceSuggestedTimeZone", () => {
  it("keeps a usable zone", () => {
    expect(coerceSuggestedTimeZone("Asia/Dhaka")).toBe("Asia/Dhaka");
    expect(coerceSuggestedTimeZone("  Asia/Dhaka  ")).toBe("Asia/Dhaka");
  });

  it("degrades to null rather than throwing on hostile input", () => {
    for (const value of [
      "Nowhere/Nothing",
      "",
      "   ",
      "x".repeat(101),
      null,
      undefined,
      42,
      { toString: () => "Asia/Dhaka" },
    ]) {
      expect(coerceSuggestedTimeZone(value)).toBeNull();
    }
  });
});

describe("formatCalendarDay", () => {
  // 2026-09-13T23:15:45Z is already 2026-09-14 in Dhaka (UTC+6). This is the
  // exact instant that produced a board named "Whiteboard · 2026-09-13" while
  // its own record page was headed September 14.
  const instant = new Date("2026-09-13T23:15:45.000Z");

  it("uses the day the zone is actually having", () => {
    expect(formatCalendarDay(instant, "Asia/Dhaka")).toBe("2026-09-14");
    expect(formatCalendarDay(instant, "UTC")).toBe("2026-09-13");
    expect(formatCalendarDay(instant, "America/Los_Angeles")).toBe("2026-09-13");
  });

  it("falls back to the UTC day when there is no zone", () => {
    expect(formatCalendarDay(instant, null)).toBe("2026-09-13");
  });

  it("falls back rather than throwing on an unusable zone", () => {
    expect(formatCalendarDay(instant, "Nowhere/Nothing")).toBe("2026-09-13");
  });

  it("zero-pads to a sortable ISO day", () => {
    expect(formatCalendarDay(new Date("2026-01-05T12:00:00Z"), "UTC")).toBe(
      "2026-01-05",
    );
  });
});
