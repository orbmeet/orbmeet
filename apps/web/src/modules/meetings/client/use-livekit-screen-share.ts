import * as React from "react";
import type { Room } from "livekit-client";
import { PARTICIPANT_ATTRIBUTE, parseScreenShareAsk } from "@/modules/meetings/contract/live-state";
import { decideScreenShare } from "@/modules/meetings/server/runtime/live.functions";
import { useRoomParticipants } from "./use-meeting-live-state";

export interface PendingScreenShareRequest {
  identity: string;
  userId: string;
  userName: string;
  requestedAt: number;
}

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
  const ownAsk = parseScreenShareAsk(room?.localParticipant.attributes[PARTICIPANT_ATTRIBUTE.screenShare]);

  // When each request was first seen here, for ordering the moderator's list.
  const [firstSeen, setFirstSeen] = React.useState<ReadonlyMap<string, number>>(new Map());
  const requesters = React.useMemo(
    () => (isAdmin
      ? participants.filter((participant) =>
          participant !== room?.localParticipant
          && parseScreenShareAsk(participant.attributes[PARTICIPANT_ATTRIBUTE.screenShare])?.state === "requested")
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

  const decide = React.useCallback(async (identity: string, allow: boolean) => {
    const admissionId = room?.remoteParticipants.get(identity)?.attributes[PARTICIPANT_ATTRIBUTE.participant];
    if (!admissionId) throw new Error("This participant is no longer in the meeting.");
    await decideScreenShare({ data: { meetingId, connectionId, admissionId, allow } });
  }, [connectionId, meetingId, room]);

  return {
    pendingRequests,
    ownAsk,
    approveRequest: React.useCallback((identity: string) => decide(identity, true), [decide]),
    denyRequest: React.useCallback((identity: string) => decide(identity, false), [decide]),
  };
}
