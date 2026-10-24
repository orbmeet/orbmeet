import { describe, expect, it } from "vitest";
import { classifyViewport } from "./responsive";

describe("classifyViewport", () => {
  it("uses the same phone-landscape cutoff throughout the product", () => {
    expect(classifyViewport({ width: 844, height: 490 }).isPhone).toBe(true);
    expect(classifyViewport({ width: 844, height: 500 }).isPhone).toBe(false);
  });

  it("keeps narrow portrait tablets on compact meeting chrome", () => {
    const viewport = classifyViewport({ width: 768, height: 1024 });
    expect(viewport.mode).toBe("tablet");
    expect(viewport.isNarrow).toBe(true);
    expect(viewport.useBottomSheet).toBe(true);
  });

});
