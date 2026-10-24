import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  WHITEBOARD_EVENTS,
  reconcileEditAccessRequestPending,
} from "@orbmeet/whiteboard-core/protocol";
import {
  normalizeConnectedWhiteboardUsers,
  type ConnectedWhiteboardUser,
} from "./connected-users";
import { reduceRoomSizeLimited } from "./room-size-state";
import type { RoomChannel } from "./room-channel";
import { useCommittedRef } from "@orbmeet/ui/react";

interface WhiteboardRoomStateOptions {
  channel: RoomChannel;
  isHost: boolean;
  userId: string | null;
  onRequestEditAccess?: () => Promise<{ status?: string } | void>;
}

/** The room as the room announces it: who may edit, who drives, how full it is. */
export function useWhiteboardRoomState({
  channel,
  isHost,
  userId,
  onRequestEditAccess,
}: WhiteboardRoomStateOptions) {
  const mountedRef = useRef(true);
  const isHostRef = useCommittedRef(isHost);
  const userIdRef = useCommittedRef(userId);

  const [canEditWhiteboard, setCanEditWhiteboard] = useState(isHost);
  const [roomSizeLimited, setRoomSizeLimited] = useState(false);
  const [editAccessRequested, setEditAccessRequested] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [navigationControllerUserId, setNavigationControllerUserId] =
    useState<string | null>(null);
  const [navigationControllerName, setNavigationControllerName] =
    useState<string | null>(null);
  const [connectedUsers, setConnectedUsers] = useState<ConnectedWhiteboardUser[]>([]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isHost) return;
    setCanEditWhiteboard(true);
    setEditAccessRequested(false);
  }, [isHost]);

  useEffect(() => {
    if (!actionError) return;
    const timer = window.setTimeout(() => setActionError(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [actionError]);

  const reportActionError = useCallback((message: string) => {
    setActionError(message);
  }, []);

  const requestEditAccess = useCallback(async () => {
    if (editAccessRequested || !onRequestEditAccess) return;

    setEditAccessRequested(true);
    setActionError(null);
    try {
      const result = await onRequestEditAccess();
      if (!mountedRef.current) return;
      if (result && result.status === "already_approved") {
        setEditAccessRequested(false);
      }
    } catch (error) {
      if (!mountedRef.current) return;
      console.error("Failed to request whiteboard edit access:", error);
      setEditAccessRequested(false);
      setActionError("Could not request whiteboard edit access.");
    }
  }, [editAccessRequested, onRequestEditAccess]);

  useEffect(() => {
    const subscriptions = [
      channel.on(WHITEBOARD_EVENTS.ROOM_SIZE_LIMIT, (message) => {
        setRoomSizeLimited((current) => reduceRoomSizeLimited(current, message.type));
      }),
      channel.on(WHITEBOARD_EVENTS.ROOM_SIZE_RECOVERED, (message) => {
        setRoomSizeLimited((current) => reduceRoomSizeLimited(current, message.type));
      }),
      channel.on(WHITEBOARD_EVENTS.STATE, (message) => {
        setRoomSizeLimited((current) =>
          reduceRoomSizeLimited(current, message.type, message.roomSizeLimited),
        );
        const editorUserIds = Array.isArray(message.editorUserIds) ? message.editorUserIds : [];
        const currentUserId = userIdRef.current;
        if (currentUserId && !isHostRef.current) {
          const nextCanEdit =
            typeof message.canEditWhiteboard === "boolean"
              ? message.canEditWhiteboard
              : editorUserIds.includes(currentUserId);
          setCanEditWhiteboard(nextCanEdit);
          setEditAccessRequested(
            reconcileEditAccessRequestPending(nextCanEdit, message.editAccessRequestPending),
          );
        }
        setNavigationControllerUserId(message.navigationControllerUserId ?? null);
        setNavigationControllerName(message.navigationControllerName ?? null);
        if (message.connectedUsers !== undefined) {
          setConnectedUsers(normalizeConnectedWhiteboardUsers(message.connectedUsers));
        }
      }),
      channel.on(WHITEBOARD_EVENTS.ACCESS_GRANTED, () => {
        setCanEditWhiteboard(true);
        setEditAccessRequested(false);
      }),
      channel.on(WHITEBOARD_EVENTS.ACCESS_DENIED, () => {
        if (isHostRef.current) return;
        setCanEditWhiteboard(false);
        setEditAccessRequested(false);
      }),
    ];
    return () => {
      for (const unsubscribe of subscriptions) unsubscribe();
    };
  }, [channel, isHostRef, userIdRef]);

  return {
    actionError,
    canEditWhiteboard,
    connectedUsers,
    editAccessRequested,
    navigationControllerName,
    navigationControllerUserId,
    reportActionError,
    requestEditAccess,
    roomSizeLimited,
  };
}
