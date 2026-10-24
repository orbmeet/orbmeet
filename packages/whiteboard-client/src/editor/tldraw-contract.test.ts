// @vitest-environment jsdom
//
// The board works around tldraw in a few places that lean on how tldraw
// behaves inside, not on its public contract. Each test here pins one of
// those behaviours, so an upgrade that changes it fails here, by name,
// instead of quietly breaking the board. A failure means: re-check the
// workaround it names, and delete it if tldraw no longer needs it.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createShapeId,
  createTLStore,
  defaultBindingUtils,
  defaultShapeTools,
  defaultShapeUtils,
  defaultTools,
  DrawShapeTool,
  Editor,
  HighlightShapeTool,
  type TLShapeId,
} from "tldraw";
import { makeBoard } from "../pages/test-board";
import { forceRenderSingleFrameLikeShape } from "../pages/export-page-membership";
import { configureCoalescedPointerEvents } from "./disable-coalesced-pointer-events";

const require = createRequire(import.meta.url);

/** A file of tldraw's installed editor package, as shipped. */
function editorSource(file: string): string {
  const tldrawEntry = require.resolve("tldraw");
  const editorEntry = require.resolve("@tldraw/editor", { paths: [dirname(tldrawEntry)] });
  // Resolution lands in one of its builds; the ESM build is the one browsers run.
  return readFileSync(join(dirname(editorEntry), "..", "dist-esm", "lib", file), "utf8");
}

describe("tldraw behaviour the board relies on", () => {
  // forceRenderSingleFrameLikeShape (pages/export-page-membership.ts)
  it("leaves a lone frame-like shape out of its own export", async () => {
    const { editor } = makeBoard({ width: 800, height: 600 });
    const frameId: TLShapeId = createShapeId("contract-page");
    editor.createShape({ id: frameId, type: "whiteboard-page", x: 0, y: 0, props: { w: 200, h: 100 } });

    const alone = await editor.getSvgString([frameId], { background: false });
    const forced = await editor.getSvgString(forceRenderSingleFrameLikeShape([frameId]), { background: false });

    // The page's paper is its background svg. Exported alone, tldraw uses the
    // frame only as bounds; listed twice, it is drawn.
    expect(forced?.svg.length ?? 0).toBeGreaterThan(alone?.svg.length ?? 0);
  });

  // useWhiteboardEditorLifecycle replaces `editor.updateViewportScreenBounds`.
  it("measures the viewport through the editor instance's method", () => {
    expect(editorSource("hooks/useScreenBounds.mjs")).toContain("editor.updateViewportScreenBounds(");
  });

  // configureCoalescedPointerEvents (editor/disable-coalesced-pointer-events.ts)
  it("reads coalesced events off the current tool, and only skips them for its own iOS check", () => {
    expect(DrawShapeTool.useCoalescedEvents).toBe(true);
    expect(HighlightShapeTool.useCoalescedEvents).toBe(true);
    expect(editorSource("hooks/useCanvasEvents.mjs")).toMatch(/!tlenv\.isIos && currentTool\.useCoalescedEvents/);

    // The board's tools, as `<Tldraw>` mounts them: the shape tools are where draw lives.
    const editor = new Editor({
      store: createTLStore({ shapeUtils: defaultShapeUtils }),
      shapeUtils: defaultShapeUtils,
      bindingUtils: defaultBindingUtils,
      tools: [...defaultTools, ...defaultShapeTools],
      getContainer: () => document.body,
    });
    configureCoalescedPointerEvents(editor, true);
    expect(editor.getStateDescendant("draw")?.useCoalescedEvents).toBe(false);
    expect(editor.getStateDescendant("highlight")?.useCoalescedEvents).toBe(false);
    editor.dispose();
  });
});
