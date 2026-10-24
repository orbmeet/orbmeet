import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { mathInkRequestSchema, MATHINK_MAX_RAW_POINTS } from "./mathink-contract.ts";

describe("mathInkRequestSchema", () => {
  it("bounds the total point count across all strokes", () => {
    const points = Array.from({ length: MATHINK_MAX_RAW_POINTS / 2 + 1 }, () => [0, 0]);
    expect(v.safeParse(mathInkRequestSchema, { strokes: [points, points] }).success).toBe(false);
  });

  it("accepts a request at the total point limit", () => {
    const points = Array.from({ length: MATHINK_MAX_RAW_POINTS }, () => [0, 0]);
    expect(v.safeParse(mathInkRequestSchema, { strokes: [points] }).success).toBe(true);
  });
});
