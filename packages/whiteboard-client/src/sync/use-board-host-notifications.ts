import { useEffect, useEffectEvent } from "react";
import type { Editor } from "tldraw";
import type { RoomMessage } from "@orbmeet/whiteboard-core/room-messages";
import { currentPageHasRenderableContent } from "../pages/current-page-shapes";
import type { RoomChannel } from "./room-channel";

type BoardStatus = "loading" | "ready" | "fatal";

interface BoardHostNotificationsOptions {
  editor: Editor | null;
  channel: RoomChannel;
  status: BoardStatus;
  connectionStatus: "online" | "offline";
  onStatusChange?: (status: BoardStatus) => void;
  onConnectionStatusChange?: (status: "online" | "offline") => void;
  onContentStateChange?: (hasContent: boolean) => void;
  onCustomMessage?: (message: RoomMessage) => void;
}

/**
 * What the board tells its host, as it changes.
 *
 * Every one of these is a pure notification, so each callback is read through
 * an effect event and only whether the host wants the signal at all is a
 * dependency. Keyed on a callback's identity instead, a host passing an inline
 * callback re-ran the effect on every render and was re-notified of a value it
 * already had — and the content signal is worse than that: its cleanup *calls*
 * the callback, so a host storing the value in state re-ran the effect, whose
 * cleanup reported `false`, which changed the state again: an oscillation.
 */
export function useBoardHostNotifications({
  editor,
  channel,
  status,
  connectionStatus,
  onStatusChange,
  onConnectionStatusChange,
  onContentStateChange,
  onCustomMessage,
}: BoardHostNotificationsOptions): void {
  const notifyStatus = useEffectEvent((next: BoardStatus) => onStatusChange?.(next));
  const wantsStatus = onStatusChange !== undefined;
  useEffect(() => {
    if (wantsStatus) notifyStatus(status);
  }, [status, wantsStatus]);

  const notifyConnectionStatus = useEffectEvent((next: "online" | "offline") => onConnectionStatusChange?.(next));
  const wantsConnectionStatus = onConnectionStatusChange !== undefined;
  useEffect(() => {
    if (wantsConnectionStatus) notifyConnectionStatus(connectionStatus);
  }, [connectionStatus, wantsConnectionStatus]);

  const notifyCustomMessage = useEffectEvent((message: RoomMessage) => onCustomMessage?.(message));
  useEffect(() => channel.onAny(notifyCustomMessage), [channel]);

  const emitContentState = useEffectEvent((hasContent: boolean) => onContentStateChange?.(hasContent));
  const wantsContentState = onContentStateChange !== undefined;
  useEffect(() => {
    if (!editor || !wantsContentState) return;

    let rafId: number | null = null;

    const notifyContentState = () => {
      rafId = null;
      emitContentState(currentPageHasRenderableContent(editor));
    };

    // This listener has no `source` filter, so it also fires for every remote
    // participant's incoming CRDT change. Coalesce to one scan per frame rather
    // than one per committed change.
    const scheduleNotify = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(notifyContentState);
    };

    notifyContentState();
    const unsubscribe = editor.store.listen(scheduleNotify, { scope: "document" });

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      unsubscribe();
      emitContentState(false);
    };
  }, [editor, wantsContentState]);
}
