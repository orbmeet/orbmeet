import { describe, expect, it } from "vitest";
import { startOfWeek, toDateParam, fromDateParam } from "./calendar-week";

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
});
