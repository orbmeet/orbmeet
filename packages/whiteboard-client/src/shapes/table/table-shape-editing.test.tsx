// @vitest-environment jsdom
import { atom } from "@tldraw/state";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Editor, TLShapeId } from "tldraw";
import {
  DEFAULT_TABLE_HEIGHT,
  DEFAULT_TABLE_WIDTH,
  type TableShape,
} from "@orbmeet/whiteboard-core/table-shape-schema";
import { TableShapeUtil } from "./table-shape-util";

const SHAPE_ID = "shape:table-test" as TLShapeId;

function createTableShape(): TableShape {
  return {
    id: SHAPE_ID,
    typeName: "shape",
    type: "table",
    x: 0,
    y: 0,
    rotation: 0,
    index: "a1",
    parentId: "page:page",
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {
      w: DEFAULT_TABLE_WIDTH,
      h: DEFAULT_TABLE_HEIGHT,
      cells: [
        ["a", "b"],
        ["c", "d"],
      ],
      headerRow: true,
    },
  } as unknown as TableShape;
}

/** Editing and selection are signals, exactly as on the real editor. */
function renderTableShape() {
  const editingShapeId = atom<TLShapeId | null>("editingShapeId", null);
  const selectedShapeIds = atom<TLShapeId[]>("selectedShapeIds", []);
  const readonly = atom("readonly", false);

  const editor = {
    getIsReadonly: () => readonly.get(),
    getEditingShapeId: () => editingShapeId.get(),
    getSelectedShapeIds: () => selectedShapeIds.get(),
    updateShape: () => {},
    markEventAsHandled: () => {},
    setEditingShape: (id: TLShapeId | null) => editingShapeId.set(id),
    setCurrentTool: () => {},
    run: (fn: () => void) => fn(),
  };

  const util = new TableShapeUtil(editor as unknown as Editor);
  render(util.component(createTableShape()));
  return { editingShapeId, selectedShapeIds, readonly };
}

/**
 * act() returns a thenable even when the update is synchronous; we only need
 * the flush, so the result is intentionally discarded in one place.
 */
function flushSignals(update: () => void) {
  void act(update);
}

const cellInputs = () => document.querySelectorAll("input");

afterEach(cleanup);

describe("table shape editing state", () => {
  it("shows cell inputs once the shape starts being edited", () => {
    const { editingShapeId } = renderTableShape();

    expect(cellInputs().length).toBe(0);

    flushSignals(() => editingShapeId.set(SHAPE_ID));

    expect(cellInputs().length).toBeGreaterThan(0);
  });

  it("hides cell inputs when editing moves away", () => {
    const { editingShapeId } = renderTableShape();

    flushSignals(() => editingShapeId.set(SHAPE_ID));
    expect(cellInputs().length).toBeGreaterThan(0);

    flushSignals(() => editingShapeId.set(null));

    expect(cellInputs().length).toBe(0);
  });
});
