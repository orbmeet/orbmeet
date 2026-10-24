import { describe, expect, it } from "vitest";
import { compareCodeUnitStrings } from "./code-unit-order";

describe("compareCodeUnitStrings", () => {
  it("matches protocol and SQLite BINARY ordering", () => {
    expect(["ä", "z", "Z"].sort(compareCodeUnitStrings)).toEqual([
      "Z",
      "z",
      "ä",
    ]);
    expect(compareCodeUnitStrings("same", "same")).toBe(0);
  });
});
