import { describe, expect, it } from "vitest";
import { nextScreenContent } from "./screen-share-content";

describe("nextScreenContent", () => {
  it("stays on detail for slides, which capture a few frames a second", () => {
    expect(nextScreenContent("detail", [1, 3, 0, 2, 1])).toBe("detail");
  });

  it("turns to motion once a video has played for three seconds", () => {
    expect(nextScreenContent("detail", [2, 24, 30])).toBe("detail");
    expect(nextScreenContent("detail", [2, 24, 30, 29])).toBe("motion");
  });

  it("does not take a short scroll for a video", () => {
    expect(nextScreenContent("detail", [30, 30, 3])).toBe("detail");
  });

  it("goes back to detail after five settled seconds, not on a pause", () => {
    expect(nextScreenContent("motion", [30, 2, 1, 0, 2])).toBe("motion");
    expect(nextScreenContent("motion", [1, 2, 1, 0, 2])).toBe("detail");
  });
});
