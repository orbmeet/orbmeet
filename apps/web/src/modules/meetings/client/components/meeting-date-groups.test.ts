import { describe, expect, it } from "vitest";
import {
  formatDayLabel,
  formatMeetingTimeRange,
  groupMeetingsByDay,
} from "./meeting-date-groups";

// Fixed "now": Friday 2026-07-10 15:00 local time.
const NOW = new Date(2026, 6, 10, 15, 0);

function iso(year: number, month: number, day: number, hour = 12, minute = 0): string {
  return new Date(year, month, day, hour, minute).toISOString();
}

describe("formatMeetingTimeRange", () => {
  it("formats a same-day range", () => {
    const start = new Date(2026, 6, 10, 6, 58);
    const end = new Date(2026, 6, 10, 7, 0);
    const expected = new Intl.DateTimeFormat([], {
      hour: "numeric",
      minute: "2-digit",
    }).formatRange(start, end);
    expect(formatMeetingTimeRange(start.toISOString(), end.toISOString())).toBe(expected);
  });

  it("appends the end date when the meeting crosses midnight", () => {
    const start = new Date(2026, 6, 9, 23, 13);
    const end = new Date(2026, 6, 10, 1, 2);
    const result = formatMeetingTimeRange(start.toISOString(), end.toISOString());
    const time = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });
    expect(result).toBe(`${time.format(start)} – ${time.format(end)} (${formatDayLabel(end)})`);
  });

  it("falls back to the start time without an end", () => {
    const start = new Date(2026, 6, 10, 6, 58);
    const expected = new Intl.DateTimeFormat([], {
      hour: "numeric",
      minute: "2-digit",
    }).format(start);
    expect(formatMeetingTimeRange(start.toISOString(), null)).toBe(expected);
  });

  it("falls back to the start time when the end is not after the start", () => {
    const start = new Date(2026, 6, 10, 6, 58);
    const expected = new Intl.DateTimeFormat([], {
      hour: "numeric",
      minute: "2-digit",
    }).format(start);
    expect(formatMeetingTimeRange(start.toISOString(), start.toISOString())).toBe(expected);
  });
});

describe("formatDayLabel", () => {
  it("omits the year for the current year and includes it otherwise", () => {
    expect(formatDayLabel(new Date(2026, 6, 8), NOW)).not.toMatch(/2026/);
    expect(formatDayLabel(new Date(2025, 11, 30), NOW)).toMatch(/2025/);
  });
});

describe("groupMeetingsByDay", () => {
  it("groups by calendar day with Today/Yesterday/weekday labels and dates", () => {
    const rows = [
      { id: "a", startedAt: iso(2026, 6, 10, 7) }, // today
      { id: "b", startedAt: iso(2026, 6, 9, 17) }, // yesterday
      { id: "c", startedAt: iso(2026, 6, 9, 8) }, // yesterday
      { id: "d", startedAt: iso(2026, 6, 7, 13) }, // Tuesday
    ];
    const groups = groupMeetingsByDay(rows, NOW);

    expect(groups.map((g) => g.label)).toEqual([
      "Today",
      "Yesterday",
      new Date(2026, 6, 7).toLocaleDateString([], { weekday: "long" }),
    ]);
    expect(groups[1].rows.map((r) => r.id)).toEqual(["b", "c"]);
    for (const group of groups) {
      expect(group.dateLabel).toBeTruthy();
      expect(group.showRowDate).toBe(false);
    }
  });

  it("sends rows older than a week and rows without a start to Earlier, last", () => {
    const rows = [
      { id: "recent", startedAt: iso(2026, 6, 10, 7) },
      { id: "old", startedAt: iso(2026, 5, 12, 9) },
      { id: "unknown", startedAt: null },
    ];
    const groups = groupMeetingsByDay(rows, NOW);
    const last = groups[groups.length - 1];

    expect(last.label).toBe("Earlier");
    expect(last.showRowDate).toBe(true);
    expect(last.rows.map((r) => r.id)).toEqual(["old", "unknown"]);
  });

  it("does not label future calendar days as Today", () => {
    const rows = [
      { id: "today", startedAt: iso(2026, 6, 10, 7) },
      { id: "tomorrow", startedAt: iso(2026, 6, 11, 7) },
      { id: "later", startedAt: iso(2026, 6, 12, 7) },
    ];

    expect(groupMeetingsByDay(rows, NOW).map((group) => group.label)).toEqual([
      "Today",
      "Tomorrow",
      new Date(2026, 6, 12).toLocaleDateString([], { weekday: "long" }),
    ]);
  });

  it("returns no groups for no rows", () => {
    expect(groupMeetingsByDay([], NOW)).toEqual([]);
  });
});
