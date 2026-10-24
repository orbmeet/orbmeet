import { describe, expect, it } from "vitest";
import { formatClock } from "./format-duration";

describe("formatClock", () => {
  it("formats finite elapsed durations", () => {
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(3_661)).toBe("1:01:01");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "renders non-finite input as zero",
    (value) => expect(formatClock(value)).toBe("0:00"),
  );
});
