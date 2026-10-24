import { describe, expect, it } from "vitest";
import { normalizeMicrophoneLevel } from "./microphone-level-meter";

describe("normalizeMicrophoneLevel", () => {
  it("suppresses the ambient noise floor", () => {
    expect(normalizeMicrophoneLevel(0)).toBe(0);
    expect(normalizeMicrophoneLevel(0.008)).toBe(0);
  });

  it("scales normal speech into the visible meter range", () => {
    expect(normalizeMicrophoneLevel(0.058)).toBeCloseTo(0.5);
  });

  it("clamps loud input to the meter maximum", () => {
    expect(normalizeMicrophoneLevel(1)).toBe(1);
  });
});
