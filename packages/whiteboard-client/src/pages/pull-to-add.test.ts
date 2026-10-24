import { describe, expect, it } from "vitest";
import {
  hasPulledPastPageTop,
  isPullToAddPointerGesture,
  isPullToAddReady,
} from "./pull-to-add";

describe("pull to add page", () => {
  it("does not treat a centered page as pulled past the page", () => {
    expect(hasPulledPastPageTop(0, -220, 24)).toBe(false);
  });

  it("requires the viewport top to move past the page top", () => {
    expect(hasPulledPastPageTop(0, 8, 24)).toBe(false);
    expect(hasPulledPastPageTop(0, 25, 24)).toBe(true);
  });

  it("still uses the bottom overscroll threshold for readiness", () => {
    expect(isPullToAddReady(1200, 1339)).toBe(false);
    expect(isPullToAddReady(1200, 1340)).toBe(true);
  });

  it("accepts a page-space threshold converted from a fixed screen pull", () => {
    // 140 screen px at 2x zoom is 70 page units.
    expect(isPullToAddReady(1200, 1269, 70)).toBe(false);
    expect(isPullToAddReady(1200, 1270, 70)).toBe(true);
  });

  it("arms only for upward-dominant pointer movement", () => {
    expect(isPullToAddPointerGesture(0, -32)).toBe(true);
    expect(isPullToAddPointerGesture(40, -32)).toBe(false);
    expect(isPullToAddPointerGesture(0, 40)).toBe(false);
    expect(isPullToAddPointerGesture(0, -12)).toBe(false);
  });
});
