import { describe, expect, it } from "vitest";
import { formatDuration, formatTimeAgo } from "./format";

describe("ended Meeting formatting", () => {
  it("formats short and long durations", () => {
    expect(formatDuration(null)).toBe("--");
    expect(formatDuration(30)).toBe("< 1 min");
    expect(formatDuration(600)).toBe("10 min");
    expect(formatDuration(3_900)).toBe("1h 5m");
    // A whole number of hours drops the empty minute part.
    expect(formatDuration(3_600)).toBe("1h");
    expect(formatDuration(7_200)).toBe("2h");
  });

  it("formats relative Summary timestamps", () => {
    const now = new Date("2026-05-08T12:00:00Z").getTime();

    expect(formatTimeAgo(null, now)).toBe("");
    expect(formatTimeAgo(new Date("2026-05-08T11:59:30Z"), now)).toBe("just now");
    expect(formatTimeAgo(new Date("2026-05-08T11:45:00Z"), now)).toBe("15m ago");
    expect(formatTimeAgo(new Date("2026-05-08T09:00:00Z"), now)).toBe("3h ago");
  });
});
