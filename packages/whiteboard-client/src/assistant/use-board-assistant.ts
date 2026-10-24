import { useCallback, useEffect, type RefObject } from "react";
import { Box, type Editor, type TLShapeId } from "tldraw";
import { useCommittedRef } from "@orbmeet/ui/react";
import type { FollowedPresenter } from "../camera/use-room-navigation";
import type { PageManager } from "../pages/page-manager";
import type { UseWhiteboardPagesReturn } from "../pages/use-whiteboard-pages";
import type { RoomChannel } from "../sync/room-channel";
import { useAssistant, type AssistantHost } from "./use-assistant";

interface BoardAssistantOptions {
  channel: RoomChannel;
  /** The host offers the assistant on this board. */
  enabled: boolean;
  whiteboardUrl: string;
  tokenRef: RefObject<string>;
  userId: string | null;
  editor: Editor | null;
  pages: UseWhiteboardPagesReturn;
  pageManagerRef: RefObject<PageManager | null>;
  canManageWhiteboard: boolean;
  syncReady: boolean;
  syncOnline: boolean;
  /** Whether this participant may write on the board now: what Orb may draw for them. */
  canDraw: boolean;
  followedPresenterRef: RefObject<FollowedPresenter | null>;
  stopFollowingOnOwnMove: () => void;
  /** A host that shows the conversation in its own UI instead of the board's panel. */
  host?: AssistantHost;
}

/**
 * The board's assistant: the conversation, and either the board's own panel
 * or the host that shows it instead, with what the host needs to act on the
 * board (show what Orb drew, take it back).
 */
export function useBoardAssistant({
  channel,
  enabled,
  whiteboardUrl,
  tokenRef,
  userId,
  editor,
  pages: wb,
  pageManagerRef,
  canManageWhiteboard,
  syncReady,
  syncOnline,
  canDraw,
  followedPresenterRef,
  stopFollowingOnOwnMove,
  host,
}: BoardAssistantOptions) {
  const assistant = useAssistant({
    channel,
    enabled,
    whiteboardUrl,
    tokenRef,
    userId,
    editor,
    pageManagerRef,
    canManageWhiteboard,
    syncReady,
    syncOnline,
    followingRef: followedPresenterRef,
  });
  const { navigator, pages, changePage } = wb;

  // What Orb drew, from a host's conversation: shown — this viewer steps off
  // the presenter's page to look — or taken back by someone who may edit.
  const showShapes = useCallback(
    (pageId: string, ids: readonly string[]) => {
      if (!editor) return;
      stopFollowingOnOwnMove();
      const shapeIds = ids.map((id) => `shape:${id}` as TLShapeId).filter((id) => editor.getShape(id));
      const bounds = shapeIds.flatMap((id) => editor.getShapePageBounds(id) ?? []);
      if (bounds.length === 0) {
        const page = pages.find((candidate) => candidate.id === pageId);
        if (page) changePage(page.number);
        return;
      }
      const box = Box.Common(bounds);
      editor.setSelectedShapes(shapeIds);
      if (navigator) navigator.director.goOwnAt(navigator.cameraConstraints.cameraCentring(box.center));
    },
    [changePage, editor, navigator, pages, stopFollowingOnOwnMove],
  );
  const removeShapes = useCallback(
    (ids: readonly string[]): string | null => {
      if (!editor) return "The whiteboard is not ready.";
      if (editor.getIsReadonly()) return "You can't edit the whiteboard.";
      const shapeIds = ids
        .map((id) => `shape:${id}` as TLShapeId)
        .filter((id) => {
          const shape = editor.getShape(id);
          return shape !== undefined && !shape.isLocked;
        });
      if (shapeIds.length === 0) return "It's already gone.";
      editor.markHistoryStoppingPoint("assistant-undo");
      editor.deleteShapes(shapeIds);
      return null;
    },
    [editor],
  );

  // A host showing the conversation itself gets every change to it.
  const hostRef = useCommittedRef(host);
  const hosted = !!host;
  const { available, live, entries, runs, prompt, cancel, mayCancel } = assistant;
  useEffect(() => {
    if (!hosted || !enabled) return;
    hostRef.current?.onChange({
      available,
      live,
      entries,
      runs,
      prompt,
      cancel,
      mayCancel,
      canDraw,
      showShapes,
      removeShapes,
    });
  }, [available, cancel, canDraw, enabled, entries, hostRef, hosted, live, mayCancel, prompt, removeShapes, runs, showShapes]);
  useEffect(() => {
    if (!hosted) return;
    const current = hostRef.current;
    return () => current?.onChange(null);
  }, [hostRef, hosted]);

  // The board's own Orb panel and the buttons that open it. A host shows the
  // conversation in its own UI — a meeting's Conversation, where "@Orb" asks —
  // so a hosted board has neither.
  const showsPanel = enabled && !hosted;
  const panelOpen = showsPanel && assistant.panelOpen;
  const { closePanel, openPanel } = assistant;
  const togglePanel = useCallback(() => {
    if (panelOpen) closePanel();
    else openPanel();
  }, [closePanel, openPanel, panelOpen]);

  return { assistant, showsPanel, panelOpen, togglePanel };
}
