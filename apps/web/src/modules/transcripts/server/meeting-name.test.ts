import { describe, expect, it } from "vitest";

import { cleanGeneratedTitle } from "./meeting-name";

describe("cleanGeneratedTitle", () => {
  it("drops wrapping quotes, a closing full stop and extra space", () => {
    expect(cleanGeneratedTitle("  “Solving two-step equations.”  ")).toBe("Solving two-step equations");
  });

  it("refuses something too short to be a name", () => {
    expect(cleanGeneratedTitle(" . ")).toBeNull();
  });

  it("keeps a long name to a row's length", () => {
    const title = cleanGeneratedTitle("word ".repeat(40))!;
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith("…")).toBe(true);
  });
});
