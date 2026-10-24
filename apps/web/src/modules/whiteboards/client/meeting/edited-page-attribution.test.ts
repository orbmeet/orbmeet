import { describe, expect, it } from "vitest";
import type { Editor, TLRecord, TLShape, TLShapeId } from "tldraw";
import { WHITEBOARD_PAGE_SHAPE_TYPE } from "@orbmeet/whiteboard-core/page-shape-schema";
import type { RecordChanges } from "@orbmeet/whiteboard-core/page-frame-model";
import { getEditedPageIdsFromChanges } from "./edited-page-attribution";

function shape(id: string, parentId: string, y = 0, type = "note"): TLShape {
  return {
    id,
    typeName: "shape",
    type,
    parentId,
    x: 0,
    y,
    rotation: 0,
    index: "a1",
    opacity: 1,
    isLocked: false,
    meta: {},
    props: { w: 100, h: 100 },
  } as unknown as TLShape;
}

function changes(
  input: Partial<RecordChanges>,
): RecordChanges {
  return { added: {}, updated: {}, removed: {}, ...input };
}

function harness() {
  const page1 = shape("shape:page-1", "page:page", 0, WHITEBOARD_PAGE_SHAPE_TYPE);
  const page2 = shape("shape:page-2", "page:page", 1_100, WHITEBOARD_PAGE_SHAPE_TYPE);
  const records = new Map([[page1.id, page1], [page2.id, page2]]);
  const editor = {
    getShape: (id: TLShapeId) => records.get(id),
  } as unknown as Editor;
  const pages = [
    { id: page1.id, number: 1, y: 0, height: 1_000, width: 1_200 },
    { id: page2.id, number: 2, y: 1_100, height: 1_000, width: 1_200 },
  ];
  return { editor, pages };
}

describe("getEditedPageIdsFromChanges", () => {
  it("attributes an edit to its frame rather than the later camera page", () => {
    const { editor, pages } = harness();
    const before = shape("shape:note", "shape:page-1");
    const after = { ...before, x: 20 } as TLShape;

    expect(getEditedPageIdsFromChanges(editor, pages, changes({
      updated: { [before.id]: [before, after] as [TLRecord, TLRecord] },
    }))).toEqual(["shape:page-1"]);
  });

  it("marks both pages when a shape moves between them", () => {
    const { editor, pages } = harness();
    const before = shape("shape:note", "shape:page-1");
    const after = shape("shape:note", "shape:page-2");

    expect(new Set(getEditedPageIdsFromChanges(editor, pages, changes({
      updated: { [before.id]: [before, after] as [TLRecord, TLRecord] },
    })))).toEqual(new Set(["shape:page-1", "shape:page-2"]));
  });

  it("resolves deleted nested shapes through records carried by the diff", () => {
    const { editor, pages } = harness();
    const group = shape("shape:group", "shape:page-1", 0, "group");
    const child = shape("shape:child", group.id);

    expect(getEditedPageIdsFromChanges(editor, pages, changes({
      removed: { [child.id]: child, [group.id]: group },
    }))).toEqual(["shape:page-1"]);
  });
});
