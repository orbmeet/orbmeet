import { Box, type Editor, type TLShapeId } from "tldraw";
import {
  forceRenderSingleFrameLikeShape,
  getDrawableShapeEntries,
  getFrameExportContent,
} from "@orbmeet/whiteboard-client/react";
import { meetingPreviewUrl } from "@/modules/whiteboards/contract/meeting-preview";

/** Twice the widest place a preview is shown. */
const PREVIEW_WIDTH_PX = 448;

/**
 * Draw a meeting's first board page small and store it for the lists of
 * meetings, unless it already has a picture. An empty page gets none, and
 * keeps the placeholder that says so. Best effort: a list without a picture
 * still works, so failures end here.
 */
export async function publishMeetingPreview(editor: Editor, meetingId: string, pageId: TLShapeId): Promise<void> {
  const url = meetingPreviewUrl(meetingId);
  // `no-store`: the short-lived "none yet" answer must not hide the real one.
  const existing = await fetch(url, { cache: "no-store" });
  if (existing.status !== 404) return;

  const bounds = editor.getShapePageBounds(pageId);
  if (!bounds || bounds.w <= 0) return;
  const content = getFrameExportContent(editor, pageId, bounds, getDrawableShapeEntries(editor));
  if (content.shapeIds.length === 0) return;

  const image = await editor.toImage(forceRenderSingleFrameLikeShape([pageId, ...content.shapeIds]), {
    format: "webp",
    quality: 0.8,
    bounds: new Box(bounds.x, bounds.y, bounds.w, bounds.h),
    padding: 0,
    background: true,
    scale: PREVIEW_WIDTH_PX / bounds.w,
    pixelRatio: 1,
  });
  if (!image) return;
  await fetch(url, { method: "POST", body: image.blob });
}
