import * as React from "react";
import type { Room } from "livekit-client";
import { logError } from "@/lib/logger";
import { PARTICIPANT_ATTRIBUTE, parseScreenShareState } from "@/modules/meetings/contract/live-state";
import {
  decideScreenShare,
  requestScreenShare as requestScreenShareRpc,
  stopScreenShare,
} from "@/modules/meetings/server/runtime/live.functions";
import { useRoomParticipants } from "./use-meeting-live-state";

export interface PendingScreenShareRequest {
  identity: string;
  userId: string;
  userName: string;
  requestedAt: number;
}

type RequestState = "idle" | "pending" | "approved" | "denied";

/**
 * Screen-share requests, as the meeting's coordinator records them. A
 * request and its decision are server-written attributes, so neither is lost
 * to a reconnect on either side.
 */
export function useLiveKitScreenShare({
  room,
  meetingId,
  connectionId,
  isAdmin,
}: {
  room: Room | undefined;
  meetingId: string;
  connectionId: string;
  isAdmin: boolean;
}) {
  const participants = useRoomParticipants(room);
  const [sending, setSending] = React.useState(false);
  const [denied, setDenied] = React.useState(false);
  const cancelledRef = React.useRef(false);

  const own = parseScreenShareState(room?.localParticipant.attributes[PARTICIPANT_ATTRIBUTE.screenShare]);
  const previousOwnRef = React.useRef(own);
  React.useEffect(() => {
    // A request that disappears without being cancelled here was denied.
    const previous = previousOwnRef.current;
    previousOwnRef.current = own;
    if (previous === own) return;
    setDenied(previous === "requested" && own === null && !cancelledRef.current);
    cancelledRef.current = false;
  }, [own]);

  const requestState: RequestState = isAdmin
    ? "idle"
    : own === "granted"
      ? "approved"
      : own === "requested" || sending
        ? "pending"
        : denied
          ? "denied"
          : "idle";

  // When each request was first seen here, for ordering the moderator's list.
  const [firstSeen, setFirstSeen] = React.useState<ReadonlyMap<string, number>>(new Map());
  const requesters = React.useMemo(
    () => (isAdmin
      ? participants.filter((participant) =>
          participant !== room?.localParticipant
          && parseScreenShareState(participant.attributes[PARTICIPANT_ATTRIBUTE.screenShare]) === "requested")
      : []),
    [isAdmin, participants, room],
  );
  React.useEffect(() => {
    setFirstSeen((current) => {
      const next = new Map<string, number>();
      for (const participant of requesters) {
        next.set(participant.identity, current.get(participant.identity) ?? Date.now());
      }
      return next;
    });
  }, [requesters]);

  const pendingRequests = React.useMemo<PendingScreenShareRequest[]>(
    () => requesters.map((participant) => ({
      identity: participant.identity,
      userId: participant.identity,
      userName: participant.name?.trim() || "Participant",
      requestedAt: firstSeen.get(participant.identity) ?? 0,
    })),
    [firstSeen, requesters],
  );

  const requestScreenShare = React.useCallback(async (): Promise<boolean> => {
    if (isAdmin) return false;
    setDenied(false);
    setSending(true);
    try {
      await requestScreenShareRpc({ data: { meetingId, connectionId } });
      return true;
    } catch (error) {
      logError("[ScreenShare] Request failed:", error);
      return false;
    } finally {
      setSending(false);
    }
  }, [connectionId, isAdmin, meetingId]);

  /**
   * Withdraw a request or give back a grant: the participant stopped sharing
   * or gave up waiting. Only a decision like that is sent to the server.
   */
  const withdrawRequest = React.useCallback(() => {
    setDenied(false);
    if (isAdmin) return;
    cancelledRef.current = true;
    stopScreenShare({ data: { meetingId, connectionId } }).catch((error: unknown) => {
      logError("[ScreenShare] Cancelling failed:", error);
    });
  }, [connectionId, isAdmin, meetingId]);

  /** Clear a denial shown to this participant. Nothing is sent. */
  const dismissDenied = React.useCallback(() => setDenied(false), []);

  const decide = React.useCallback(async (identity: string, allow: boolean) => {
    const admissionId = room?.remoteParticipants.get(identity)?.attributes[PARTICIPANT_ATTRIBUTE.participant];
    if (!admissionId) throw new Error("This participant is no longer in the meeting.");
    await decideScreenShare({ data: { meetingId, connectionId, admissionId, allow } });
  }, [connectionId, meetingId, room]);

  return {
    pendingRequests,
    requestState,
    requestScreenShare,
    withdrawRequest,
    dismissDenied,
    approveRequest: React.useCallback((identity: string) => decide(identity, true), [decide]),
    denyRequest: React.useCallback((identity: string) => decide(identity, false), [decide]),
  };
}
