import { describe, expect, it } from "vitest";

import { BOARD_OUTLINE_MAX_CHARS, joinBoardOutlines, outlineFromSnapshot, shapeWords } from "./board-outline";

const shape = (state: Record<string, unknown>) => ({ state: { typeName: "shape", ...state } });
const richText = (...lines: string[]) => ({
  type: "doc",
  content: lines.map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] })),
});

describe("outlineFromSnapshot", () => {
  it("describes each page in page order: its words, its ink, its images", () => {
    const snapshot = {
      documents: [
        shape({ id: "shape:p2", type: "whiteboard-page", y: 1000, parentId: "page:page" }),
        shape({ id: "shape:p1", type: "whiteboard-page", y: 0, parentId: "page:page" }),
        shape({ id: "shape:eq", type: "text", parentId: "shape:p2", props: { richText: richText("2x + 5 = 17", "x = 6") } }),
        shape({ id: "shape:line", type: "draw", parentId: "shape:p2", props: {} }),
        shape({ id: "shape:group", type: "group", parentId: "shape:p2", props: {} }),
        shape({ id: "shape:pic", type: "image", parentId: "shape:group", props: {} }),
        shape({ id: "shape:stray", type: "text", parentId: "page:page", props: { richText: richText("off the pages") } }),
        { state: { typeName: "page", id: "page:page" } },
      ],
    };
    expect(outlineFromSnapshot(snapshot, "Week 16")).toEqual([
      "Week 16, page 1: empty",
      "Week 16, page 2: “2x + 5 = 17 x = 6” (1 drawing, 1 image)",
    ]);
  });

  it("reads nothing from something that is not a snapshot", () => {
    expect(outlineFromSnapshot(null, "Board")).toEqual([]);
    expect(outlineFromSnapshot({ documents: "nope" }, "Board")).toEqual([]);
  });
});

describe("shapeWords", () => {
  it("prefers plain text and falls back to rich text", () => {
    expect(shapeWords({ text: "  Practice  " })).toBe("Practice");
    expect(shapeWords({ richText: richText("Warm-up") })).toBe("Warm-up");
    expect(shapeWords(undefined)).toBe("");
  });
});

describe("joinBoardOutlines", () => {
  it("stops at a line boundary inside the budget", () => {
    const line = "x".repeat(1_000);
    const joined = joinBoardOutlines([line, line, line, line, line]);
    expect(joined.length).toBeLessThanOrEqual(BOARD_OUTLINE_MAX_CHARS);
    expect(joined.split("\n").every((kept) => kept === line)).toBe(true);
  });
});
