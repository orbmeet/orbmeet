import { describe, expect, it, vi } from "vitest";

vi.mock("@/platform/ai/gemini", () => ({ createGeminiTextAdapter: vi.fn() }));
vi.mock("@tanstack/ai", () => ({ chat: vi.fn() }));

const { toMoments } = await import("./generate-summary.server");

describe("toMoments", () => {
  it("reads mm:ss into seconds and keeps the moments in order", () => {
    expect(
      toMoments(
        [
          { at: "22:05", title: "Adding vs multiplying powers", detail: "Orion added the powers in (3²)³." },
          { at: "06:12", title: "Divisibility by 3 and 9", detail: "Sum the digits." },
        ],
        3480,
      ),
    ).toEqual([
      { atSeconds: 372, title: "Divisibility by 3 and 9", detail: "Sum the digits." },
      { atSeconds: 1325, title: "Adding vs multiplying powers", detail: "Orion added the powers in (3²)³." },
    ]);
  });

  it("drops a moment it could not have read from a line's prefix", () => {
    expect(
      toMoments(
        [
          { at: "around the end", title: "Wrap-up", detail: "" },
          { at: "75:30", title: "After the meeting ended", detail: "" },
          { at: "01:02", title: " ", detail: "No title" },
        ],
        3600,
      ),
    ).toEqual([]);
    expect(toMoments(undefined, null)).toEqual([]);
  });
});
