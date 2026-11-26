import { describe, expect, it } from "vitest";
import {
  currentTimeZoneName,
  formatInTimeZone,
  isValidTimeZone,
  resolveWallClockToIso,
} from "./time-zone.ts";

function offsetsIn2026(zone: string): string[] {
  return [0, 6].map((month) =>
    new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(Date.UTC(2026, month, 1))
      .find((part) => part.type === "timeZoneName")!.value,
  );
}

describe("currentTimeZoneName", () => {
  it("renames V8's legacy spellings", () => {
    expect(currentTimeZoneName("Asia/Calcutta")).toBe("Asia/Kolkata");
    expect(currentTimeZoneName("Europe/Kiev")).toBe("Europe/Kyiv");
  });

  it("leaves a current name, and anything unknown, as it is", () => {
    expect(currentTimeZoneName("Asia/Dhaka")).toBe("Asia/Dhaka");
    expect(currentTimeZoneName("Indian/Cocos")).toBe("Indian/Cocos");
    expect(currentTimeZoneName("toString")).toBe("toString");
  });

  it("only ever swaps one spelling of a zone for another", () => {
    for (const zone of Intl.supportedValuesOf("timeZone")) {
      const current = currentTimeZoneName(zone);
      if (current === zone) continue;
      expect({ zone, current, valid: isValidTimeZone(current) }).toEqual({ zone, current, valid: true });
      expect({ zone, offsets: offsetsIn2026(current) }).toEqual({ zone, offsets: offsetsIn2026(zone) });
      expect(currentTimeZoneName(current)).toBe(current);
    }
  });
});

describe("formatInTimeZone", () => {
  it("extracts 24-hour wall-clock fields in the target time zone", () => {
    expect(formatInTimeZone(new Date("2026-07-20T14:00:00.000Z"), "America/New_York")).toEqual({
      year: 2026,
      month: 7,
      day: 20,
      hour: 10,
      minute: 0,
    });
    expect(formatInTimeZone(new Date("2026-01-01T00:05:00.000Z"), "UTC")).toEqual({
      year: 2026,
      month: 1,
      day: 1,
      hour: 0,
      minute: 5,
    });
    expect(formatInTimeZone(new Date("2026-07-20T18:30:00.000Z"), "Asia/Dhaka")).toEqual({
      year: 2026,
      month: 7,
      day: 21,
      hour: 0,
      minute: 30,
    });
  });
});

describe("resolveWallClockToIso", () => {
  it("resolves standard and daylight-saving wall-clock times", () => {
    expect(
      resolveWallClockToIso({ year: 2026, month: 7, day: 20, hour: 10, minute: 0 }, "America/New_York"),
    ).toBe("2026-07-20T14:00:00.000Z");
    expect(
      resolveWallClockToIso({ year: 2026, month: 1, day: 20, hour: 10, minute: 0 }, "America/New_York"),
    ).toBe("2026-01-20T15:00:00.000Z");
    expect(
      resolveWallClockToIso({ year: 2026, month: 7, day: 20, hour: 10, minute: 0 }, "Asia/Dhaka"),
    ).toBe("2026-07-20T04:00:00.000Z");
    // Half-hour / 45-minute offset zones
    expect(
      resolveWallClockToIso({ year: 2026, month: 7, day: 20, hour: 10, minute: 15 }, "Asia/Kathmandu"),
    ).toBe("2026-07-20T04:30:00.000Z");
  });

  it("returns null for times skipped by a DST spring-forward gap", () => {
    expect(
      resolveWallClockToIso({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, "America/New_York"),
    ).toBeNull();
    expect(
      resolveWallClockToIso({ year: 2026, month: 3, day: 29, hour: 1, minute: 15 }, "Europe/London"),
    ).toBeNull();
  });

  it("resolves ambiguous DST fall-back times to an instant with the matching wall clock", () => {
    const iso = resolveWallClockToIso(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
      "America/New_York",
    );
    expect(iso).not.toBeNull();
    expect(formatInTimeZone(new Date(iso!), "America/New_York")).toEqual({
      year: 2026,
      month: 11,
      day: 1,
      hour: 1,
      minute: 30,
    });
  });

  it("returns null for impossible calendar dates instead of rolling them over", () => {
    expect(
      resolveWallClockToIso({ year: 2027, month: 2, day: 29, hour: 10, minute: 0 }, "UTC"),
    ).toBeNull();
    expect(
      resolveWallClockToIso({ year: 2026, month: 4, day: 31, hour: 10, minute: 0 }, "UTC"),
    ).toBeNull();
  });
});
