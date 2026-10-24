import { describe, expect, it } from "vitest";
import { openingHour, placeDay, startOfWeek, toDateParam, fromDateParam } from "./calendar-week";

const day = new Date(2026, 9, 15);
const at = (h: number, m = 0) => new Date(2026, 9, 15, h, m);

describe("startOfWeek", () => {
  it("is the Monday of the week, whatever day it is given", () => {
    expect(toDateParam(startOfWeek(new Date(2026, 9, 15, 22)))).toBe("2026-10-12");
    expect(toDateParam(startOfWeek(new Date(2026, 9, 18)))).toBe("2026-10-12");
    expect(toDateParam(startOfWeek(new Date(2026, 9, 12)))).toBe("2026-10-12");
  });
});

describe("date params", () => {
  it("round-trips a local date and ignores anything else", () => {
    expect(toDateParam(fromDateParam("2026-10-15", day))).toBe("2026-10-15");
    expect(fromDateParam("15/10/2026", day)).toBe(day);
  });
});

describe("placeDay", () => {
  it("puts overlapping events side by side and lone ones full width", () => {
    const placed = placeDay(
      [
        { id: "a", start: at(6, 33), end: at(7, 31) },
        { id: "b", start: at(7, 0), end: at(8, 0) },
        { id: "c", start: at(9, 0), end: at(9, 30) },
      ],
      day,
    );
    const byId = Object.fromEntries(placed.map((p) => [p.item.id, p]));
    expect([byId.a.lane, byId.a.lanes]).toEqual([0, 2]);
    expect([byId.b.lane, byId.b.lanes]).toEqual([1, 2]);
    expect([byId.c.lane, byId.c.lanes]).toEqual([0, 1]);
  });

  it("gives a two-minute call enough height to read, and clips to the day", () => {
    const [short] = placeDay([{ start: at(9, 24), end: at(9, 26) }], day);
    expect(short.toMinute - short.fromMinute).toBe(20);
    const [late] = placeDay([{ start: at(23, 30), end: new Date(2026, 9, 16, 1) }], day);
    expect(late.toMinute).toBe(24 * 60);
  });
});

describe("openingHour", () => {
  it("opens at the preferred hour unless an event runs across it", () => {
    expect(openingHour([{ start: at(9), end: at(10) }], [day], 7)).toBe(7);
    // Over before the line: above the fold, like any calendar.
    expect(openingHour([{ start: at(3, 11), end: at(3, 14) }], [day], 7)).toBe(7);
    expect(openingHour([{ start: at(6, 33), end: at(7, 31) }], [day], 7)).toBe(6);
  });

  it("only counts events that start on a shown day", () => {
    const yesterday = new Date(2026, 9, 14, 23);
    expect(openingHour([{ start: yesterday, end: at(8) }], [day], 7)).toBe(7);
    expect(openingHour([{ start: at(5), end: at(8) }], [new Date(2026, 9, 16)], 7)).toBe(7);
  });
});
