// A real tldraw editor and page navigator for tests, on a board of a given size.
import { afterEach } from "vitest";
import { Editor, createTLStore, defaultBindingUtils, defaultShapeUtils, defaultTools } from "tldraw";
import { PageNavigator } from "./page-navigator";
import { WhiteboardPageShapeUtil } from "../shapes/page/page-shape-util";
import { DEFAULT_WHITEBOARD_CHROME } from "../chrome/whiteboard-chrome";
import { WHITEBOARD_RECORD_SCHEMAS } from "@orbmeet/whiteboard-core/room-schema";

/** Undone after each test. */
export const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const BOARD_SHAPE_UTILS = [...defaultShapeUtils, WhiteboardPageShapeUtil];

/** A board whose container measures `size`, as a laid-out page would (jsdom lays nothing out). */
export function makeBoard(size: { width: number; height: number }) {
  const container = document.createElement("div");
  document.body.append(container);
  const measured = { ...size };
  container.getBoundingClientRect = () =>
    ({ x: 0, y: 0, left: 0, top: 0, width: measured.width, height: measured.height, right: measured.width, bottom: measured.height }) as DOMRect;
  const editor = new Editor({
    store: createTLStore({ shapeUtils: BOARD_SHAPE_UTILS, records: WHITEBOARD_RECORD_SCHEMAS }),
    shapeUtils: BOARD_SHAPE_UTILS,
    bindingUtils: defaultBindingUtils,
    tools: defaultTools,
    getContainer: () => container,
  });
  editor.updateViewportScreenBounds(container);
  cleanups.push(() => {
    editor.dispose();
    container.remove();
  });
  return {
    editor,
    /** Change the board's size, as a panel opening or a rotation would. */
    resize(next: { width: number; height: number }) {
      Object.assign(measured, next);
    },
  };
}

export const boardOptions = { chrome: DEFAULT_WHITEBOARD_CHROME, canManagePages: true, canAutoCreatePages: true };

/** A navigator over `count` pages, started and placed. */
export function boardWithPages(count: number, size = { width: 1024, height: 587 }) {
  const board = makeBoard(size);
  const navigator = new PageNavigator(board.editor, boardOptions);
  for (let index = 0; index < count; index += 1) navigator.addPage();
  cleanups.push(navigator.start());
  navigator.setSyncReady(true);
  return { ...board, navigator, pages: navigator.pages.get() };
}

/** Let the director answer a camera change it did not make (it waits a microtask). */
export const settle = () => Promise.resolve();

