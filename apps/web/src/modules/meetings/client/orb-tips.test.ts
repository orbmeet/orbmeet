import { describe, expect, it } from "vitest";
import { orbQuestionIdeas, orbTips } from "./orb-tips";

const everything = { canDraw: true, transcribing: true, orbThread: true, privateChats: true, paletteShortcut: "⌘K" };

describe("orbTips", () => {
  it("leads with drawing, in the words that fit whether you can draw", () => {
    expect(orbTips(everything)[0]).toMatchObject({ id: "draw", example: "@Orb draw a flowchart: sign up, verify email, first meeting" });
    expect(orbTips({ ...everything, canDraw: false })[0].id).toBe("draw-ask");
  });

  it("never offers a tip that does not apply", () => {
    const ids = orbTips({ canDraw: false, transcribing: false, orbThread: false, privateChats: false }).map((tip) => tip.id);
    expect(ids).not.toContain("catch-up");
    expect(ids).not.toContain("orb-thread");
    expect(ids).not.toContain("private");
    expect(ids).not.toContain("undo");
    expect(ids).not.toContain("palette");
  });

  it("names the palette by its own shortcut", () => {
    expect(orbTips({ ...everything, paletteShortcut: "Ctrl K" }).find((tip) => tip.id === "palette")?.text).toContain(
      "Press Ctrl K",
    );
  });
});

describe("orbQuestionIdeas", () => {
  it("offers four at a time, and the next four after", () => {
    const first = orbQuestionIdeas(0, true);
    expect(first).toHaveLength(4);
    expect(orbQuestionIdeas(1, true)).not.toEqual(first);
  });

  it("leaves out questions about what was said when nothing is", () => {
    const all = Array.from({ length: 5 }, (_, set) => orbQuestionIdeas(set, false)).flat();
    expect(all).not.toContain("What did I miss?");
  });
});
