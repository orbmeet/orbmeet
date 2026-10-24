import { describe, expect, it } from "vitest";
import { placeBeside } from "./selection-ask";

const viewport = { w: 1200, h: 800 };

describe("placeBeside", () => {
  it("puts Orb's card to the right of what it is about, then to its left, then under it", () => {
    expect(placeBeside({ x: 100, y: 200, w: 200, h: 50 }, 320, viewport)).toEqual({ left: 312, top: 200 });
    expect(placeBeside({ x: 800, y: 200, w: 300, h: 50 }, 320, viewport)).toEqual({ left: 468, top: 200 });
    expect(placeBeside({ x: 20, y: 100, w: 1160, h: 50 }, 320, viewport)).toEqual({ left: 20, top: 162 });
  });
});
