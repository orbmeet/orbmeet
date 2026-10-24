import { describe, expect, it } from "vitest";

import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import {
  computeCompactedFrameYs,
  computeFrameShift,
  computeInsertionY,
  findLooseShapeOwnerIndex,
  type FrameGeometry,
} from "./page-geometry.ts";

const { PAGE_HEIGHT, PAGE_SPACING } = WHITEBOARD_CONFIG;
const STRIDE = PAGE_HEIGHT + PAGE_SPACING;

function tightFrames(count: number): FrameGeometry[] {
  return Array.from({ length: count }, (_, i) => ({
    y: i * STRIDE,
    height: PAGE_HEIGHT,
  }));
}

describe("computeFrameShift", () => {
  it("shifts by count page strides", () => {
    expect(computeFrameShift(0)).toBe(0);
    expect(computeFrameShift(1)).toBe(STRIDE);
    expect(computeFrameShift(3)).toBe(3 * STRIDE);
  });

  it("uses supplied dimensions over the defaults", () => {
    expect(computeFrameShift(2, { height: 100, spacing: 10 })).toBe(220);
  });
});

describe("computeInsertionY", () => {
  it("returns 0 for an empty document", () => {
    expect(computeInsertionY([], 0)).toBe(0);
  });

  it("returns the existing frame's top when inserting before it", () => {
    const frames = tightFrames(3);
    expect(computeInsertionY(frames, 0)).toBe(0);
    expect(computeInsertionY(frames, 1)).toBe(STRIDE);
    expect(computeInsertionY(frames, 2)).toBe(2 * STRIDE);
  });

  it("appends just below the last frame using its measured height", () => {
    const frames: FrameGeometry[] = [
      { y: 0, height: PAGE_HEIGHT },
      { y: STRIDE, height: 2000 }, // e.g. a tall PDF-import frame
    ];
    expect(computeInsertionY(frames, frames.length)).toBe(STRIDE + 2000 + PAGE_SPACING);
  });
});

describe("computeCompactedFrameYs", () => {
  it("leaves a tight stack where it is", () => {
    expect(computeCompactedFrameYs(tightFrames(3))).toEqual([0, STRIDE, 2 * STRIDE]);
  });

  it("closes the gap a deleted page left", () => {
    const [first, , third] = tightFrames(3);
    expect(computeCompactedFrameYs([first, third])).toEqual([0, STRIDE]);
  });

  it("stacks each page under the real height of the one above it", () => {
    // A PDF page imported at its own height pushes the next page down by that height.
    const frames = [{ y: 0, height: 1_000 }, { y: 5_000, height: PAGE_HEIGHT }];
    expect(computeCompactedFrameYs(frames)).toEqual([0, 1_000 + PAGE_SPACING]);
  });

  it("is empty for an empty board", () => {
    expect(computeCompactedFrameYs([])).toEqual([]);
  });
});

describe("findLooseShapeOwnerIndex", () => {
  // 0..900, 940..1840, 1880..2780 for the default 900/40 layout.
  const frames = [
    { y: 0, height: PAGE_HEIGHT },
    { y: STRIDE, height: PAGE_HEIGHT },
    { y: 2 * STRIDE, height: PAGE_HEIGHT },
  ];

  it("attributes a center inside a page to that page", () => {
    expect(findLooseShapeOwnerIndex(frames, 0)).toBe(0);
    expect(findLooseShapeOwnerIndex(frames, 450)).toBe(0);
    expect(findLooseShapeOwnerIndex(frames, STRIDE + 450)).toBe(1);
    expect(findLooseShapeOwnerIndex(frames, 2 * STRIDE + 899)).toBe(2);
  });

  it("attributes a center in the gap below a page to that page", () => {
    expect(findLooseShapeOwnerIndex(frames, PAGE_HEIGHT + 10)).toBe(0);
    expect(findLooseShapeOwnerIndex(frames, STRIDE - 1)).toBe(0);
  });

  it("gives the next page ownership from its own top edge", () => {
    expect(findLooseShapeOwnerIndex(frames, STRIDE)).toBe(1);
  });

  it("leaves a center above the first page unowned", () => {
    expect(findLooseShapeOwnerIndex(frames, -1)).toBe(-1);
    expect(findLooseShapeOwnerIndex([], 0)).toBe(-1);
  });

  it("hands ownership downward monotonically and never past the last page", () => {
    let previous = -1;
    for (let centerY = -50; centerY < 3 * STRIDE + 200; centerY += 7) {
      const owner = findLooseShapeOwnerIndex(frames, centerY);
      expect(owner).toBeGreaterThanOrEqual(previous);
      expect(owner).toBeLessThan(frames.length);
      previous = owner;
    }
    expect(previous).toBe(frames.length - 1);
  });

  // The binary search must agree with the linear reading of the same rule for
  // every layout, including the ragged frame heights a PDF import produces.
  it("matches a linear scan on ragged layouts", () => {
    const ragged = [
      { y: 0, height: 300 },
      { y: 340, height: 1500 },
      { y: 1880, height: 200 },
    ];
    const linear = (centerY: number) => {
      let owner = -1;
      for (let i = 0; i < ragged.length; i += 1) {
        if (ragged[i].y > centerY) break;
        owner = i;
      }
      return owner;
    };
    for (let centerY = -20; centerY < 2200; centerY += 3) {
      expect(findLooseShapeOwnerIndex(ragged, centerY)).toBe(linear(centerY));
    }
  });
});

// The whole point of the shared module: client (PageManager, measured frame
// heights from the editor) and server (room-manager, props.h on records) must
// derive identical insertion points and shifts from the same layout. These
// mirror how each caller maps its own frame type into FrameGeometry.
describe("client/server parity", () => {
  it("agrees on insertion Y and shift for the same layout", () => {
    const clientPages = [
      { id: "a", number: 1, y: 0, height: PAGE_HEIGHT },
      { id: "b", number: 2, y: STRIDE, height: PAGE_HEIGHT },
      { id: "c", number: 3, y: 2 * STRIDE, height: PAGE_HEIGHT },
    ];
    const serverFrames = clientPages.map((p) => ({ y: p.y, height: p.height }));

    for (let insertIndex = 0; insertIndex <= clientPages.length; insertIndex += 1) {
      expect(computeInsertionY(clientPages, insertIndex)).toBe(
        computeInsertionY(serverFrames, insertIndex)
      );
    }
    expect(computeFrameShift(1)).toBe(STRIDE);
  });
});
