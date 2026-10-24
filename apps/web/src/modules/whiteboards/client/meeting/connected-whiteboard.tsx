import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";

import { SyncedWhiteboard } from "@orbmeet/whiteboard-client/react";
import { WHITEBOARD_ASSET_URLS } from "@/modules/whiteboards/client/surface/whiteboard-canvas";
import { useWhiteboardDocumentAssets } from "@/modules/whiteboards/client/components/use-whiteboard-document-assets";
import { WhiteboardUploadProgress } from "@/modules/whiteboards/client/components/whiteboard-upload-progress";
import { PageManager } from "@orbmeet/whiteboard-client/react";
import { WHITEBOARD_EVENTS } from "@orbmeet/whiteboard-core/protocol";
import type { RoomMessage } from "@orbmeet/whiteboard-core/room-messages";
import { requestWhiteboardEditAccess, grantWhiteboardEditAccess, recordWhiteboardPagePresented, addWhiteboardPage, setWhiteboardNavigationController, releaseWhiteboardNavigationController, recordWhiteboardPageEdit } from "@/modules/whiteboards/server/meeting-actions.functions";
import { useResponsive } from "@/lib/hooks/use-responsive";
import { useToast } from "@orbmeet/ui/react";
import { useCommittedRef } from "@orbmeet/ui/react";
import type { WhiteboardToast } from "@orbmeet/whiteboard-client/react";
import type { SyncedWhiteboardHandle } from "@orbmeet/whiteboard-client/react";
import type { PendingEditorAccessRequest } from "@orbmeet/whiteboard-client/react";
import type { WhiteboardFollowState } from "@orbmeet/whiteboard-client/react";
import { resolveWhiteboardChrome } from "@orbmeet/whiteboard-client/react";
import type { WhiteboardChromeConfig } from "@orbmeet/whiteboard-client/react";
import type { WhiteboardConnectAttempt } from "@orbmeet/whiteboard-client/react";
import type { AssistantHost } from "@orbmeet/whiteboard-client/react";
import type { Editor } from "tldraw";
import { getWhiteboardClientCapabilities } from "@/lib/browser-capabilities";
import { changeTouchesPageFrames } from "@orbmeet/whiteboard-core/page-frame-model";
import { getEditedPageIdsFromChanges } from "./edited-page-attribution";
import { createPageEditBatcher } from "./page-edit-batcher";
import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({
  fill: { position: "relative", width: "100%", height: "100%" },
});

// Trailing delay for batching page-edit marker writes after a local gesture.
const EDITED_PAGE_SETTLE_MS = 500;

/**
 * Handle the Meeting holds on the connected Whiteboard: the canvas
 * handle plus the pending-request bookkeeping this wrapper adds.
 */
export interface MeetingWhiteboardHandle extends SyncedWhiteboardHandle {
  clearPendingRequest: (principalKey: string) => void;
}

export type { PendingEditorAccessRequest };

interface MeetingWhiteboardProps {
  ref?: Ref<MeetingWhiteboardHandle>;
  whiteboardUrl: string;
  token: string;
  getWebSocketUri?: (attempt: WhiteboardConnectAttempt) => Promise<string>;
  meetingId: string;
  whiteboardId: string;
  connectionId: string;
  onStatusChange?: (status: "loading" | "ready" | "fatal") => void;
  onConnectionStatusChange?: (status: "online" | "offline") => void;
  onContentStateChange?: (hasContent: boolean) => void;
  aiEnabled?: boolean;
  /** The meeting shows Orb's conversation in its Timeline, not on the board. */
  assistantHost?: AssistantHost;
  onPendingEditorRequestsChange?: (requests: PendingEditorAccessRequest[]) => void;
  onFollowStateChange?: (state: WhiteboardFollowState | null) => void;
  /** Guests have no Space to file a PDF in; theirs go straight onto the board. */
  isAuthenticated: boolean;
}

export function MeetingWhiteboard({
  ref,
  whiteboardUrl,
  token,
  getWebSocketUri,
  meetingId,
  whiteboardId,
  connectionId,
  onStatusChange,
  onConnectionStatusChange,
  onContentStateChange,
  aiEnabled,
  assistantHost,
  onPendingEditorRequestsChange,
  onFollowStateChange,
  isAuthenticated,
}: MeetingWhiteboardProps) {
  const responsive = useResponsive();
  // Phones keep the compact strip; every other board, an upright tablet's
  // included, gets the palette — see `whiteboard-chrome-fit.ts`.
  const whiteboardChrome = useMemo<WhiteboardChromeConfig>(
    () =>
      resolveWhiteboardChrome({
        isPhone: responsive.isPhone,
        isPhonePortrait: responsive.isPhone && !responsive.isLandscape,
      }),
    [responsive.isLandscape, responsive.isPhone],
  );
  // The whiteboard mounts tldraw with `hideUi`, which strips tldraw's own toast
  // renderer, so notifications raised inside the whiteboard package have to come
  // out through the meeting's toaster to be seen at all.
  const { add: addAppToast } = useToast();
  const handleWhiteboardToast = useCallback(
    (toast: WhiteboardToast) => {
      addAppToast({
        title: toast.title,
        description: toast.description,
        data: { variant: toast.variant ?? "info" },
      });
    },
    [addAppToast],
  );
  const [pendingEditorRequests, setPendingEditorRequests] = useState<PendingEditorAccessRequest[]>([]);
  const {
    pdfLibrary,
    resolveAssetUrl,
    uploadFile,
    uploads,
  } = useWhiteboardDocumentAssets({
    whiteboardId,
    meeting: { meetingId, connectionId },
  });
  const whiteboardRef = useRef<SyncedWhiteboardHandle | null>(null);
  const editorActivityCleanupRef = useRef<(() => void) | null>(null);
  const recordedEditedPageIdsRef = useRef(new Set<string>());
  // The same for pages presented: the first time is what is recorded.
  const recordedPresentedPageIdsRef = useRef(new Set<string>());

  // Deliberately not keyed on connectionId as well. This is a dedup cache for a
  // write that carries no connection dimension — `meeting_whiteboard_pages` is
  // keyed by (whiteboard, page) and coalesces the first timestamp — so a page
  // already recorded stays recorded across a connection rotation, and clearing
  // would only replay no-op writes. A write *rejected* against a retired
  // connection rejects the server fn, and the catch below evicts the page id, so
  // that case already retries on the next edit.
  useEffect(() => {
    recordedEditedPageIdsRef.current.clear();
    recordedPresentedPageIdsRef.current.clear();
  }, [meetingId, whiteboardId]);

  useEffect(() => () => editorActivityCleanupRef.current?.(), []);

  useImperativeHandle(
    ref,
    () => ({
      clearPendingRequest: (principalKey: string) => {
        setPendingEditorRequests((prev) => prev.filter((r) => r.principalKey !== principalKey));
      },
      presentCurrentPage: () => whiteboardRef.current?.presentCurrentPage() ?? false,
    }),
    [],
  );

  // Pending requests are received in real-time via WebSocket access messages.
  // No polling needed — see handleCustomMessage below

  const handleRequestEditAccess = useCallback(async (): Promise<{ status?: string } | void> => {
    const result = await requestWhiteboardEditAccess({
      data: {
        meetingId,
        whiteboardId,
        connectionId,
      },
    });
    if (!result || typeof result !== "object") return;

    const status = (result as { status?: unknown }).status;
    if (typeof status === "string") {
      return { status };
    }
  }, [meetingId, whiteboardId, connectionId]);

  const handlePagePresented = useCallback((pageId: string) => {
    if (recordedPresentedPageIdsRef.current.has(pageId)) return;
    recordedPresentedPageIdsRef.current.add(pageId);
    void recordWhiteboardPagePresented({
      data: { meetingId, whiteboardId, pageId, connectionId },
    }).catch((error: unknown) => {
      recordedPresentedPageIdsRef.current.delete(pageId);
      console.warn("[WB] Failed to record presented page:", { meetingId, whiteboardId, pageId, error });
    });
  }, [meetingId, whiteboardId, connectionId]);

  // The editor's lifetime is owned by tldraw's onMount/unmount, so this callback
  // runs exactly twice per canvas and must never close over a changing value: a
  // connection rotation would otherwise leave the listener below recording under
  // a retired connectionId, where every write is rejected and silently dropped.
  const editorActivityScopeRef = useCommittedRef({ meetingId, whiteboardId, connectionId });

  const handleEditorReady = useCallback((editor: Editor | null) => {
    editorActivityCleanupRef.current?.();
    editorActivityCleanupRef.current = null;
    if (!editor) return;

    const pageManager = new PageManager(editor);
    let pages = pageManager.getPages();

    // Attribution happens synchronously from each document diff, while its old
    // and new records still identify the page that changed. Only the network
    // writes are delayed; camera navigation during that delay cannot reassign
    // an edit to whichever page happens to be visible later.
    const editBatcher = createPageEditBatcher((pageIds) => {
      const { meetingId, whiteboardId, connectionId } = editorActivityScopeRef.current;
      for (const pageId of pageIds) {
        if (recordedEditedPageIdsRef.current.has(pageId)) continue;
        recordedEditedPageIdsRef.current.add(pageId);
        void recordWhiteboardPageEdit({
          data: { meetingId, whiteboardId, pageId, connectionId },
        }).catch((error: unknown) => {
          recordedEditedPageIdsRef.current.delete(pageId);
          console.warn("[WB] Failed to record edited page:", {
            meetingId,
            whiteboardId,
            pageId,
            error,
          });
        });
      }
    }, EDITED_PAGE_SETTLE_MS);

    const scheduleRecord = (entry: {
      source: "user" | "remote";
      changes: Parameters<typeof getEditedPageIdsFromChanges>[2];
    }) => {
      // Page frames change only through infrequent manager/server operations.
      // Keep their sorted geometry cached instead of walking every canvas shape
      // on each pointer move of a freehand stroke.
      if (changeTouchesPageFrames(entry.changes)) pages = pageManager.getPages();
      if (entry.source !== "user") return;
      const pageIds = getEditedPageIdsFromChanges(editor, pages, entry.changes);
      if (pageIds.length === 0) return;
      editBatcher.schedule(pageIds);
    };

    const unsubscribe = editor.store.listen(scheduleRecord, {
      source: "all",
      scope: "document",
    });

    editorActivityCleanupRef.current = () => {
      unsubscribe();
      editBatcher.dispose();
    };
  }, [editorActivityScopeRef]);

  const handleAddPage = useCallback(async (target?: { afterPageNumber?: number }) => {
    return addWhiteboardPage({
      data: {
        meetingId,
        whiteboardId,
        connectionId,
        afterPageNumber: target?.afterPageNumber,
      },
    });
  }, [meetingId, whiteboardId, connectionId]);

  const handleSetNavigationController = useCallback(async (targetUserId: string) => {
    await setWhiteboardNavigationController({ data: { meetingId, whiteboardId, targetUserId, connectionId } });
  }, [meetingId, whiteboardId, connectionId]);

  // Handing the board to someone who cannot write yet gives them edit access first.
  const handleGrantEditAccess = useCallback(async (targetPrincipalKey: string) => {
    await grantWhiteboardEditAccess({ data: { meetingId, whiteboardId, targetPrincipalKey, connectionId } });
  }, [meetingId, whiteboardId, connectionId]);

  const handleReleaseNavigationController = useCallback(async () => {
    await releaseWhiteboardNavigationController({ data: { meetingId, whiteboardId, connectionId } });
  }, [meetingId, whiteboardId, connectionId]);

  // Typed by the union, but off the wire: each request is checked before it is shown.
  const handleCustomMessage = useCallback((message: RoomMessage) => {
    if (message.type === WHITEBOARD_EVENTS.ACCESS_REQUESTED) {
      if (typeof message.userId !== "string" || typeof message.userName !== "string") return;
      const request: PendingEditorAccessRequest = {
        principalKey: typeof message.principalKey === "string" ? message.principalKey : message.userId,
        userId: message.userId,
        userName: message.userName,
      };
      setPendingEditorRequests((prev) =>
        prev.some((r) => r.principalKey === request.principalKey) ? prev : [...prev, request],
      );
      return;
    }
    if (message.type === WHITEBOARD_EVENTS.STATE) {
      const payload: unknown[] = Array.isArray(message.pendingEditorRequests) ? message.pendingEditorRequests : [];
      setPendingEditorRequests(payload.filter(isPendingEditorAccessRequest));
    }
  }, []);

  useEffect(() => {
    onPendingEditorRequestsChange?.(pendingEditorRequests);
  }, [onPendingEditorRequestsChange, pendingEditorRequests]);

  return (
    <div {...stylex.props(styles.fill)}>
      <SyncedWhiteboard
        capabilities={getWhiteboardClientCapabilities()}
        licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY || undefined}
        ref={whiteboardRef}
        whiteboardUrl={whiteboardUrl}
        documentId={whiteboardId}
        token={token}
        getWebSocketUri={getWebSocketUri}
        assetUrls={WHITEBOARD_ASSET_URLS}
        uploadFile={uploadFile}
        pdfLibrary={isAuthenticated ? pdfLibrary : undefined}
        resolveAssetUrl={resolveAssetUrl}
        onEditorReady={handleEditorReady}
        onRequestEditAccess={handleRequestEditAccess}
        chrome={whiteboardChrome}
        onStatusChange={onStatusChange}
        onConnectionStatusChange={onConnectionStatusChange}
        onContentStateChange={onContentStateChange}
        aiEnabled={aiEnabled}
        assistantHost={assistantHost}
        presents
        onPagePresented={handlePagePresented}
        onFollowStateChange={onFollowStateChange}
        onAddPage={handleAddPage}
        onSetNavigationController={handleSetNavigationController}
        onGrantEditAccess={handleGrantEditAccess}
        onReleaseNavigationController={handleReleaseNavigationController}
        onCustomMessage={handleCustomMessage}
        onToast={handleWhiteboardToast}
        surfaceOverlay={<WhiteboardUploadProgress uploads={uploads} />}
      />
    </div>
  );
}

function isPendingEditorAccessRequest(value: unknown): value is PendingEditorAccessRequest {
  if (!value || typeof value !== "object") return false;
  const { principalKey, userId, userName } = value as Record<string, unknown>;
  return typeof principalKey === "string" && typeof userId === "string" && typeof userName === "string";
}
