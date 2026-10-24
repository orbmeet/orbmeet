import { describe, expect, it } from "vitest";

import {
  localDateInTimeZone,
  utcBoundsForLocalDate,
} from "./local-date-bounds";

describe("UTC bounds for a local calendar date", () => {
  it.each([
    ["2026-07-18", "Asia/Dhaka", "2026-07-17T18:00:00.000Z", "2026-07-18T18:00:00.000Z"],
    ["2026-07-18", "Pacific/Kiritimati", "2026-07-17T10:00:00.000Z", "2026-07-18T10:00:00.000Z"],
    ["2026-07-18", "America/Adak", "2026-07-18T09:00:00.000Z", "2026-07-19T09:00:00.000Z"],
  ])("resolves %s in %s", (date, timeZone, earliest, latest) => {
    const bounds = utcBoundsForLocalDate(date, timeZone);
    expect(bounds.earliest.toISOString()).toBe(earliest);
    expect(bounds.latest.toISOString()).toBe(latest);
  });

  it("tracks unequal day lengths across DST changes", () => {
    const spring = utcBoundsForLocalDate("2026-03-08", "America/New_York");
    const fall = utcBoundsForLocalDate("2026-11-01", "America/New_York");
    expect(spring.latest.getTime() - spring.earliest.getTime()).toBe(23 * 60 * 60 * 1_000);
    expect(fall.latest.getTime() - fall.earliest.getTime()).toBe(25 * 60 * 60 * 1_000);
  });

  it("returns an empty interval for a calendar date skipped by a zone", () => {
    const bounds = utcBoundsForLocalDate("2011-12-30", "Pacific/Apia");
    expect(bounds.earliest).toEqual(bounds.latest);
  });

  it("places the exact millisecond boundaries on adjacent local dates", () => {
    const date = "2026-11-01";
    const timeZone = "America/New_York";
    const bounds = utcBoundsForLocalDate(date, timeZone);
    expect(localDateInTimeZone(bounds.earliest, timeZone)).toBe(date);
    expect(localDateInTimeZone(new Date(bounds.latest.getTime() - 1), timeZone)).toBe(date);
    expect(localDateInTimeZone(bounds.latest, timeZone)).toBe("2026-11-02");
  });
});
