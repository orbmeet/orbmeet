import { describe, expect, it } from "vitest";
import { WHITEBOARD_PAGE_SHAPE_TYPE } from "@orbmeet/whiteboard-core/page-shape-schema";
import { filterCapturedHandoutPageIds } from "./handout-pages";

describe("filterCapturedHandoutPageIds", () => {
  it("keeps only page frames present in the captured Snapshot", () => {
    const snapshot = {
      documents: [
        {
          state: {
            id: "shape:page-1",
            typeName: "shape",
            type: WHITEBOARD_PAGE_SHAPE_TYPE,
          },
        },
        { state: { id: "shape:note-1", typeName: "shape", type: "note" } },
      ],
    };

    expect(filterCapturedHandoutPageIds(snapshot, [
      "shape:deleted-page",
      "shape:page-1",
      "shape:note-1",
    ])).toEqual(["shape:page-1"]);
  });

  it("fails closed for a malformed Snapshot", () => {
    expect(filterCapturedHandoutPageIds({}, ["shape:page-1"])).toEqual([]);
  });
});
