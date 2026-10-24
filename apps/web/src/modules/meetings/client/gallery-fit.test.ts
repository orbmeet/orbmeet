import { describe, expect, it } from "vitest";
import { fitGallery, getPhoneGridLayout, MAX_TILE_ASPECT, MIN_TILE_ASPECT, getAvatarTileScale } from "./gallery-fit";

/** The stage a 1552×877 desktop window leaves once its chrome is subtracted. */
const DESKTOP = { width: 1504, height: 725, gap: 16 };

function coverage(fit: { columns: number; rows: number; tileWidth: number; tileHeight: number }) {
  const used =
    (fit.columns * fit.tileWidth + (fit.columns - 1) * DESKTOP.gap) *
    (fit.rows * fit.tileHeight + (fit.rows - 1) * DESKTOP.gap);
  return used / (DESKTOP.width * DESKTOP.height);
}

describe("fitGallery", () => {
  it("gives one participant most of the stage", () => {
    const fit = fitGallery({ count: 1, ...DESKTOP });
    expect(fit).toMatchObject({ columns: 1, rows: 1 });
    expect(fit.tileHeight).toBe(DESKTOP.height);
    expect(coverage(fit)).toBeGreaterThan(0.85);
  });

  // This is the layout from the screenshot that started all this: two people,
  // two 16:9 tiles across the middle, ~40% of the stage empty above and below.
  it("sets two people side by side, as tall as a tile can be without cropping a camera past 4:3", () => {
    const fit = fitGallery({ count: 2, ...DESKTOP });
    expect(fit).toMatchObject({ columns: 2, rows: 1 });
    expect(fit.tileWidth / fit.tileHeight).toBeCloseTo(4 / 3, 2);
    expect(coverage(fit)).toBeGreaterThan(0.75);
  });

  it("sets three people on a laptop as two rows of wide tiles, not one row of squares", () => {
    const fit = fitGallery({ count: 3, width: 1790, height: 850, gap: 16 });
    expect(fit).toMatchObject({ columns: 2, rows: 2 });
    expect(fit.tileWidth / fit.tileHeight).toBeGreaterThan(1.7);
  });

  it("never draws a tile outside the readable aspect range", () => {
    for (let count = 1; count <= 25; count += 1) {
      const fit = fitGallery({ count, ...DESKTOP });
      const aspect = fit.tileWidth / fit.tileHeight;
      expect(aspect).toBeGreaterThanOrEqual(MIN_TILE_ASPECT - 0.01);
      expect(aspect).toBeLessThanOrEqual(MAX_TILE_ASPECT + 0.01);
    }
  });

  it("keeps every tile inside the space it was given", () => {
    for (let count = 1; count <= 25; count += 1) {
      const fit = fitGallery({ count, ...DESKTOP });
      expect(fit.columns * fit.rows).toBeGreaterThanOrEqual(count);
      expect(fit.columns * fit.tileWidth + (fit.columns - 1) * DESKTOP.gap).toBeLessThanOrEqual(
        DESKTOP.width,
      );
      expect(fit.rows * fit.tileHeight + (fit.rows - 1) * DESKTOP.gap).toBeLessThanOrEqual(
        DESKTOP.height,
      );
    }
  });

  // A camera frame is landscape. A tile taller than it is wide can only be a
  // crop of the middle of that frame, so the fit letterboxes instead.
  it("never draws a portrait tile out of a landscape camera", () => {
    for (const [width, height] of [
      [600, 900],
      [700, 1200],
      [1504, 725],
    ] as const) {
      for (let count = 1; count <= 6; count += 1) {
        const fit = fitGallery({ count, width, height, gap: 16 });
        expect(fit.tileWidth).toBeGreaterThanOrEqual(fit.tileHeight - 1);
      }
    }
  });

  it("stacks rather than splits when the stage is tall and narrow", () => {
    // A portrait-ish window: two side-by-side tiles would be tiny, so the
    // column count that wins is one.
    const fit = fitGallery({ count: 2, width: 600, height: 900, gap: 16 });
    expect(fit).toMatchObject({ columns: 1, rows: 2 });
  });

  it("prefers the arrangement with no empty cells when tiles come out the same size", () => {
    // 4 people on a square stage: 2×2 leaves nothing empty.
    const fit = fitGallery({ count: 4, width: 900, height: 900, gap: 16 });
    expect(fit).toMatchObject({ columns: 2, rows: 2 });
  });

  it("returns an empty fit before the stage has been measured", () => {
    expect(fitGallery({ count: 3, width: 0, height: 0, gap: 16 })).toEqual({
      columns: 1,
      rows: 0,
      tileWidth: 0,
      tileHeight: 0,
    });
    expect(fitGallery({ count: 0, ...DESKTOP }).tileWidth).toBe(0);
  });
});

describe("getPhoneGridLayout", () => {
  it("stacks two portrait tiles and pairs them in landscape", () => {
    expect(getPhoneGridLayout(2, false)).toEqual({ columns: 1, gap: 4 });
    expect(getPhoneGridLayout(2, true)).toEqual({ columns: 2, gap: 4 });
    expect(getPhoneGridLayout(3, true)).toEqual({ columns: 3, gap: 4 });
    expect(getPhoneGridLayout(1, false)).toEqual({ columns: 1, gap: 0 });
  });
});

describe("getAvatarTileScale", () => {
  it("scales the avatar with the tile the fit produced", () => {
    // The two-person tablet gallery from the bug report: a 558px square tile
    // that used to draw a 64px avatar in it.
    const big = getAvatarTileScale(558);
    expect(big.avatarPx).toBeGreaterThan(100);
    expect(big.avatarPx).toBeLessThanOrEqual(168);
    expect(big.namePx).toBeGreaterThan(14);

    const small = getAvatarTileScale(180);
    expect(small.avatarPx).toBeLessThan(big.avatarPx);
  });

  it("clamps both ends so a crowded grid stays legible and a solo tile is not a wall", () => {
    expect(getAvatarTileScale(60).avatarPx).toBe(56);
    expect(getAvatarTileScale(4000).avatarPx).toBe(168);
  });

  it("falls back to the fixed sizes when there is no measurement", () => {
    // Phones fill rather than fit, and the first frame has no observation yet.
    for (const unmeasured of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(getAvatarTileScale(unmeasured)).toEqual({
        avatarPx: 64,
        namePx: 14,
        statePx: 12,
      });
    }
  });

  it("keeps the name and state line in proportion to the avatar", () => {
    const { avatarPx, namePx, statePx } = getAvatarTileScale(400);
    expect(namePx).toBeLessThan(avatarPx);
    expect(statePx).toBeLessThan(namePx);
  });
});
