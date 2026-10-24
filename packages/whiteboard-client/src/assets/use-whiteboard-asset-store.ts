import { useMemo } from "react";
import { type TLAssetStore } from "tldraw";

interface UploadedWhiteboardFile {
  url: string;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export type UploadFileFn = (
  file: File,
  signal?: AbortSignal,
) => Promise<UploadedWhiteboardFile>;

interface UseWhiteboardAssetStoreOptions {
  uploadFile?: UploadFileFn;
  resolveAssetUrl?: (src: string) => string;
}

export function useWhiteboardAssetStore({
  uploadFile,
  resolveAssetUrl,
}: UseWhiteboardAssetStoreOptions): TLAssetStore | undefined {
  return useMemo<TLAssetStore | undefined>(() => {
    if (!uploadFile && !resolveAssetUrl) return undefined;

    return {
      async upload(_asset, file, abortSignal) {
        if (!uploadFile) return { src: "" };
        const result = await uploadFile(file, abortSignal);
        // The caller can abort between handing us the file and the upload
        // resolving; nothing will ever create a record for this src, so release
        // it now instead of holding storage for the rollback window.
        if (abortSignal?.aborted) {
          await result.rollback().catch(() => {});
          throw new DOMException("Upload aborted", "AbortError");
        }
        // TLAssetStore publishes the returned src into the collaborative record
        // immediately. Finalize first so no peer can ever observe a pending URL.
        try {
          await result.commit();
        } catch (error) {
          await result.rollback().catch(() => {});
          throw error;
        }
        return { src: result.url };
      },
      resolve(asset, _ctx) {
        const src = asset.props.src ?? null;
        return src ? resolveAssetUrl?.(src) ?? src : null;
      },
    };
  }, [resolveAssetUrl, uploadFile]);
}
