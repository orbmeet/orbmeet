import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatMeetingDate,
  formatMeetingDuration,
  formatMeetingLength,
  meetingDisplayTitle,
  peopleInMeeting,
} from "./meeting-format";

function span(minutes: number): [string, string] {
  const start = new Date("2026-09-09T10:00:00Z");
  const end = new Date(start.getTime() + minutes * 60_000);
  return [start.toISOString(), end.toISOString()];
}

describe("meeting row duration", () => {
  it("reads a whole number of hours without an empty minute part", () => {
    expect(formatMeetingDuration(...span(60))).toBe("1h");
    expect(formatMeetingDuration(...span(120))).toBe("2h");
  });

  it("keeps the minute part when there is one", () => {
    expect(formatMeetingDuration(...span(25))).toBe("25m");
    expect(formatMeetingDuration(...span(85))).toBe("1h 25m");
  });

  it("floors anything under a minute", () => {
    expect(formatMeetingDuration(...span(0.5))).toBe("< 1m");
  });

  it("returns nothing for a Meeting that has not ended", () => {
    expect(formatMeetingDuration("2026-09-09T10:00:00Z", null)).toBe("");
    expect(formatMeetingDuration(null, null)).toBe("");
  });
});

describe("peopleInMeeting", () => {
  it("counts people in a live meeting", () => {
    expect(peopleInMeeting(1)).toBe("1 person in it");
    expect(peopleInMeeting(3)).toBe("3 people in it");
  });
});

describe("formatMeetingDate", () => {
  const originalTimeZone = process.env.TZ;
  afterEach(() => {
    vi.useRealTimers();
    process.env.TZ = originalTimeZone;
  });

  it("calls the calendar day before today Yesterday, across a daylight-saving change", () => {
    process.env.TZ = "America/New_York";
    // Clocks went forward on Sunday 8 March 2026, a 23-hour day. Half an hour
    // into Monday, 24 hours ago is still Saturday.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 9, 0, 30));

    expect(formatMeetingDate(new Date(2026, 2, 8, 12, 0).toISOString())).toBe("Yesterday");
    expect(formatMeetingDate(new Date(2026, 2, 9, 0, 10).toISOString())).toBe("Today");
    expect(formatMeetingDate(new Date(2026, 2, 7, 23, 50).toISOString())).not.toBe("Yesterday");
  });
});

describe("formatMeetingLength", () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 15, 6, 0) + minutes * 60_000).toISOString();
  it("spells a length out in minutes and hours", () => {
    expect(formatMeetingLength(at(0), at(57))).toBe("57 min");
    expect(formatMeetingLength(at(0), at(76))).toBe("1 h 16 min");
    expect(formatMeetingLength(at(0), at(120))).toBe("2 h");
    expect(formatMeetingLength(at(0), at(0))).toBe("< 1 min");
    expect(formatMeetingLength(at(0), null)).toBe("");
  });
});

describe("meetingDisplayTitle", () => {
  it("keeps a meeting's own title", () => {
    expect(meetingDisplayTitle("  Practicing divisibility ", ["Atiq Rahman", "Orion Ray"], "Atiq Rahman")).toBe(
      "Practicing divisibility",
    );
  });
  it("names an untitled meeting by who else was there", () => {
    expect(meetingDisplayTitle(null, ["Atiq Rahman", "Test"], "Atiq Rahman")).toBe("Call with Test");
    expect(meetingDisplayTitle("", ["Atiq Rahman", "Orion Ray", "Hindol Chowdhury"], "Atiq Rahman")).toBe(
      "Call with Orion and Hindol",
    );
    expect(meetingDisplayTitle(null, ["A", "B", "C", "D"], "A")).toBe("Call with B and 2 others");
    expect(meetingDisplayTitle(null, ["Atiq Rahman"], "Atiq Rahman")).toBe("Call on your own");
  });
});
