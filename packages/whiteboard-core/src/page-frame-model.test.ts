import { describe, expect, it } from "vitest";
import type { TLParentId, TLRecord, TLShape, TLShapeId } from "@tldraw/tlschema";

import {
  applyPageFrameUpdate,
  attachLooseShapesToPages,
  getApproximateShapeCenterY,
  getPageFrameRenumberUpdates,
  getPageFrameRecords,
  getPageFrameShiftUpdates,
  planPageFrameInsertion,
  resolvePageNavigationTarget,
} from "./page-frame-model.ts";
import type { PageFrameShape } from "./page-frame-model.ts";
import { WHITEBOARD_PAGE_SHAPE_TYPE } from "@orbmeet/whiteboard-core/page-shape-schema";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";

const nativePageId = "page:page" as TLParentId;

function pageFrame(id: string, y: number, index = `a${y}`, name = id): PageFrameShape {
  return {
    id: id as TLShapeId,
    typeName: "shape",
    type: WHITEBOARD_PAGE_SHAPE_TYPE,
    parentId: nativePageId,
    index: index as never,
    x: 0,
    y,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    props: {
      w: 1200,
      h: 900,
      name,
      background: "white",
    },
    meta: {},
  };
}

function regularFrame(id: string, y: number, h: number): TLRecord {
  return {
    id: id as TLShapeId,
    typeName: "shape",
    type: "frame",
    parentId: nativePageId,
    index: `f${y}` as never,
    x: 0,
    y,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    props: {
      w: 100,
      h,
      name: id,
      color: "grey",
    },
    meta: {},
  };
}

describe("page-frame model", () => {
  it("sorts page frames by position and stable tie-breakers", () => {
    expect(
      getPageFrameRecords([
        pageFrame("shape:page-b", 0, "b"),
        pageFrame("shape:page-2", 940),
        pageFrame("shape:page-a", 0, "a"),
      ]).map((frame) => frame.id)
    ).toEqual(["shape:page-a", "shape:page-b", "shape:page-2"]);
  });

  it("uses code-unit ordering for fractional indices and ids", () => {
    expect(
      getPageFrameRecords([
        pageFrame("shape:page-z", 0, "aä"),
        pageFrame("shape:page-a", 0, "az"),
        pageFrame("shape:page-b", 0, "aZ"),
      ]).map((frame) => frame.id),
    ).toEqual(["shape:page-b", "shape:page-a", "shape:page-z"]);

    expect(
      getPageFrameRecords([
        pageFrame("shape:page-ä", 0, "a1"),
        pageFrame("shape:page-z", 0, "a1"),
      ]).map((frame) => frame.id),
    ).toEqual(["shape:page-z", "shape:page-ä"]);
  });

  it("recognizes only whiteboard page shapes as pages", () => {
    expect(
      getPageFrameRecords([
        regularFrame("shape:regular-frame", 0, 100),
        pageFrame("shape:page-1", 0),
      ]).map((frame) => frame.id)
    ).toEqual(["shape:page-1"]);
  });

  it("resolves by stable page id before falling back to page number", () => {
    const records = [
      pageFrame("shape:page-1", 0),
      pageFrame("shape:page-2", 940),
    ];

    expect(resolvePageNavigationTarget(records, 1, "shape:page-2")).toEqual({
      pageId: "shape:page-2",
      pageNumber: 2,
      pageCount: 2,
    });
    expect(resolvePageNavigationTarget(records, 2, "shape:deleted")).toEqual({
      pageId: "shape:page-2",
      pageNumber: 2,
      pageCount: 2,
    });
  });

  it("falls back to the first page for a non-finite page number", () => {
    const records = [
      pageFrame("shape:page-1", 0),
      pageFrame("shape:page-2", 940),
    ];

    expect(resolvePageNavigationTarget(records, Number.NaN)).toEqual({
      pageId: "shape:page-1",
      pageNumber: 1,
      pageCount: 2,
    });
  });

  it("plans insertions from measured frame geometry and configured shift", () => {
    const plan = planPageFrameInsertion(
      [
        { y: 120, height: 900 },
        { y: 1060, height: 1697 },
      ],
      2,
      1,
      { height: 900, spacing: 40 }
    );

    expect(plan).toEqual({
      insertIndex: 2,
      actualCount: 1,
      insertionY: 2797,
      shiftAmount: 940,
    });
  });

  it("clamps insertion count at the page limit", () => {
    const existingPageCount = WHITEBOARD_CONFIG.MAX_PAGES - 1;
    const frames = Array.from({ length: existingPageCount }, (_, index) => ({
      y: index * 940,
      height: 900,
    }));

    expect(planPageFrameInsertion(frames, existingPageCount, 5).actualCount).toBe(1);
  });

  it("never plans a negative insertion for a board already past the limit (REVIEW #28)", () => {
    const frames = Array.from({ length: WHITEBOARD_CONFIG.MAX_PAGES + 2 }, (_, index) => ({
      y: index * 940,
      height: 900,
    }));
    const plan = planPageFrameInsertion(frames, 0, 3);
    expect(plan.actualCount).toBe(0);
    expect(plan.shiftAmount).toBeGreaterThanOrEqual(0);
  });

  it("sanitizes non-finite insertion inputs", () => {
    const frames = [{ y: 0, height: 900 }];

    expect(planPageFrameInsertion(frames, Number.NaN, Number.NaN)).toMatchObject({
      insertIndex: 1,
      actualCount: 0,
      insertionY: 940,
    });
  });

  it("builds shared updates for inserted page shifts and labels", () => {
    const frames = [
      pageFrame("shape:page-1", 0, "a1", "Page 1"),
      pageFrame("shape:page-2", 940, "a2", "Page 2"),
      pageFrame("shape:page-3", 1880, "a3", "Page 3"),
    ];
    const plan = planPageFrameInsertion(
      frames.map((frame) => ({ y: frame.y, height: 900 })),
      1,
      2,
      { height: 900, spacing: 40 }
    );

    expect(getPageFrameShiftUpdates(frames, plan)).toEqual([
      {
        id: "shape:page-2",
        type: WHITEBOARD_PAGE_SHAPE_TYPE,
        y: 2820,
        props: { name: "Page 4" },
      },
      {
        id: "shape:page-3",
        type: WHITEBOARD_PAGE_SHAPE_TYPE,
        y: 3760,
        props: { name: "Page 5" },
      },
    ]);
  });

  it("renumbers page frames by vertical order", () => {
    const frames = [
      pageFrame("shape:page-b", 940, "a2", "Page 10"),
      pageFrame("shape:page-a", 0, "a1", "Page 1"),
    ];

    expect(getPageFrameRenumberUpdates(frames)).toEqual([
      {
        id: "shape:page-b",
        type: WHITEBOARD_PAGE_SHAPE_TYPE,
        props: { name: "Page 2" },
      },
    ]);
  });

  it("applies shared page-frame updates to storage records", () => {
    const frame = pageFrame("shape:page-2", 940, "a2", "Page 2");

    expect(
      applyPageFrameUpdate(frame, {
        id: "shape:page-2" as TLShapeId,
        type: WHITEBOARD_PAGE_SHAPE_TYPE,
        y: 1880,
        props: { name: "Page 3" },
      })
    ).toMatchObject({
      id: "shape:page-2",
      y: 1880,
      props: { name: "Page 3", h: 900 },
    });
  });

});

describe("getApproximateShapeCenterY", () => {
  function drawShape(y: number, pointYs: number[]): TLShape {
    return {
      id: "shape:draw" as TLShapeId,
      typeName: "shape",
      type: "draw",
      parentId: nativePageId,
      x: 0,
      y,
      index: "a1",
      rotation: 0,
      isLocked: false,
      opacity: 1,
      meta: {},
      props: {
        segments: [{ type: "free", points: pointYs.map((py) => ({ x: 0, y: py, z: 0.5 })) }],
      },
    } as unknown as TLShape;
  }

  it("prefers an explicit height when the shape has one", () => {
    expect(getApproximateShapeCenterY(regularFrame("shape:f", 100, 50) as TLShape)).toBe(125);
  });

  it("centers on the vertical extent of a point-based shape", () => {
    expect(getApproximateShapeCenterY(drawShape(100, [0, 10, 40]))).toBe(120);
    expect(getApproximateShapeCenterY(drawShape(100, [-20, 20]))).toBe(100);
  });

  it("falls back to the shape origin when no points are present", () => {
    expect(getApproximateShapeCenterY(drawShape(70, []))).toBe(70);
  });

  // A long stroke used to be spread into Math.min/Math.max, which throws
  // RangeError past the engine's argument limit — inside the server's page-insert
  // transaction, so it failed every page add and PDF import for the room.
  it("handles a stroke with more points than the argument limit", () => {
    const pointYs = Array.from({ length: 300_000 }, (_, i) => i);
    expect(getApproximateShapeCenterY(drawShape(10, pointYs))).toBe(
      10 + (0 + 299_999) / 2
    );
  });
});

describe("attachLooseShapesToPages", () => {
  const canvas = { id: nativePageId, typeName: "page", name: "Page 1", index: "a1", meta: {} } as unknown as TLRecord;
  const box = (id: string, parentId: string, y: number, index: string): TLShape =>
    ({
      id: id as TLShapeId,
      typeName: "shape",
      type: "geo",
      parentId: parentId as TLParentId,
      index: index as never,
      x: 50,
      y,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      props: { w: 100, h: 100 },
      meta: {},
    }) as unknown as TLShape;

  it("puts each loose shape on the page under its centre, where it was on screen", () => {
    const first = pageFrame("shape:p1", 0, "a1");
    const second = pageFrame("shape:p2", 940, "a2");
    const onPage = box("shape:on", "shape:p2", 10, "a5");
    const records = [canvas, first, second, onPage, box("shape:low", nativePageId, 1000, "a4"), box("shape:high", nativePageId, 100, "a3")];

    const attached = attachLooseShapesToPages(records);

    expect(attached.map((shape) => [shape.id, shape.parentId, shape.x, shape.y])).toEqual([
      ["shape:high", "shape:p1", 50, 100],
      ["shape:low", "shape:p2", 50, 60],
    ]);
    // Above what the page held already.
    const low = attached.find((shape) => shape.id === "shape:low")!;
    expect(low.index > onPage.index).toBe(true);
  });

  it("keeps loose shapes in order among themselves, and gives what is above the first page to it", () => {
    const first = pageFrame("shape:p1", 0, "a1");
    const attached = attachLooseShapesToPages([
      canvas,
      first,
      box("shape:b", nativePageId, -300, "a3"),
      box("shape:a", nativePageId, 200, "a2"),
    ]);
    expect(attached.map((shape) => shape.id)).toEqual(["shape:a", "shape:b"]);
    expect(attached.every((shape) => shape.parentId === "shape:p1")).toBe(true);
    expect(attached[0].index < attached[1].index).toBe(true);
    expect(attached[1].y).toBe(-300);
  });

  it("changes nothing on a board where everything is on a page, or that has no pages", () => {
    const first = pageFrame("shape:p1", 0, "a1");
    expect(attachLooseShapesToPages([canvas, first, box("shape:on", "shape:p1", 10, "a2")])).toEqual([]);
    expect(attachLooseShapesToPages([canvas, box("shape:loose", nativePageId, 10, "a2")])).toEqual([]);
  });
});
