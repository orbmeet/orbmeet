import { describe, expect, it } from "vitest";
import { handDrawn, inkPath, roughSquiggle } from "./landing-film-ink";

describe("handDrawn", () => {
  it("samples a line every six units and ends near its last point", () => {
    const points = handDrawn([[0, 0], [60, 0]], 1, 0);
    expect(points).toHaveLength(11);
    expect(points.at(-1)).toEqual([60, 0]);
  });

  it("gives the same line for the same seed, so a replay matches", () => {
    expect(handDrawn([[0, 0], [90, 30]], 7, 1.2)).toEqual(handDrawn([[0, 0], [90, 30]], 7, 1.2));
  });
});

describe("inkPath", () => {
  it("draws nothing until there is a segment", () => {
    expect(inkPath([], 3)).toBe("");
    expect(inkPath([[4, 4]], 3)).toBe("");
  });

  it("closes the outline", () => {
    const d = inkPath(handDrawn([[0, 0], [60, 0]], 1, 0), 4);
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
  });
});

describe("roughSquiggle", () => {
  it("alternates above and below its line", () => {
    const [first, second] = roughSquiggle(0, 40, 100);
    expect(first[1]).toBe(105);
    expect(second[1]).toBe(95);
  });
});
