import { describe, expect, it } from "vitest";

import { describeWhiteboardActivity, formatActivityDay } from "./whiteboard-activity";

const now = new Date(2026, 9, 12, 15, 0);

describe("formatActivityDay", () => {
  it("says today and yesterday in words, and other days as a short date", () => {
    expect(formatActivityDay(new Date(2026, 9, 12, 8, 3).toISOString(), now)).toBe("today");
    expect(formatActivityDay(new Date(2026, 9, 11, 23, 0).toISOString(), now)).toBe("yesterday");
    expect(formatActivityDay(new Date(2026, 9, 9).toISOString(), now)).not.toMatch(/\d+\/\d+\/\d+/);
  });
});

describe("describeWhiteboardActivity", () => {
  it("names where a board was last used", () => {
    expect(
      describeWhiteboardActivity(
        { lastUsedAt: new Date(2026, 9, 12).toISOString(), lastUsedIn: "Calculus", updatedAt: new Date(2026, 9, 1).toISOString() },
        now,
      ),
    ).toBe("Last used in Calculus · today");
  });

  it("falls back to when it was edited", () => {
    expect(
      describeWhiteboardActivity({ lastUsedAt: null, lastUsedIn: null, updatedAt: new Date(2026, 9, 11).toISOString() }, now),
    ).toBe("Edited yesterday");
  });
});
