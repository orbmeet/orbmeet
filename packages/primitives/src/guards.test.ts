import { describe, expect, it } from "vitest";
import { clamp, isRecord } from "./guards.ts";

describe("isRecord", () => {
  it("accepts plain objects only", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    for (const value of [null, undefined, [], "x", 1, true]) expect(isRecord(value)).toBe(false);
  });
});

describe("clamp", () => {
  it("holds a value within its bounds", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});
