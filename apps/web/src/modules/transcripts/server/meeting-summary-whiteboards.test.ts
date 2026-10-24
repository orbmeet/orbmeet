import { describe, expect, it } from "vitest";
import {toWhiteboardsShown} from "@/modules/transcripts/server/meeting-summary.server";

const row = {
  whiteboardId: "wb_1",
  captureStatus: "captured" as const,
  capturedRevisionId: "rev_1",
  titleAtEnd: "Algebra",
  title: "Algebra",
  status: "active" as const,
};

describe("toWhiteboardsShown", () => {
  it("lists every Whiteboard the Meeting presented, not just the focused one", () => {
    expect(toWhiteboardsShown([
      row,
      { ...row, whiteboardId: "wb_2", capturedRevisionId: "rev_2", titleAtEnd: "Geometry", title: "Geometry" },
    ]).map((board) => board.title)).toEqual(["Algebra", "Geometry"]);
  });

  it("shows the name the board carried when the Meeting ended", () => {
    // Renaming on Tuesday must not rewrite what Monday's class saw.
    expect(toWhiteboardsShown([
      { ...row, titleAtEnd: "Algebra", title: "Algebra (old drafts)" },
    ])[0].title).toBe("Algebra");
  });

  it("falls back to the live title for a capture written before titles were required", () => {
    expect(toWhiteboardsShown([{ ...row, titleAtEnd: null }])[0].title).toBe("Algebra");
  });

  it("still lists an archived board but does not offer to open it", () => {
    expect(toWhiteboardsShown([{ ...row, status: "archived" }])).toEqual([
      expect.objectContaining({ whiteboardId: "wb_1", openable: false }),
    ]);
  });

  it("reports a board whose capture failed without a snapshot to link to", () => {
    expect(toWhiteboardsShown([
      { ...row, captureStatus: "failed", capturedRevisionId: null },
    ])[0]).toMatchObject({ snapshotId: null, captureStatus: "failed" });
  });
});
