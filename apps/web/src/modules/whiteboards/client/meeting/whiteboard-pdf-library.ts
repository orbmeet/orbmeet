import type { PdfLibrary } from "@orbmeet/whiteboard-client/react";
import {
  finalizePdfFileUpload,
  grantPdfFileUpload,
  listInsertablePdfs,
} from "@/modules/spaces/server/files.functions";

/**
 * Insert PDF, backed by the Space's Files.
 *
 * `space_assets` is documented as "PDF imports for the whiteboard" and had no
 * writer: every import was rasterized to per-page PNGs and the source document
 * was thrown away. So the same PDF had to be re-uploaded from disk for every
 * class, and the Files tab never showed it. Filing the source here is what
 * makes "insert the problem set again next week" a name to pick rather than a
 * file to find.
 *
 * The rasterized pages are unchanged — they are still what the canvas renders.
 * This adds the source document beside them, and `sourceFileId` on each page
 * records which one it came from.
 */
export function createPdfLibrary(whiteboardId: string): PdfLibrary {
  return {
    list: async () => {
      const { files } = await listInsertablePdfs({ data: { whiteboardId } });
      return files;
    },

    save: async (file: File) => {
      const grant = await grantPdfFileUpload({
        data: { whiteboardId, filename: file.name, fileSize: file.size },
      });
      const upload = await fetch(grant.uploadUrl, {
        method: "PUT",
        headers: grant.headers,
        body: file,
      });
      if (!upload.ok) {
        throw new Error(`Upload failed (${upload.status})`);
      }
      // Registration is separate from the PUT: the row records the size R2
      // actually stored, so a client that under-reported at grant time cannot
      // under-count its own quota.
      return finalizePdfFileUpload({
        data: { whiteboardId, assetId: grant.assetId, filename: file.name },
      });
    },
  };
}
