import { describe, expect, it } from "vitest";

import {
  GALLERY_MAX_DESKTOP,
  selectComposition,
  type CompositionInput,
} from "./select-composition";

const base: CompositionInput = {
  participantCount: 3,
  hasContent: false,
  isPhone: false,
  isLandscape: true,
};

describe("selectComposition", () => {
  it("always yields content-stage when content is shared, regardless of count", () => {
    expect(selectComposition({ ...base, hasContent: true })).toBe("content-stage");
    expect(
      selectComposition({ ...base, hasContent: true, participantCount: 100 }),
    ).toBe("content-stage");
  });

  it("is solo when alone", () => {
    expect(selectComposition({ ...base, participantCount: 1 })).toBe("solo");
  });

  it("uses gallery on phone portrait with exactly 2 people", () => {
    expect(
      selectComposition({ ...base, participantCount: 2, isPhone: true, isLandscape: false }),
    ).toBe("gallery");
    // Desktop 1:1 stays a gallery (two equal tiles).
    expect(selectComposition({ ...base, participantCount: 2 })).toBe("gallery");
    // Phone landscape 1:1 behaves like a small desktop.
    expect(
      selectComposition({ ...base, participantCount: 2, isPhone: true, isLandscape: true }),
    ).toBe("gallery");
  });

  it("switches gallery -> spotlight at the desktop threshold", () => {
    expect(
      selectComposition({ ...base, participantCount: GALLERY_MAX_DESKTOP }),
    ).toBe("gallery");
    expect(
      selectComposition({ ...base, participantCount: GALLERY_MAX_DESKTOP + 1 }),
    ).toBe("spotlight");
  });

  it("gives a phone a gallery of up to three, and the speaker large over a strip from four", () => {
    const phone = { ...base, isPhone: true, isLandscape: false };
    expect(selectComposition({ ...phone, participantCount: 3 })).toBe("gallery");
    expect(selectComposition({ ...phone, participantCount: 4 })).toBe("spotlight");
    expect(selectComposition({ ...phone, participantCount: 100 })).toBe("spotlight");
    expect(selectComposition({ ...phone, isLandscape: true, participantCount: 4 })).toBe("spotlight");
  });
});
