import * as React from "react";
import type { Room } from "livekit-client";
import { useCommittedRef } from "@orbmeet/ui/react";
import { logError } from "@/lib/logger";
import { PARTICIPANT_ATTRIBUTE, parseBoardRequest } from "@/modules/meetings/contract/live-state";
import { useRoomParticipants } from "@/modules/meetings/client/use-meeting-live-state";
import { declineBoardRequest, requestBoard } from "@/modules/meetings/server/runtime/live.functions";

export interface PendingBoardRequest {
  identity: string;
  /** What a moderator's decline names. */
  admissionId: string;
  userName: string;
}

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
  meetingId,
  connectionId,
  canModerate,
  boardOpen,
  onDeclined,
}: {
  room: Room | undefined;
  meetingId: string;
  connectionId: string;
  canModerate: boolean;
  /** The meeting has the board open for everyone. */
  boardOpen: boolean;
  /** Told once when a moderator declines this participant's ask. */
  onDeclined: () => void;
}) {
  const participants = useRoomParticipants(room);
  const [sending, setSending] = React.useState(false);
  const takenBackRef = React.useRef(false);

  const own = parseBoardRequest(room?.localParticipant.attributes[PARTICIPANT_ATTRIBUTE.board]);
  const previousOwnRef = React.useRef(own);
  const boardOpenRef = useCommittedRef(boardOpen);
  const onDeclinedRef = useCommittedRef(onDeclined);
  React.useEffect(() => {
    const previous = previousOwnRef.current;
    previousOwnRef.current = own;
    if (!previous || own) return;
    const takenBack = takenBackRef.current;
    takenBackRef.current = false;
    if (takenBack) return;
    // Opening the board also clears the ask, and room metadata may land a
    // beat after the attribute: give it that beat before calling it a no.
    const timer = setTimeout(() => {
      if (!boardOpenRef.current) onDeclinedRef.current();
    }, 1_500);
    return () => clearTimeout(timer);
  }, [boardOpenRef, onDeclinedRef, own]);

  const requests = React.useMemo<PendingBoardRequest[]>(
    () =>
      canModerate
        ? participants
            .filter(
              (participant) =>
                participant !== room?.localParticipant &&
                parseBoardRequest(participant.attributes[PARTICIPANT_ATTRIBUTE.board]),
            )
            .map((participant) => ({
              identity: participant.identity,
              admissionId: participant.attributes[PARTICIPANT_ATTRIBUTE.participant] ?? "",
              userName: participant.name?.trim() || "Participant",
            }))
            .filter((request) => request.admissionId !== "")
        : [],
    [canModerate, participants, room],
  );

  const send = React.useCallback(
    async (requested: boolean) => {
      setSending(true);
      try {
        await requestBoard({ data: { meetingId, connectionId, requested } });
      } catch (error) {
        logError("[Board] Could not send the ask:", error);
        throw error;
      } finally {
        setSending(false);
      }
    },
    [connectionId, meetingId],
  );

  const ask = React.useCallback(() => send(true), [send]);
  const takeBack = React.useCallback(() => {
    takenBackRef.current = true;
    return send(false);
  }, [send]);
  const decline = React.useCallback(
    (admissionId: string) => declineBoardRequest({ data: { meetingId, connectionId, admissionId } }),
    [connectionId, meetingId],
  );

  return {
    /** This participant is waiting on a moderator. */
    asked: !canModerate && !boardOpen && (own || sending),
    ask,
    takeBack,
    /** Moderators: who is asking. */
    requests,
    decline,
  };
}
