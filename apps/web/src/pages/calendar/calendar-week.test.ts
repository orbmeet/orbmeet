import { describe, expect, it } from "vitest";
import { startOfWeek, toDateParam, fromDateParam, occursOnDay } from "./calendar-week";

const day = new Date(2026, 9, 15);

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

  it("ignores a date that does not exist rather than rolling it over", () => {
    expect(fromDateParam("2026-02-31", day)).toBe(day);
    expect(fromDateParam("2026-13-01", day)).toBe(day);
    expect(toDateParam(fromDateParam("2028-02-29", day))).toBe("2028-02-29");
  });
});

describe("occursOnDay", () => {
  const at = (date: number, hour: number, minute = 0) => new Date(2026, 9, date, hour, minute);

  it("puts an event on the day it starts", () => {
    expect(occursOnDay(at(15, 9), at(15, 10), day)).toBe(true);
    expect(occursOnDay(at(16, 9), at(16, 10), day)).toBe(false);
    expect(occursOnDay(at(15, 9), at(15, 9), day)).toBe(true);
  });

  it("keeps a meeting that runs past midnight on the next day too", () => {
    expect(occursOnDay(at(14, 23, 30), at(15, 0, 45), day)).toBe(true);
    expect(occursOnDay(at(14, 23, 30), at(15, 0, 45), new Date(2026, 9, 14))).toBe(true);
  });

  it("leaves a meeting that ends exactly at midnight off the next day", () => {
    expect(occursOnDay(at(14, 23), at(15, 0), day)).toBe(false);
  });
});
