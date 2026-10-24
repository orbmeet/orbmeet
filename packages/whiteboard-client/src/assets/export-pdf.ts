import { Box, type Editor, type TLShapeId, type TLAssetId } from "tldraw";
import type { PDFPage, PDFImage } from "pdf-lib";
import type { WhiteboardClientCapabilities } from "../editor/client-capabilities";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import { isPageFrameShape } from "@orbmeet/whiteboard-core/page-frame-model";
import { PDF_A4_WIDTH_PT, fitContained, unionBounds } from "@orbmeet/whiteboard-core/pdf-geometry";
import {
  forceRenderSingleFrameLikeShape,
  getDrawableShapeEntries,
  getFrameExportContent,
} from "../pages/export-page-membership";

/** How long one embedded image may take before export goes on without it. */
const ASSET_FETCH_TIMEOUT_MS = 15_000;

function drawImageContained(
  page: PDFPage,
  image: PDFImage,
  pageWidth: number,
  pageHeight: number,
) {
  const fit = fitContained(image.width, image.height, pageWidth, pageHeight);
  page.drawImage(image, {
    x: fit.x,
    y: fit.y,
    width: fit.width,
    height: fit.height,
  });
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function prefetchImageAssets(
  editor: Editor,
  shapeIds: TLShapeId[],
): Promise<Map<TLAssetId, string>> {
  const cache = new Map<TLAssetId, string>();
  const seenAssetIds = new Set<TLAssetId>();

  const fetchJobs: { assetId: TLAssetId; src: string }[] = [];

  for (const id of shapeIds) {
    const shape = editor.getShape(id);
    if (!shape || shape.type !== "image") continue;
    const assetId = (shape.props as { assetId?: TLAssetId }).assetId;
    if (!assetId || seenAssetIds.has(assetId)) continue;
    seenAssetIds.add(assetId);

    const asset = editor.getAsset(assetId);
    if (!asset) continue;
    const src = asset.props.src as string | undefined;
    if (!src || src.startsWith("data:")) continue;

    fetchJobs.push({ assetId, src });
  }

  const results = await Promise.allSettled(
    fetchJobs.map(async ({ assetId, src }) => {
      // `same-origin`, never `include`: a peer can author an image asset whose
      // src points at any host, and `include` would turn another participant's
      // export into a credentialed request to it. Same-origin keeps the cookie
      // for the app's own /api/wb-assets endpoint, which needs it; a cross-origin
      // asset is fetched without credentials, exactly as displaying it already
      // does.
      //
      // A peer also chooses the host, which may accept the connection and
      // never answer; the timeout bounds the body too, so export always ends.
      const response = await fetch(src, {
        credentials: "same-origin",
        signal: AbortSignal.timeout(ASSET_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return;
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/")) return;
      const blob = await response.blob();
      cache.set(assetId, await blobToDataUrl(blob));
    }),
  );

  // Log any failures for debugging but don't block export
  for (const result of results) {
    if (result.status === "rejected") {
      // tldraw's pipeline will retry with the URL
    }
  }

  return cache;
}

/**
 * Core PDF builder — renders the whiteboard content into a PDF and returns
 * the Blob. Pass frame shape IDs as `pageIds` (one frame = one PDF page).
 * If no frames exist, falls back to exporting all content as a single page.
 *
 * `setPrefetchOverride` lets the caller's TLAssetStore.resolve return
 * prefetched data URLs during export without mutating tldraw internals or
 * broadcasting temporary asset URLs to collaborators.
 */
export async function buildWhiteboardPdfBlob(
  editor: Editor,
  pageIds: TLShapeId[],
  options: {
    capabilities: WhiteboardClientCapabilities;
    onProgress?: (current: number, total: number) => void;
    setPrefetchOverride?: (map: Map<TLAssetId, string> | null) => void;
  },
): Promise<Blob> {
  const { capabilities, onProgress, setPrefetchOverride } = options;
  const { PDFDocument } = await import("pdf-lib");
  const pdfDoc = await PDFDocument.create();

  const drawableShapeEntries = getDrawableShapeEntries(editor);

  const allDrawableIds = drawableShapeEntries.map((e) => e.id);
  const prefetched = await prefetchImageAssets(editor, allDrawableIds);
  setPrefetchOverride?.(prefetched);

  let exportedPageCount = 0;
  const EXPORT_BATCH_SIZE = 5;

  const lowRasterMemory = capabilities.reduceRasterMemory;
  const exportPixelRatio =
    pageIds.length > 20 ? 1 : lowRasterMemory && pageIds.length > 10 ? 1.5 : 2;

  try {
    for (
      let batchStart = 0;
      batchStart < pageIds.length;
      batchStart += EXPORT_BATCH_SIZE
    ) {
      const batchEnd = Math.min(
        batchStart + EXPORT_BATCH_SIZE,
        pageIds.length,
      );

      for (let index = batchStart; index < batchEnd; index += 1) {
        const frameId = pageIds[index];
        const frameBounds = editor.getShapePageBounds(frameId);
        const frameShape = editor.getShape(frameId);
        if (!frameBounds || !frameShape) continue;

        const frameAspectRatio = isPageFrameShape(frameShape)
          ? frameShape.props.h / frameShape.props.w
          : WHITEBOARD_CONFIG.PAGE_HEIGHT / WHITEBOARD_CONFIG.PAGE_WIDTH;
        const pdfPageWidth = PDF_A4_WIDTH_PT;
        const pdfPageHeight = pdfPageWidth * frameAspectRatio;

        if (pdfPageWidth <= 0 || pdfPageHeight <= 0) {
          continue;
        }

        const exportBox = new Box(
          frameBounds.x,
          frameBounds.y,
          frameBounds.w,
          frameBounds.h,
        );
        const pageContent = getFrameExportContent(
          editor,
          frameId,
          exportBox,
          drawableShapeEntries,
        );
        const exportShapeIds = isPageFrameShape(frameShape)
          ? [frameId, ...pageContent.shapeIds]
          : pageContent.shapeIds;
        if (exportShapeIds.length === 0) {
          pdfDoc.addPage([pdfPageWidth, pdfPageHeight]);
          exportedPageCount += 1;
          onProgress?.(exportedPageCount, pageIds.length);
          continue;
        }

        const image = await editor.toImage(forceRenderSingleFrameLikeShape(exportShapeIds), {
          format: "png",
          bounds: exportBox,
          padding: 0,
          background: true,
          pixelRatio: exportPixelRatio,
        });
        if (!image) {
          throw new Error(`Whiteboard page ${index + 1} export failed`);
        }

        const pngBytes = await image.blob.arrayBuffer();
        const pngImage = await pdfDoc.embedPng(pngBytes);

        const page = pdfDoc.addPage([pdfPageWidth, pdfPageHeight]);
        drawImageContained(page, pngImage, pdfPageWidth, pdfPageHeight);
        exportedPageCount += 1;
        onProgress?.(exportedPageCount, pageIds.length);
      }
    }

    if (exportedPageCount === 0 && drawableShapeEntries.length > 0) {
      const boundsForUnion = drawableShapeEntries.map((entry) => ({
        x: entry.bounds.x,
        y: entry.bounds.y,
        w: entry.bounds.w,
        h: entry.bounds.h,
      }));
      const fallbackBounds = unionBounds(boundsForUnion);
      if (fallbackBounds) {
        const shapeIds = drawableShapeEntries.map((entry) => entry.id);
        const fallbackBox = new Box(
          fallbackBounds.x,
          fallbackBounds.y,
          fallbackBounds.w,
          fallbackBounds.h,
        );
        const image = await editor.toImage(shapeIds, {
          format: "png",
          bounds: fallbackBox,
          padding: 16,
          background: true,
          pixelRatio: 1.5,
        });
        if (!image) {
          throw new Error("Whiteboard PDF export failed");
        }

        const pngBytes = await image.blob.arrayBuffer();
        const pngImage = await pdfDoc.embedPng(pngBytes);

        const contentAspect = fallbackBounds.h / fallbackBounds.w;
        const fallbackWidth = PDF_A4_WIDTH_PT;
        const fallbackHeight = fallbackWidth * contentAspect;
        const page = pdfDoc.addPage([fallbackWidth, fallbackHeight]);
        drawImageContained(page, pngImage, fallbackWidth, fallbackHeight);
        exportedPageCount = 1;
      }
    }
  } finally {
    setPrefetchOverride?.(null);
  }

  if (exportedPageCount === 0) {
    throw new Error("No whiteboard content to export");
  }

  const pdfBytes = await pdfDoc.save();
  return new Blob([pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength) as ArrayBuffer], { type: "application/pdf" });
}

/** Combines independently rendered document sections into one Meeting handout. */
export async function mergeWhiteboardPdfBlobs(blobs: readonly Blob[]): Promise<Blob> {
  if (blobs.length === 0) throw new Error("No Whiteboard PDFs to combine");
  if (blobs.length === 1) return blobs[0];

  const { PDFDocument } = await import("pdf-lib");
  const combined = await PDFDocument.create();
  for (const blob of blobs) {
    const source = await PDFDocument.load(await blob.arrayBuffer());
    const pages = await combined.copyPages(source, source.getPageIndices());
    for (const page of pages) combined.addPage(page);
  }
  combined.setTitle("Meeting Whiteboard handout");
  const bytes = await combined.save();
  return new Blob([
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  ], { type: "application/pdf" });
}
