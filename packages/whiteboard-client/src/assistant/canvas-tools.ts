import { Box, FileHelpers, type Editor, type TLShapeId } from "tldraw";
import {
  MAX_ASSISTANT_CONTEXT_SHAPES,
  MAX_ASSISTANT_OUTLINE_PAGES,
  MAX_ASSISTANT_OUTLINE_TEXT_LENGTH,
  MAX_ASSISTANT_SCREENSHOT_LENGTH,
  parseCanvasToolCall,
  type AssistantPageContext,
  type AssistantPageOutline,
  type CanvasShape,
  type CanvasToolCall,
} from "@orbmeet/whiteboard-core/assistant";
import { forceRenderSingleFrameLikeShape } from "../pages/export-page-membership";
import {
  createCanvasShape,
  pageShapeIds,
  readPageShapes,
  resolveAssistantPage,
  toSimpleId,
  updateCanvasShape,
  type AssistantPage,
} from "./canvas-shapes";

const MAX_SCREENSHOT_SIDE = 1280;
const MIN_SCREENSHOT_SCALE = 0.15;

export interface CanvasToolOutcome {
  ok: boolean;
  text: string;
  screenshot?: string;
  /** What the call made and changed, by simple id, so it can be shown or taken back. */
  shapes?: { created?: string[]; changed?: string[] };
}

/** Carry out one tool call from the assistant on `pageId`. Never throws. */
export async function runCanvasTool(
  editor: Editor,
  pageId: string,
  tool: unknown,
  args: unknown,
): Promise<CanvasToolOutcome> {
  const call = parseCanvasToolCall(tool, args);
  if (!call) return { ok: false, text: `Invalid arguments for ${String(tool)}.` };
  const page = resolveAssistantPage(editor, pageId);
  if (!page) return { ok: false, text: "That page no longer exists." };
  if (call.tool !== "view_page" && editor.getIsReadonly()) {
    return { ok: false, text: "This whiteboard is read-only for the person who asked." };
  }
  try {
    return await run(editor, page, call);
  } catch (error) {
    console.error("[assistant] Canvas tool failed:", error);
    return { ok: false, text: `The ${call.tool} call failed.` };
  }
}

async function run(editor: Editor, page: AssistantPage, call: CanvasToolCall): Promise<CanvasToolOutcome> {
  switch (call.tool) {
    case "view_page": {
      const view = await capturePage(editor, page);
      return {
        ok: true,
        text: view.shapes.length > 0 ? `Shapes on the page:\n${JSON.stringify(view.shapes)}` : "The page is empty.",
        screenshot: view.screenshot,
      };
    }

    case "create_shapes": {
      const created: string[] = [];
      const createdIds: string[] = [];
      const failed: string[] = [];
      const idMap = new Map<string, string>();
      editor.markHistoryStoppingPoint("assistant");
      editor.run(() => {
        for (const shape of call.args.shapes) {
          try {
            const id = createCanvasShape(editor, page, shape, idMap);
            createdIds.push(id);
            created.push(id === shape.shapeId ? id : `${shape.shapeId} (as ${id}, since that id was taken)`);
          } catch (error) {
            failed.push(`${shape.shapeId}: ${reason(error)}`);
          }
        }
      });
      return { ...summary("Created", created, failed), shapes: { created: createdIds } };
    }

    case "update_shapes": {
      const allowed = new Set(pageShapeIds(editor, page));
      const updated: string[] = [];
      const failed: string[] = [];
      editor.markHistoryStoppingPoint("assistant");
      editor.run(() => {
        for (const update of call.args.updates) {
          try {
            refuseLocked(editor, update.shapeId);
            updateCanvasShape(editor, page, allowed, update);
            updated.push(update.shapeId);
          } catch (error) {
            failed.push(`${update.shapeId}: ${reason(error)}`);
          }
        }
      });
      return { ...summary("Updated", updated, failed), shapes: { changed: updated } };
    }

    case "delete_shapes": {
      const allowed = new Set(pageShapeIds(editor, page));
      const ids: TLShapeId[] = [];
      const failed: string[] = [];
      for (const shapeId of call.args.shapeIds) {
        const id = `shape:${shapeId}` as TLShapeId;
        const shape = editor.getShape(id);
        if (!shape || !allowed.has(id)) failed.push(`${shapeId}: not on this page`);
        else if (shape.isLocked) failed.push(`${shapeId}: locked`);
        else ids.push(id);
      }
      editor.markHistoryStoppingPoint("assistant");
      editor.deleteShapes(ids);
      return summary("Deleted", ids.map(toSimpleId), failed);
    }
  }
}

/** The page as the assistant sees it: its shapes, and a screenshot when there is anything to show. */
async function capturePage(
  editor: Editor,
  page: AssistantPage,
): Promise<{ shapes: CanvasShape[]; screenshot?: string }> {
  const shapes = readPageShapes(editor, page).slice(0, MAX_ASSISTANT_CONTEXT_SHAPES);
  const ids = pageShapeIds(editor, page);
  if (ids.length === 0) return { shapes };

  const bounds = new Box(page.frame.x, page.frame.y, page.frame.props.w, page.frame.props.h);
  let scale = Math.min(1, MAX_SCREENSHOT_SIDE / Math.max(bounds.w, bounds.h, 1));
  while (scale >= MIN_SCREENSHOT_SCALE) {
    const image = await editor.toImage(forceRenderSingleFrameLikeShape([page.frame.id, ...ids]), {
      format: "jpeg",
      bounds,
      padding: 0,
      background: true,
      pixelRatio: 1,
      scale,
    });
    const screenshot = await FileHelpers.blobToDataUrl(image.blob);
    if (screenshot.length <= MAX_ASSISTANT_SCREENSHOT_LENGTH) return { shapes, screenshot };
    scale *= 0.7;
  }
  return { shapes };
}

/** What the requester can see when they ask, sent with the prompt. */
export async function capturePromptContext(
  editor: Editor,
  pageId: string,
  pageNumber: number,
  pageCount: number,
): Promise<AssistantPageContext | null> {
  const page = resolveAssistantPage(editor, pageId);
  if (!page) return null;
  const { shapes, screenshot } = await capturePage(editor, page);
  const onPage = new Set(pageShapeIds(editor, page));
  return {
    pageId: page.frame.id,
    pageNumber,
    pageCount,
    width: page.frame.props.w,
    height: page.frame.props.h,
    shapes,
    selectedShapeIds: editor.getSelectedShapeIds().filter((id) => onPage.has(id)).map(toSimpleId),
    ...(screenshot ? { screenshot } : {}),
  };
}

function refuseLocked(editor: Editor, shapeId: string): void {
  if (editor.getShape(`shape:${shapeId}` as TLShapeId)?.isLocked) throw new Error("locked");
}

function summary(verb: string, done: string[], failed: string[]): CanvasToolOutcome {
  const lines = [done.length > 0 ? `${verb}: ${done.join(", ")}.` : `${verb} nothing.`];
  if (failed.length > 0) lines.push(`Failed: ${failed.join("; ")}.`);
  return { ok: failed.length === 0, text: lines.join("\n") };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : "failed";
}

/**
 * Every page, briefly, for questions about the board as a whole. Words are
 * what a page says; ink and objects are counted, since describing a drawing
 * is what the screenshot of the current page is for.
 */
export function capturePageOutline(editor: Editor, pageIds: readonly string[]): AssistantPageOutline[] {
  return pageIds.slice(0, MAX_ASSISTANT_OUTLINE_PAGES).flatMap((pageId, index) => {
    const page = resolveAssistantPage(editor, pageId);
    if (!page) return [];
    const shapes = readPageShapes(editor, page);
    const words: string[] = [];
    let drawings = 0;
    const objects = new Map<string, number>();
    for (const shape of shapes) {
      if ("text" in shape && shape.text?.trim()) words.push(shape.text.trim().replace(/\s+/g, " "));
      if (shape._type === "draw" || shape._type === "line") drawings += 1;
      if (shape._type === "other") objects.set(shape.kind, (objects.get(shape.kind) ?? 0) + 1);
    }
    const text = words.join(" · ");
    return [{
      pageNumber: index + 1,
      text: text.length > MAX_ASSISTANT_OUTLINE_TEXT_LENGTH
        ? `${text.slice(0, MAX_ASSISTANT_OUTLINE_TEXT_LENGTH - 1)}…`
        : text,
      drawings,
      objects: [...objects].map(([kind, count]) => (count > 1 ? `${kind} ×${count}` : kind)).join(", ").slice(0, 200),
    }];
  });
}
