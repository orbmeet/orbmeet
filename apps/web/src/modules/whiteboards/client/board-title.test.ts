import { describe, expect, it } from "vitest";

import { boardDisplayTitle } from "./board-title";

describe("boardDisplayTitle", () => {
  it("names a dated board after the meeting it was last used in", () => {
    expect(boardDisplayTitle({ title: "Whiteboard · Oct 15, 2026", lastUsedIn: "Algebra review" })).toBe("Algebra review");
  });

  it("spells an old ISO-dated board's day the way newer boards do", () => {
    const shown = boardDisplayTitle({ title: "Whiteboard · 2026-10-12" });
    expect(shown).not.toContain("2026-10-12");
    expect(shown).toBe(`Whiteboard · ${new Date(2026, 9, 12).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`);
  });

  it("keeps the rest of an ISO-dated title, and any title someone chose", () => {
    expect(boardDisplayTitle({ title: "Whiteboard · 2026-08-20 standup" })).toMatch(/standup$/);
    expect(boardDisplayTitle({ title: "Chapter 4 plan" })).toBe("Chapter 4 plan");
  });
});
