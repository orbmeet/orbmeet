import { AssetRecordType, type Editor, type TLAsset, type TLShapeId } from "tldraw";
import { createShapeId } from "@tldraw/tlschema";
import type { PageManager } from "../pages/page-manager";
import {
  WHITEBOARD_MAX_IMAGE_BYTES,
  inferWhiteboardImageMimeTypeFromFileName,
  isSupportedWhiteboardImageFileName,
  isSupportedWhiteboardImageMimeType,
  looksLikeWhiteboardImageUrl,
} from "./whiteboard-image";
import { readImageDimensionsFromFile } from "./read-image-dimensions";
import { anySignal } from "../editor/abort-signals";
import { isPageFrameShape } from "@orbmeet/whiteboard-core/page-frame-model";
import { commitUploadBeforePublish } from "./managed-upload";
import { placeImageOnPage } from "./image-placement";

export function looksLikeImageUrl(url: string): boolean {
  return looksLikeWhiteboardImageUrl(url);
}

export type ImageImportPhase = "preparing" | "uploading" | "placing";

export interface ImageImportRuntimeOptions {
  onPhaseChange?: (phase: ImageImportPhase) => void;
  uploadFile?: (
    file: File,
    signal?: AbortSignal,
  ) => Promise<{
    url: string;
    commit(): Promise<void>;
    rollback(): Promise<void>;
  }>;
  /**
   * Position of this image within a multi-file import (0-based). Each image is
   * offset diagonally from the centered position so a batch drop doesn't stack
   * them invisibly on top of each other.
   */
  placementIndex?: number;
  signal?: AbortSignal;
}

const MULTI_IMPORT_CASCADE_STEP = 24;

// block obvious private/loopback hostnames to limit SSRF surface
// (full DNS-rebinding prevention is not possible client-side, but this
// catches the trivial cases — literal IPs and known-loopback names)
const PRIVATE_HOSTNAME_RE =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|::1|fc00:|fd[0-9a-f]{2}:|fe80:)/i;
const WHITEBOARD_OPTIMIZED_IMAGE_MAX_EDGE = 2400;
const WHITEBOARD_OPTIMIZED_IMAGE_TARGET_BYTES = 2 * 1024 * 1024;
const WHITEBOARD_OPTIMIZED_IMAGE_QUALITY = 0.9;

function isSafeImageHostname(parsed: URL): boolean {
  const h = parsed.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (PRIVATE_HOSTNAME_RE.test(h)) return false;
  if (!["http:", "https:"].includes(parsed.protocol)) return false;
  return true;
}

function shouldOptimizeImageForWhiteboard(
  file: File,
  width: number,
  height: number,
): boolean {
  return (
    file.type !== "image/gif" &&
    (file.size > WHITEBOARD_OPTIMIZED_IMAGE_TARGET_BYTES ||
      width > WHITEBOARD_OPTIMIZED_IMAGE_MAX_EDGE ||
      height > WHITEBOARD_OPTIMIZED_IMAGE_MAX_EDGE)
  );
}

function replaceFileExtension(filename: string, nextExtension: string): string {
  const trimmed = filename.trim();
  if (!trimmed) return `whiteboard-image.${nextExtension}`;

  const lastDot = trimmed.lastIndexOf(".");
  if (lastDot <= 0) {
    return `${trimmed}.${nextExtension}`;
  }

  return `${trimmed.slice(0, lastDot)}.${nextExtension}`;
}

async function canvasToBlob(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob | null> {
  if ("convertToBlob" in canvas) {
    return canvas.convertToBlob({ type, quality });
  }

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

async function maybeOptimizeImageForWhiteboard(
  file: File,
  width: number,
  height: number,
): Promise<{ file: File; width: number; height: number }> {
  if (
    !shouldOptimizeImageForWhiteboard(file, width, height) ||
    typeof createImageBitmap !== "function"
  ) {
    return { file, width, height };
  }

  const scale = Math.min(
    1,
    WHITEBOARD_OPTIMIZED_IMAGE_MAX_EDGE / width,
    WHITEBOARD_OPTIMIZED_IMAGE_MAX_EDGE / height,
  );
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { file, width, height };
  }

  try {
    let canvas: OffscreenCanvas | HTMLCanvasElement;
    if (typeof OffscreenCanvas !== "undefined") {
      canvas = new OffscreenCanvas(targetWidth, targetHeight);
    } else {
      const htmlCanvas = document.createElement("canvas");
      htmlCanvas.width = targetWidth;
      htmlCanvas.height = targetHeight;
      canvas = htmlCanvas;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx || !("drawImage" in ctx)) {
      return { file, width, height };
    }

    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

    const optimizedBlob = await canvasToBlob(
      canvas,
      "image/webp",
      WHITEBOARD_OPTIMIZED_IMAGE_QUALITY,
    );

    if (
      !optimizedBlob ||
      optimizedBlob.size === 0 ||
      optimizedBlob.size > WHITEBOARD_MAX_IMAGE_BYTES
    ) {
      return { file, width, height };
    }

    const becameSmaller = optimizedBlob.size < file.size;
    const stayedWithinTarget = optimizedBlob.size <= WHITEBOARD_OPTIMIZED_IMAGE_TARGET_BYTES;
    const resized = targetWidth !== width || targetHeight !== height;
    if (!becameSmaller && !(resized && stayedWithinTarget)) {
      return { file, width, height };
    }

    const optimizedFile = new File(
      [optimizedBlob],
      replaceFileExtension(file.name, "webp"),
      { type: "image/webp" },
    );

    return {
      file: optimizedFile,
      width: targetWidth,
      height: targetHeight,
    };
  } finally {
    bitmap.close();
  }
}

export async function readImageResponseAsFile(
  response: Response,
  sourceUrl: string,
): Promise<File> {
  const contentType = response.headers.get("content-type");
  if (!contentType?.startsWith("image/")) {
    throw new Error("URL does not point to an image");
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (Number.isFinite(size) && size > WHITEBOARD_MAX_IMAGE_BYTES) {
      throw new Error("Image must be smaller than 10MB");
    }
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Failed to read response body");
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > WHITEBOARD_MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new Error("Image must be smaller than 10MB");
    }
    chunks.push(value);
  }

  const buffer = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const pathname = new URL(sourceUrl).pathname;
  let filename = "external-image.png";
  try {
    const decoded = decodeURIComponent(pathname.split("/").pop() || "").trim();
    if (decoded) filename = decoded;
  } catch {}

  return new File([new Blob([buffer], { type: contentType })], filename, {
    type: contentType,
  });
}

/**
 * Fetch an external image URL and convert it to a File object.
 * Handles CORS by fetching through the browser's fetch API.
 */
export async function fetchExternalImage(
  url: string,
  signal?: AbortSignal,
): Promise<File> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid image URL");
  }
  if (!isSafeImageHostname(parsed)) {
    throw new Error("Image URL hostname is not allowed");
  }
  try {
    const timeoutSignal = AbortSignal.timeout(15_000);
    const response = await fetch(url, {
      signal: signal ? anySignal([signal, timeoutSignal]) : timeoutSignal,
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`);
    }
    return await readImageResponseAsFile(response, url);
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error('Failed to fetch image - CORS or network error');
    }
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error('Image fetch timed out');
    }
    throw err;
  }
}

/**
 * Upload an image file and insert it on a whiteboard page.
 * Used by both clipboard paste and file import.
 */
export async function importImageToWhiteboard(
  editor: Editor,
  file: File,
  pageManager: PageManager,
  currentPageNumber?: number,
  options?: ImageImportRuntimeOptions,
): Promise<void> {
  const { onPhaseChange, uploadFile, placementIndex = 0, signal } = options ?? {};
  signal?.throwIfAborted();
  const isImage =
    isSupportedWhiteboardImageMimeType(file.type) ||
    isSupportedWhiteboardImageFileName(file.name);
  if (!isImage) {
    throw new Error("Supported image formats: PNG, JPEG, GIF, WEBP");
  }

  if (file.size > WHITEBOARD_MAX_IMAGE_BYTES) {
    throw new Error("Image must be smaller than 10MB");
  }

  // Coerce missing MIME type (macOS Finder drag-and-drop often omits it).
  let fileToImport = file;
  if (!isSupportedWhiteboardImageMimeType(file.type)) {
    const mimeType = inferWhiteboardImageMimeTypeFromFileName(file.name);
    if (!mimeType) {
      throw new Error("Supported image formats: PNG, JPEG, GIF, WEBP");
    }
    fileToImport = new File([file], file.name, { type: mimeType });
  }

  onPhaseChange?.("preparing");

  // Read dimensions from file header bytes — no full browser image decode.
  // Falls back to tldraw's asset util (Image element load) if parsing fails.
  let width: number;
  let height: number;
  const headerDims = await readImageDimensionsFromFile(fileToImport);
  if (headerDims && headerDims.width > 0 && headerDims.height > 0) {
    width = headerDims.width;
    height = headerDims.height;
  } else {
    const assetUtil = editor.getAssetUtilForMimeType(fileToImport.type);
    if (!assetUtil) throw new Error("Could not create image asset");
    const info = await assetUtil.getAssetFromFile(
      fileToImport,
      AssetRecordType.createId(),
    );
    if (!info || info.type !== "image") throw new Error("Could not create image asset");
    width = info.props.w;
    height = info.props.h;
  }

  const MAX_IMAGE_DIMENSION = 10_000;
  if (
    !Number.isFinite(width) || !Number.isFinite(height) ||
    width <= 0 || height <= 0 ||
    width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION
  ) {
    throw new Error(`Image dimensions (${width}x${height}) are invalid or too large`);
  }

  const optimizedImage = await maybeOptimizeImageForWhiteboard(
    fileToImport,
    width,
    height,
  );
  signal?.throwIfAborted();
  const fileToUpload = optimizedImage.file;
  width = optimizedImage.width;
  height = optimizedImage.height;

  const assetId = AssetRecordType.createId();
  const asset = AssetRecordType.create({
    id: assetId,
    type: "image",
    typeName: "asset",
    props: {
      name: fileToUpload.name,
      src: "",
      w: width,
      h: height,
      mimeType: fileToUpload.type,
      isAnimated: false,
      fileSize: fileToUpload.size,
    },
    meta: {},
  });

  // Get target frame from current page
  const pages = pageManager.getPages();
  let frameId: TLShapeId;
  if (pages.length === 0) {
    const newFrameId = pageManager.createPage();
    if (!newFrameId) throw new Error("Could not create page");
    frameId = newFrameId;
  } else if (
    currentPageNumber &&
    currentPageNumber >= 1 &&
    currentPageNumber <= pages.length
  ) {
    frameId = pages[currentPageNumber - 1].id;
  } else {
    const detectedPage = pageManager.getCurrentPage();
    frameId = pages[Math.min(detectedPage - 1, pages.length - 1)].id;
  }

  const frame = editor.getShape(frameId);
  if (!frame || !isPageFrameShape(frame)) {
    // throw instead of silently returning so callers can surface the error
    throw new Error("Target whiteboard page not found");
  }

  const cascade = placementIndex * MULTI_IMPORT_CASCADE_STEP;

  onPhaseChange?.("uploading");
  const managedUpload = uploadFile
    ? await uploadFile(fileToUpload, signal)
    : null;
  const uploadResult = managedUpload
    ? { src: managedUpload.url }
    : await editor.uploadAsset(asset, fileToUpload);
  const uploadedAsset = AssetRecordType.create({
    id: assetId,
    type: "image",
    typeName: "asset",
    props: {
      name: fileToUpload.name,
      src: uploadResult.src,
      w: width,
      h: height,
      mimeType: fileToUpload.type,
      isAnimated: false,
      fileSize: fileToUpload.size,
    },
    meta: {},
  });

  // The upload can finish just as edit access is revoked or the component
  // unmounts. Do not commit bytes for an import that is already cancelled.
  if (signal?.aborted) {
    await managedUpload?.rollback().catch(() => {});
    signal.throwIfAborted();
  }

  onPhaseChange?.("placing");
  await warmUploadedImage(editor, uploadedAsset, signal);

  // Preserve current camera so zoom doesn't change after paste
  // Taken when the shape is created, not before the upload: the user may pan
  // while a large image uploads, and that view is theirs to keep.
  let cameraBeforePaste = editor.getCamera();

  const shapeId = createShapeId();
  try {
    await commitUploadBeforePublish(managedUpload, () => {
      signal?.throwIfAborted();
      cameraBeforePaste = editor.getCamera();
      // Measured now, not before the upload: the view may have moved since.
      const frameBounds = editor.getShapePageBounds(frameId);
      const placed = placeImageOnPage(
        { w: width, h: height },
        {
          x: frameBounds?.x ?? 0,
          y: frameBounds?.y ?? 0,
          w: (frame.props as { w: number }).w,
          h: (frame.props as { h: number }).h,
        },
        frameBounds ? editor.getViewportPageBounds() : null,
        cascade,
      );
      editor.run(() => {
        editor.createAssets([uploadedAsset]);
        editor.createShape({
          id: shapeId,
          type: "image",
          parentId: frameId,
          x: placed.x,
          y: placed.y,
          props: {
            assetId: asset.id,
            w: placed.w,
            h: placed.h,
          },
        });
      });
      if (!editor.getAsset(assetId) || !editor.getShape(shapeId)) {
        throw new Error("Image could not be placed on the whiteboard");
      }
    });
    signal?.throwIfAborted();
  } catch (error) {
    if (editor.getShape(shapeId)) editor.deleteShape(shapeId);
    if (editor.getAsset(assetId)) editor.deleteAssets([assetId]);
    throw error;
  }

  // Restore camera to prevent zoom change on paste
  editor.setCamera(cameraBeforePaste, { animation: { duration: 0 } });

  // Switch to select tool so the user can immediately interact with the pasted image
  editor.setCurrentTool("select");
  editor.setSelectedShapes([shapeId]);
}

/** Long enough for a normal fetch; short enough that a slow one never holds the image back. */
const IMAGE_WARM_TIMEOUT_MS = 4000;

/**
 * Fetch and decode the uploaded image before its shape exists.
 *
 * The shape draws from the stored copy, not the file in hand, so placed at once
 * it showed as an empty selection box for the seconds that copy took to load.
 * Warmed first, it appears with its picture. A failure or a slow load is no
 * reason to withhold the image, so either one just stops the wait.
 */
async function warmUploadedImage(
  editor: Editor,
  asset: TLAsset,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const url = await editor.store.props.assets.resolve(asset, {
      screenScale: 1,
      steppedScreenScale: 1,
      dpr: window.devicePixelRatio || 1,
      networkEffectiveType: null,
      shouldResolveToOriginal: false,
    });
    if (!url) return;
    const image = new Image();
    image.src = url;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      image.decode(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, IMAGE_WARM_TIMEOUT_MS);
        signal?.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]).finally(() => clearTimeout(timer));
  } catch {
    // Placing the image matters more than placing it pre-loaded.
  }
}
