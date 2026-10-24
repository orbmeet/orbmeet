/**
 * Whiteboard React components
 * Exports wrapped tldraw components for use in client apps.
 */

import { Tldraw, type TLAssetStore } from "tldraw";
import { useSync } from "@tldraw/sync";
export {
  roomSnapshotToStoreSnapshot,
  type RoomSnapshotDocument,
  type RoomSnapshotForStoreConversion,
} from "./sync/room-snapshot-conversion";

export { Tldraw, useSync };
export type { TLAssetStore };

/**
 * Full meeting whiteboard with pages, custom toolbar, status bar,
 * GoodNotes-style laser, stroke eraser, and page shadows.
 */
export { buildWhiteboardPdfBlob, mergeWhiteboardPdfBlobs } from "./assets/export-pdf";
export { SyncedWhiteboard } from "./synced-whiteboard";
export type {
  SyncedWhiteboardHandle,
  SyncedWhiteboardProps,
  PdfLibrary,
  PdfLibraryFile,
  UploadFileFn,
  AddWhiteboardPageFn,
} from "./synced-whiteboard";
export type { AssistantHost, AssistantPromptOptions, AssistantView } from "./assistant/use-assistant";
export type { WhiteboardClientCapabilities } from "./editor/client-capabilities";
export type { WhiteboardConnectAttempt } from "./sync/whiteboard-socket-adapter";

export { RecorderWhiteboard } from "./recorder-whiteboard";
export type { RecorderWhiteboardProps } from "./recorder-whiteboard";
export {
  defineWhiteboardServiceEndpoints,
  type WhiteboardServiceEndpoints,
} from "./sync/service-endpoints";
export type { PendingEditorAccessRequest } from "./synced-whiteboard";
export { WB_ASSET_URLS } from "./assets/engine-asset-urls";
export {
  forceRenderSingleFrameLikeShape,
  getDrawableShapeEntries,
  getFrameExportContent,
} from "./pages/export-page-membership";
export { PageManager, type WhiteboardPage } from "./pages/page-manager";
export { WHITEBOARD_TLDRAW_OPTIONS } from "./editor/tldraw-options";
export type { WhiteboardFollowState } from "./camera/whiteboard-follow";
export { WHITEBOARD_TOOLBAR_HEIGHT } from "./camera/viewport-insets";
export type { WhiteboardChromeConfig } from "./chrome/whiteboard-chrome";
export { resolveWhiteboardChrome } from "./chrome/whiteboard-chrome-fit";
export { whiteboardShapeUtils } from "./editor/whiteboard-shapes";
export type { WhiteboardToast } from "./chrome/whiteboard-toast";
export type { Editor, TLShapeId } from "tldraw";
