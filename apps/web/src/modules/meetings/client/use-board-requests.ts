import * as React from "react";
import type { Participant, Room } from "livekit-client";
import { logError } from "@/lib/logger";
import { PARTICIPANT_ATTRIBUTE, parseBoardRequest } from "@/modules/meetings/contract/live-state";
import { declineBoardRequest, requestBoard } from "@/modules/meetings/server/runtime/live.functions";
import { useParticipantAttributeAsk } from "./use-participant-attribute-ask";

/**
 * Asking for the board, from either side.
 *
 * Anyone can press Board. A moderator opens it for the room; anyone else asks,
 * and the ask is a participant attribute the meeting's coordinator writes, so
 * neither side loses it to a reconnect. A moderator answers by opening the
 * board — which answers every ask at once — or by declining one.
 *
 * An ask that disappears while the board stays closed, without this client
 * taking it back, was declined.
 */
export function useBoardRequests({
  room,
  participants,
  meetingId,
  connectionId,
  canModerate,
  boardOpen,
  onDeclined,
}: {
  room: Room | undefined;
  participants?: Participant[];
  meetingId: string;
  connectionId: string;
  canModerate: boolean;
  /** The meeting has the board open for everyone. */
  boardOpen: boolean;
  /** Told once when a moderator declines this participant's ask. */
  onDeclined: () => void;
}) {
  const sendRequest = React.useCallback(
    async (requested: boolean) => {
      try {
        await requestBoard({ data: { meetingId, connectionId, requested } });
      } catch (error) {
        logError("[Board] Could not send the ask:", error);
        throw error;
      }
    },
    [connectionId, meetingId],
  );

  const { asked, ask, takeBack, requests } = useParticipantAttributeAsk({
    room,
    participants,
    attribute: PARTICIPANT_ATTRIBUTE.board,
    parse: parseBoardRequest,
    canAsk: !canModerate && !boardOpen,
    canListRequests: canModerate,
    isStillUnresolved: () => !boardOpen,
    onDeclined,
    sendRequest,
  });

  const decline = React.useCallback(
    (admissionId: string) => declineBoardRequest({ data: { meetingId, connectionId, admissionId } }),
    [connectionId, meetingId],
  );

  return {
    /** This participant is waiting on a moderator. */
    asked,
    ask,
    takeBack,
    /** Moderators: who is asking. */
    requests,
    decline,
  };
}
