import { useCallback, useMemo, useState } from "react";

import { buildWhiteboardAssetViewerUrl } from "@orbmeet/whiteboard-core/whiteboard-asset-key";
import type { UploadFileFn } from "@orbmeet/whiteboard-client/react";

import { createPdfLibrary } from "@/modules/whiteboards/client/meeting/whiteboard-pdf-library";
import {
  finalizeWhiteboardUpload,
  getWhiteboardUploadUrl,
} from "@/modules/whiteboards/server/uploads.functions";
import { getServerErrorStatusCode } from "@/lib/error-inspection";

export type WhiteboardUploadItem = {
  id: string;
  name: string;
  progress: number | null;
};

interface WhiteboardDocumentAssetsOptions {
  whiteboardId: string;
  meeting?: {
    meetingId: string;
    connectionId: string;
  };
}

/**
 * Document-scoped asset services shared by Meeting and standalone editors.
 * Meeting identity is only transport authority; storage, PDFs, and viewer URLs
 * belong to the Whiteboard document itself.
 */
export function useWhiteboardDocumentAssets({
  whiteboardId,
  meeting,
}: WhiteboardDocumentAssetsOptions) {
  const [uploads, setUploads] = useState<WhiteboardUploadItem[]>([]);
  const meetingId = meeting?.meetingId;
  const connectionId = meeting?.connectionId;

  const uploadFile: UploadFileFn = useCallback(async (file: File, signal?: AbortSignal) => {
    if (signal?.aborted) {
      throw new DOMException("Upload aborted", "AbortError");
    }

    const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setUploads((current) => [...current, {
      id: uploadId,
      name: file.name,
      progress: null,
    }]);
    let rollbackUpload: (() => Promise<void>) | null = null;

    try {
      const documentAuthority = meetingId
        ? { meetingId, connectionId }
        : {};
      const { uploadUrl, assetUrl } = await getWhiteboardUploadUrl({
        data: {
          filename: file.name,
          mimeType: file.type,
          fileSize: file.size,
          whiteboardId,
          ...documentAuthority,
        },
        signal,
      });

      // Finalization is single-choice. In particular, an ambiguous commit must
      // never be followed by a destructive rollback when its response is lost.
      let finalizing: Promise<void> | null = null;
      let chosenAction: "commit" | "rollback" | null = null;
      const finalize = (action: "commit" | "rollback"): Promise<void> => {
        if (chosenAction && chosenAction !== action) {
          return chosenAction === "commit"
            ? Promise.resolve()
            : Promise.reject(new Error("Whiteboard upload was rolled back"));
        }
        chosenAction = action;
        finalizing ??= finalizeWhiteboardUpload({
          data: {
            action,
            assetUrl,
            whiteboardId,
            ...documentAuthority,
          },
        })
          .then(() => undefined)
          .catch((error: unknown) => {
            finalizing = null;
            // A structured HTTP failure proves the commit did not complete, so
            // the managed-upload wrapper may safely issue rollback. Transport
            // failures remain latched because their server outcome is unknown.
            if (action === "rollback" || getServerErrorStatusCode(error) !== undefined) {
              chosenAction = null;
            }
            throw error;
          });
        return finalizing;
      };
      rollbackUpload = () => finalize("rollback");

      // AbortSignal does not replay an earlier abort to the XHR listener below.
      if (signal?.aborted) {
        throw new DOMException("Upload aborted", "AbortError");
      }

      setUploads((current) => current.map((upload) =>
        upload.id === uploadId ? { ...upload, progress: 0 } : upload
      ));

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const abortUpload = () => xhr.abort();
        const cleanup = () => signal?.removeEventListener("abort", abortUpload);
        signal?.addEventListener("abort", abortUpload, { once: true });
        xhr.upload.addEventListener("progress", (event) => {
          if (!event.lengthComputable) return;
          const progress = Math.round((event.loaded / event.total) * 100);
          setUploads((current) => current.map((upload) =>
            upload.id === uploadId ? { ...upload, progress } : upload
          ));
        });
        xhr.addEventListener("load", () => {
          cleanup();
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`Upload failed: ${xhr.status}`));
        });
        xhr.addEventListener("error", () => {
          cleanup();
          reject(new Error("Upload failed"));
        });
        xhr.addEventListener("abort", () => {
          cleanup();
          reject(new DOMException("Upload aborted", "AbortError"));
        });
        xhr.open("PUT", uploadUrl);
        xhr.setRequestHeader("Content-Type", file.type);
        xhr.send(file);
      });

      return {
        url: assetUrl,
        commit: () => finalize("commit"),
        rollback: () => finalize("rollback"),
      };
    } catch (error) {
      await rollbackUpload?.().catch(() => {});
      throw error;
    } finally {
      setUploads((current) => current.filter((upload) => upload.id !== uploadId));
    }
  }, [connectionId, meetingId, whiteboardId]);

  const resolveAssetUrl = useCallback(
    (src: string) => buildWhiteboardAssetViewerUrl(src, whiteboardId),
    [whiteboardId],
  );
  const pdfLibrary = useMemo(() => createPdfLibrary(whiteboardId), [whiteboardId]);
  return {
    pdfLibrary,
    resolveAssetUrl,
    uploadFile,
    uploads,
  };
}
