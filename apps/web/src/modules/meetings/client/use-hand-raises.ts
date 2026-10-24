import * as React from "react";
import type { Room } from "livekit-client";
import { logError } from "@/lib/logger";
import { PARTICIPANT_ATTRIBUTE, parseRaisedHand } from "@/modules/meetings/contract/live-state";
import { lowerHand as lowerHandRpc, raiseHand as raiseHandRpc, resolveHandRaise } from "@/modules/meetings/server/runtime/live.functions";
import { useRoomParticipants } from "./use-meeting-live-state";

export interface HandRaise {
  identity: string;
  /** The participant's identity; what the queue's actions take. */
  userId: string;
  userName: string;
  raisedAt: number;
  status: "pending";
  nonce: string;
  /** Already raised when this client started watching, rather than raised now. */
  replayed: boolean;
}

/**
 * Raised hands, as the meeting's coordinator records them. Each participant's
 * hand is a server-written attribute, so a hand raised or resolved while
 * anyone was reconnecting is still right when they return.
 */
export function useHandRaises({
  room,
  meetingId,
  connectionId,
  canModerate,
  serverClockOffsetMs,
}: {
  room: Room | undefined;
  meetingId: string;
  connectionId: string;
  canModerate: boolean;
  /** Hands are stamped by the server, so they are compared in its time. */
  serverClockOffsetMs: number;
}) {
  const participants = useRoomParticipants(room);
  // When this participant began watching hands, in the server's time: hands
  // raised before then are already waiting, not news. It starts over when a
  // participant is promoted, so a promotion does not replay every hand.
  const serverNow = () => Date.now() + serverClockOffsetMs;
  const [watchingSince, setWatchingSince] = React.useState<number | null>(
    () => (canModerate ? serverNow() : null),
  );
  if (canModerate && watchingSince === null) setWatchingSince(serverNow());
  if (!canModerate && watchingSince !== null) setWatchingSince(null);
  const [localPending, setLocalPending] = React.useState<boolean | null>(null);

  const local = room?.localParticipant;
  const localHand = parseRaisedHand(local?.attributes[PARTICIPANT_ATTRIBUTE.hand]);
  // The attribute confirms a toggle a moment after the request returns.
  const isHandRaised = localPending ?? localHand !== null;
  React.useEffect(() => setLocalPending(null), [localHand?.raiseId]);

  const handRaiseQueue = React.useMemo<HandRaise[]>(() => {
    if (!canModerate) return [];
    return participants.flatMap((participant) => {
      if (participant === room?.localParticipant) return [];
      const hand = parseRaisedHand(participant.attributes[PARTICIPANT_ATTRIBUTE.hand]);
      if (!hand) return [];
      return [{
        identity: participant.identity,
        userId: participant.identity,
        userName: participant.name?.trim() || "Participant",
        raisedAt: hand.raisedAt,
        status: "pending" as const,
        nonce: hand.raiseId,
        replayed: watchingSince === null || hand.raisedAt < watchingSince,
      }];
    });
  }, [canModerate, participants, room, watchingSince]);

  const setHand = React.useCallback(async (raised: boolean) => {
    setLocalPending(raised);
    try {
      await (raised ? raiseHandRpc : lowerHandRpc)({ data: { meetingId, connectionId } });
    } catch (error) {
      setLocalPending(null);
      logError("[Meeting] Hand raise failed:", error);
    }
  }, [connectionId, meetingId]);

  const resolve = React.useCallback(async (identity: string) => {
    const admissionId = room?.remoteParticipants.get(identity)?.attributes[PARTICIPANT_ATTRIBUTE.participant];
    if (!admissionId) return;
    try {
      await resolveHandRaise({ data: { meetingId, connectionId, admissionId } });
    } catch (error) {
      logError("[Meeting] Resolving a raised hand failed:", error);
    }
  }, [connectionId, meetingId, room]);

  return {
    handRaiseQueue,
    isHandRaised,
    raiseHand: React.useCallback(() => void setHand(true), [setHand]),
    lowerHand: React.useCallback(() => void setHand(false), [setHand]),
    approveHandRaise: React.useCallback((identity: string) => void resolve(identity), [resolve]),
    dismissHandRaise: React.useCallback((identity: string) => void resolve(identity), [resolve]),
  };
}
