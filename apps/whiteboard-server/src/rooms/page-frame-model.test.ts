import { describe, expect, it } from "vitest";
import type { TLParentId, TLRecord, TLShape, TLShapeId } from "@tldraw/tlschema";

import {
  getPageFrameRecords,
  resolvePageNavigationTarget,
  getApproximateShapeCenterY,
} from "@orbmeet/whiteboard-core/page-frame-model";
import { WHITEBOARD_PAGE_SHAPE_TYPE } from "@orbmeet/whiteboard-core/page-shape-schema";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";

const nativePageId = "page:page" as TLParentId;

function pageFrame(id: string, y: number, index = `a${y}`): TLRecord {
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
      name: id,
      background: "white",
    },
    meta: {},
  };
}

describe("room page state", () => {
  it("sorts page frames by document position", () => {
    expect(
      getPageFrameRecords([
        pageFrame("shape:page-2", 940),
        pageFrame("shape:page-1", 0),
      ]).map((frame) => String(frame.id))
    ).toEqual(["shape:page-1", "shape:page-2"]);
  });

  it("uses a stable tie-breaker when page frames share the same y", () => {
    expect(
      getPageFrameRecords([
        pageFrame("shape:page-b", 0, "b"),
        pageFrame("shape:page-a", 0, "a"),
      ]).map((frame) => String(frame.id))
    ).toEqual(["shape:page-a", "shape:page-b"]);
  });

  it("resolves stale page ids to the current page-number slot", () => {
    const records = [
      pageFrame("shape:page-1", 0),
      pageFrame("shape:page-2-new", 940),
      pageFrame("shape:page-3", 1880),
    ];

    expect(
      resolvePageNavigationTarget(records, 2, "shape:page-2-deleted")
    ).toEqual({
      pageId: "shape:page-2-new" as TLShapeId,
      pageNumber: 2,
      pageCount: 3,
    });
  });

  it("uses the stable page id when it is still present", () => {
    const records = [
      pageFrame("shape:page-1", 0),
      pageFrame("shape:page-2", 940),
    ];

    expect(resolvePageNavigationTarget(records, 1, "shape:page-2")).toEqual({
      pageId: "shape:page-2" as TLShapeId,
      pageNumber: 2,
      pageCount: 2,
    });
  });

  it("never resolves a page number beyond the clamped page count", () => {
    // A document can exceed today's MAX_PAGES; a target must not report a page
    // number above its clamped page count.
    const overLimitPageCount = WHITEBOARD_CONFIG.MAX_PAGES + 2;
    const records = Array.from({ length: overLimitPageCount }, (_, i) =>
      pageFrame(`shape:page-${i + 1}`, i * 940, `a${String(i + 1).padStart(3, "0")}`)
    );

    const byNumber = resolvePageNavigationTarget(records, overLimitPageCount);
    expect(byNumber.pageCount).toBe(WHITEBOARD_CONFIG.MAX_PAGES);
    expect(byNumber.pageNumber).toBe(WHITEBOARD_CONFIG.MAX_PAGES);

    const byOverLimitId = resolvePageNavigationTarget(
      records,
      1,
      `shape:page-${overLimitPageCount}`,
    );
    expect(byOverLimitId.pageCount).toBe(WHITEBOARD_CONFIG.MAX_PAGES);
    expect(byOverLimitId.pageNumber).toBeLessThanOrEqual(WHITEBOARD_CONFIG.MAX_PAGES);
  });

  it("approximates line-like loose shape centers from point props", () => {
    const line = {
      id: "shape:line" as TLShapeId,
      typeName: "shape",
      type: "line",
      parentId: nativePageId,
      index: "c1" as never,
      x: 0,
      y: 800,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      props: {
        handles: {
          start: { id: "start", index: "a1", x: 0, y: 0 },
          end: { id: "end", index: "a2", x: 0, y: 300 },
        },
      },
      meta: {},
    } as unknown as TLRecord;

    expect(getApproximateShapeCenterY(line as TLShape)).toBe(950);
  });
});
