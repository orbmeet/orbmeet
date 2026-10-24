import {
  atom,
  Box,
  AssetRecordType,
  createShapeId,
  StateNode,
  type TLParentId,
  type TLPointerEventInfo,
  type TLStateNodeConstructor,
} from "tldraw";
import { isPageFrameShape } from "@orbmeet/whiteboard-core/page-frame-model";
import { commitUploadBeforePublish } from "../assets/managed-upload";
import { emitWhiteboardError } from "../chrome/whiteboard-error-event";

// Reactive atom for the in-progress selection rectangle (page coordinates).
// Read by ScreenshotBrushOverlay to draw the dashed selection rect.
export const screenshotBrushAtom = atom<{
  x: number;
  y: number;
  w: number;
  h: number;
} | null>("screenshot-brush", null);

// Per-editor upload function registry so multiple whiteboard instances
// don't share a single module-level _uploadFile variable.
type ScreenshotUpload = {
  url: string;
  commit(): Promise<void>;
  rollback(): Promise<void>;
};

const uploadRegistry = new WeakMap<
  object,
  ((file: File) => Promise<ScreenshotUpload>) | null
>();

// PDF-backed selections can take long enough to rasterize that a user tries
// the gesture again. Keep one capture per editor in flight so those retries do
// not all complete later as a stack of identical images.
const activeCaptureEditors = new WeakSet<object>();

export function claimScreenshotCapture(editor: object): (() => void) | null {
  if (activeCaptureEditors.has(editor)) return null;
  activeCaptureEditors.add(editor);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeCaptureEditors.delete(editor);
  };
}

export function setScreenshotUploadFile(
  key: object,
  fn: ((file: File) => Promise<ScreenshotUpload>) | null
) {
  uploadRegistry.set(key, fn);
}

function getUploadFile(key: object) {
  return uploadRegistry.get(key) ?? null;
}

// ─── States ──────────────────────────────────────────────────────────────────

class ScreenshotIdle extends StateNode {
  static override id = "idle";

  override onEnter() {
    this.editor.setCursor({ type: "cross", rotation: 0 });
    screenshotBrushAtom.set(null);
  }

  override onPointerDown(info: TLPointerEventInfo) {
    this.parent.transition("selecting", info);
  }
}

class ScreenshotSelecting extends StateNode {
  static override id = "selecting";

  private startPoint = { x: 0, y: 0 };

  override onEnter() {
    const { currentPagePoint } = this.editor.inputs;
    this.startPoint = { x: currentPagePoint.x, y: currentPagePoint.y };
    this._updateBrush();
  }

  override onPointerMove() {
    this._updateBrush();
  }

  override onPointerUp() {
    this._completeSelection();
  }

  override onComplete() {
    this._completeSelection();
  }

  override onInterrupt() {
    this._cancelSelection();
  }

  override onCancel() {
    this._cancelSelection();
  }

  override onExit() {
    screenshotBrushAtom.set(null);
  }

  private _completeSelection() {
    const brush = screenshotBrushAtom.get();
    screenshotBrushAtom.set(null);

    // Ignore tiny drags (accidental clicks)
    if (!brush || brush.w < 4 || brush.h < 4) {
      this.parent.transition("idle");
      return;
    }

    const releaseCapture = claimScreenshotCapture(this.editor);

    // A snip is a one-shot tool. Returning to Select immediately gives visible
    // feedback that the gesture was accepted and prevents another canvas drag
    // from queuing a duplicate while PDF rasterization/upload is still running.
    this.editor.setCurrentTool("select");
    if (!releaseCapture) return;

    void this._captureRegion(brush).catch((err) => {
      console.error("[ScreenshotTool] capture failed:", err);
      emitWhiteboardError(
        err instanceof Error ? err.message : "Could not create image from selection",
        { title: "Snip failed" },
      );
    }).finally(releaseCapture);
  }

  private _cancelSelection() {
    screenshotBrushAtom.set(null);
    this.parent.transition("idle");
  }

  private _updateBrush() {
    const { currentPagePoint } = this.editor.inputs;
    const { x: sx, y: sy } = this.startPoint;
    const { x: cx, y: cy } = currentPagePoint;

    screenshotBrushAtom.set({
      x: Math.min(sx, cx),
      y: Math.min(sy, cy),
      w: Math.abs(cx - sx),
      h: Math.abs(cy - sy),
    });
  }

  private async _captureRegion(brush: {
    x: number;
    y: number;
    w: number;
    h: number;
  }) {
    const bounds = new Box(brush.x, brush.y, brush.w, brush.h);

    // Collect all shapes whose masked bounds intersect the selection.
    // This includes PDF page images, drawings, text, etc.
    const shapes = this.editor.getCurrentPageShapes().filter((shape) => {
      if (isPageFrameShape(shape)) return false;
      try {
        const sb = this.editor.getShapeMaskedPageBounds(shape);
        return sb ? bounds.collides(sb) : false;
      } catch {
        return false;
      }
    });

    const { blob, width, height } = await this.editor.toImage(shapes, {
      bounds,
      format: "png",
      pixelRatio: 2,
      background: true,
      padding: 0,
    });
    if (this.editor.isDisposed) return;

    // Synced image assets must have a server-managed source. Publishing a data
    // URL would make the room guard terminate this editor's session.
    const file = new File([blob], "screenshot.png", { type: "image/png" });
    const uploadFile = getUploadFile(this.editor);
    if (!uploadFile) {
      emitWhiteboardError("Image uploads are unavailable for this whiteboard.", {
        title: "Snip unavailable",
      });
      return;
    }
    let managedUpload: Awaited<ReturnType<NonNullable<typeof uploadFile>>> | null = null;
    managedUpload = await uploadFile(file);
    const src = managedUpload.url;

    if (this.editor.isDisposed) {
      await managedUpload?.rollback().catch(() => {});
      return;
    }

    // Parent the new shape to whichever page frame contains the selection center.
    const center = bounds.center;
    let parentId: TLParentId = this.editor.getCurrentPageId();
    for (const shape of this.editor.getCurrentPageShapes()) {
      if (!isPageFrameShape(shape)) continue;
      const fb = this.editor.getShapePageBounds(shape);
      if (fb?.containsPoint(center)) {
        parentId = shape.id;
        break;
      }
    }

    // Convert page-space position to parent-local coordinates.
    let shapeX = bounds.x;
    let shapeY = bounds.y;
    if (parentId !== this.editor.getCurrentPageId()) {
      const parentShape = this.editor.getShape(parentId);
      if (parentShape) {
        shapeX = bounds.x - parentShape.x;
        shapeY = bounds.y - parentShape.y;
      }
    }

    const assetId = AssetRecordType.createId();
    const shapeId = createShapeId();
    const asset = {
      id: assetId,
      type: "image" as const,
      typeName: "asset" as const,
      props: {
        name: "screenshot.png",
        src,
        w: width,
        h: height,
        mimeType: "image/png",
        isAnimated: false,
        fileSize: blob.size,
      },
      meta: {},
    };
    try {
      await commitUploadBeforePublish(managedUpload, () => {
        this.editor.run(() => {
          this.editor.createAssets([asset]);

          // toImage reports page units (the PNG holds pixelRatio times as
          // many pixels), so the shape covers exactly the selection.
          this.editor.createShape({
            id: shapeId,
            type: "image",
            parentId,
            x: shapeX,
            y: shapeY,
            props: {
              assetId,
              w: width,
              h: height,
            },
          });
        });
      });
    } catch (error) {
      if (this.editor.getShape(shapeId)) this.editor.deleteShape(shapeId);
      if (this.editor.getAsset(assetId)) this.editor.deleteAssets([assetId]);
      throw error;
    }

    // Select and hand back to the select tool so the user can move the snip.
    this.editor.setCurrentTool("select");
    this.editor.setSelectedShapes([shapeId]);
  }
}

// ─── Tool ────────────────────────────────────────────────────────────────────

export const ScreenshotTool: TLStateNodeConstructor = class ScreenshotTool extends StateNode {
  static override id = "screenshot";
  static override initial = "idle";
  static override children() {
    return [ScreenshotIdle, ScreenshotSelecting];
  }
  static override isLockable = false;

  override onEnter() {
    this.editor.setCursor({ type: "cross", rotation: 0 });
  }
};
