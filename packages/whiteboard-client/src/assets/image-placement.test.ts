import { describe, expect, it } from "vitest";
import { placeImageOnPage } from "./image-placement";

// A tall page, as a portrait PDF page sits on the board.
const frame = { x: 0, y: 1000, w: 1000, h: 1400 };

describe("placeImageOnPage", () => {
  it("centres on the whole page when there is no view", () => {
    expect(placeImageOnPage({ w: 100, h: 50 }, frame, null)).toEqual({ x: 100, y: 500, w: 800, h: 400 });
  });

  it("centres on the part of the page that is on screen", () => {
    // Only the bottom 600 units of the page are in view.
    const view = { x: -200, y: 1800, w: 1400, h: 900 };
    const placed = placeImageOnPage({ w: 100, h: 50 }, frame, view);
    expect(placed.y).toBeGreaterThanOrEqual(800);
    expect(placed.y + placed.h).toBeLessThanOrEqual(1400);
    expect(placed.y + placed.h / 2).toBeCloseTo(1100);
  });

  it("shrinks a tall image to fit the visible slice", () => {
    const view = { x: 0, y: 1000, w: 1000, h: 500 };
    const placed = placeImageOnPage({ w: 400, h: 1000 }, frame, view);
    expect(placed.h).toBeCloseTo(400);
    expect(placed.w).toBeCloseTo(160);
    expect(placed.y).toBeCloseTo(50);
  });

  it("falls back to the whole page when barely any of it is in view", () => {
    const view = { x: 0, y: 2300, w: 1000, h: 800 };
    expect(placeImageOnPage({ w: 100, h: 50 }, frame, view)).toEqual({ x: 100, y: 500, w: 800, h: 400 });
  });

  it("keeps a cascaded image on its page", () => {
    const placed = placeImageOnPage({ w: 100, h: 50 }, frame, null, 400);
    expect(placed.x + placed.w).toBeLessThanOrEqual(frame.w);
    expect(placed.y + placed.h).toBeLessThanOrEqual(frame.h);
  });
});
