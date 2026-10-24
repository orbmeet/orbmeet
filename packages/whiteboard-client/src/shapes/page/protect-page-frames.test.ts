import type { Editor, TLShape } from "tldraw";
import { describe, expect, it, vi } from "vitest";
import type { WhiteboardPageShape } from "@orbmeet/whiteboard-core/page-shape-schema";
import {
  registerPageFrameProtection,
  withPageFrameMutationAllowance,
} from "./protect-page-frames";

type DeleteHandler = (
  shape: TLShape,
  source: "remote" | "user",
) => false | void;

type ChangeHandler = (
  prev: TLShape,
  next: TLShape,
  source: "remote" | "user",
) => TLShape;

const pageFrame = {
  id: "shape:page-1",
  typeName: "shape",
  type: "whiteboard-page",
  x: 0,
  y: 100,
  rotation: 0,
  props: { w: 1200, h: 900, name: "Page 1", background: "white" },
} as unknown as WhiteboardPageShape;

const changedPageFrame = {
  ...pageFrame,
  x: 50,
  y: 150,
  rotation: 0.25,
  props: {
    ...pageFrame.props,
    w: 800,
    h: 600,
    name: "Edited name",
    background: "dark",
  },
} as WhiteboardPageShape;

function createEditorHarness() {
  const deleteHandlers: DeleteHandler[] = [];
  const changeHandlers: ChangeHandler[] = [];
  const editor = {
    sideEffects: {
      registerBeforeDeleteHandler: (
        _typeName: "shape",
        handler: DeleteHandler,
      ) => {
        deleteHandlers.push(handler);
        return vi.fn();
      },
      registerBeforeChangeHandler: (
        _typeName: "shape",
        handler: ChangeHandler,
      ) => {
        changeHandlers.push(handler);
        return vi.fn();
      },
    },
  } as unknown as Editor;

  registerPageFrameProtection(editor);
  const deleteHandler = deleteHandlers[0];
  if (!deleteHandler) throw new Error("Delete handler was not registered");
  const changeHandler = changeHandlers[0];
  if (!changeHandler) throw new Error("Change handler was not registered");
  return { changeHandler, deleteHandler, editor };
}

describe("page frame protection", () => {
  it("blocks local page-frame deletion", () => {
    const { deleteHandler } = createEditorHarness();
    expect(deleteHandler(pageFrame, "user")).toBe(false);
  });

  it("allows a page-frame deletion received from remote sync", () => {
    const { deleteHandler } = createEditorHarness();
    expect(deleteHandler(pageFrame, "remote")).toBeUndefined();
  });

  it("allows trusted local page-frame deletion during internal page operations", () => {
    const { deleteHandler, editor } = createEditorHarness();
    const result = withPageFrameMutationAllowance(editor, () =>
      deleteHandler(pageFrame, "user")
    );
    expect(result).toBeUndefined();
  });

  it("blocks local user edits to page-frame geometry and name", () => {
    const { changeHandler } = createEditorHarness();
    const result = changeHandler(
      pageFrame,
      changedPageFrame,
      "user",
    ) as WhiteboardPageShape;

    expect(result.x).toBe(pageFrame.x);
    expect(result.y).toBe(pageFrame.y);
    expect(result.rotation).toBe(pageFrame.rotation);
    expect(result.props.w).toBe(pageFrame.props.w);
    expect(result.props.h).toBe(pageFrame.props.h);
    expect(result.props.name).toBe(pageFrame.props.name);
  });

  it("refuses a local change that turns an ordinary shape into a page frame", () => {
    const { changeHandler } = createEditorHarness();
    const ordinaryShape = {
      id: "shape:page-1",
      typeName: "shape",
      type: "geo",
      x: 0,
      y: 0,
      rotation: 0,
      props: {},
    } as unknown as TLShape;

    // The lock restores geometry from the previous revision, so there is nothing
    // to restore from here. Keeping `prev` refuses the promotion instead of
    // writing undefined width/height/name into the shape.
    const result = changeHandler(ordinaryShape, changedPageFrame, "user");

    expect(result).toBe(ordinaryShape);
  });

  it("allows remote page-frame edits from sync", () => {
    const { changeHandler } = createEditorHarness();
    expect(changeHandler(pageFrame, changedPageFrame, "remote")).toBe(
      changedPageFrame
    );
  });

  it("allows trusted local page-frame edits during internal page operations", () => {
    const { changeHandler, editor } = createEditorHarness();
    const result = withPageFrameMutationAllowance(editor, () =>
      changeHandler(pageFrame, changedPageFrame, "user")
    );

    expect(result).toBe(changedPageFrame);
  });
});
