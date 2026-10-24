import { describe, expect, it } from "vitest";

import { formatInTimeZone, minutesBetween, parseDurationMinutes, wallClockToIso } from "./time.ts";

describe("wallClockToIso", () => {
  it("converts a wall clock time in a named zone", () => {
    expect(wallClockToIso("2026-07-20 10:00", "America/New_York")).toBe("2026-07-20T14:00:00.000Z");
    expect(wallClockToIso("2026-01-20T10:00", "America/New_York")).toBe("2026-01-20T15:00:00.000Z");
  });

  it("passes ISO instants and offsets through unchanged", () => {
    expect(wallClockToIso("2026-07-20T10:00:00Z", "America/New_York")).toBe("2026-07-20T10:00:00.000Z");
    expect(wallClockToIso("2026-07-20T10:00+06:00", "Asia/Dhaka")).toBe("2026-07-20T04:00:00.000Z");
  });

  it("rejects wall clock times skipped by DST", () => {
    expect(() => wallClockToIso("2026-03-08 02:30", "America/New_York"))
      .toThrow("does not exist");
  });

  it("resolves ambiguous DST fall-back times to a matching instant", () => {
    const iso = wallClockToIso("2026-11-01 01:30", "America/New_York");
    const observed = formatInTimeZone(new Date(iso), "America/New_York");
    expect(observed).toEqual({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 });
  });

  it("rejects malformed values, including bad offset strings", () => {
    expect(() => wallClockToIso("2026-07-20", "UTC")).toThrow("--at must be");
    expect(() => wallClockToIso("2026-07-20 10:00:30", "UTC")).toThrow("--at must be");
    expect(() => wallClockToIso("garbage+05:00", "UTC")).toThrow("--at must be");
  });

  it("rejects an impossible calendar date instead of rolling it over", () => {
    expect(() => wallClockToIso("2027-02-29T10:00:00Z", "UTC")).toThrow("--at must be");
    expect(() => wallClockToIso("2027-04-31T10:00:00+06:00", "UTC")).toThrow("--at must be");
    expect(() => wallClockToIso("2027-02-28T24:30Z", "UTC")).toThrow("--at must be");
    expect(wallClockToIso("2028-02-29T10:00:00.250Z", "UTC")).toBe("2028-02-29T10:00:00.250Z");
  });
});

describe("parseDurationMinutes", () => {
  it("falls back when no value is given", () => {
    expect(parseDurationMinutes(undefined, 45)).toBe(45);
  });

  it("accepts whole minutes within the API bounds", () => {
    expect(parseDurationMinutes("15", 30)).toBe(15);
    expect(parseDurationMinutes("1440", 30)).toBe(1440);
  });

  it("rejects zero, fractions, out-of-range, and non-numeric values", () => {
    for (const value of ["0", "14", "1441", "30.5", "abc", ""]) {
      expect(() => parseDurationMinutes(value, 30)).toThrow("--duration must be");
    }
  });

  it("validates the fallback too", () => {
    expect(() => parseDurationMinutes(undefined, Number.NaN)).toThrow("--duration must be");
  });
});

describe("minutesBetween", () => {
  it("derives a meeting's duration from its bounds", () => {
    expect(minutesBetween("2026-07-20T14:00:00.000Z", "2026-07-20T15:30:00.000Z")).toBe(90);
  });
});
