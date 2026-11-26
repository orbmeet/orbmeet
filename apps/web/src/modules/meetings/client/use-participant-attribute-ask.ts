import * as React from "react";
import type { Participant, Room } from "livekit-client";
import { useCommittedRef } from "@orbmeet/ui/react";
import { PARTICIPANT_ATTRIBUTE } from "@/modules/meetings/contract/live-state";
import { useRoomParticipants } from "./use-meeting-live-state";

/** How long to wait for room metadata to catch up after an ask clears before treating it as declined. */
const DECLINE_GRACE_MS = 1_500;

export interface PendingAttributeAsk {
  identity: string;
  /** What a moderator's decline names. */
  admissionId: string;
  userName: string;
}

/**
 * Shared participant-attribute ask/decline state machine.
 *
 * Attendees ask a moderator for a room-level change (opening the board, stopping
 * transcription); the ask is stored as a coordinator-written participant
 * attribute so reconnects never lose it. Clearing the attribute while the
 * requested change did not happen — without this client taking it back — is
 * treated as a decline after a 1.5s grace beat so room metadata racing behind
 * the attribute is never misread as a decline.
 */
export function useParticipantAttributeAsk({
  room,
  participants: providedParticipants,
  attribute,
  parse,
  canAsk,
  canListRequests,
  isStillUnresolved,
  onDeclined,
  sendRequest,
}: {
  room: Room | undefined;
  participants?: Participant[];
  attribute: string;
  parse: (value: string | undefined) => boolean;
  /** True when this participant is eligible to have an active ask. */
  canAsk: boolean;
  /** True when this participant should see incoming asks from other participants. */
  canListRequests: boolean;
  /** Read after the grace window: true if the ask was NOT answered by a room state change. */
  isStillUnresolved: () => boolean;
  onDeclined: () => void;
  sendRequest: (requested: boolean) => Promise<unknown>;
}) {
  const participants = useRoomParticipants(room, providedParticipants);
  const [sending, setSending] = React.useState(false);
  const takenBackRef = React.useRef(false);

  const own = parse(room?.localParticipant.attributes[attribute]);
  const previousOwnRef = React.useRef(own);
  const isStillUnresolvedRef = useCommittedRef(isStillUnresolved);
  const onDeclinedRef = useCommittedRef(onDeclined);

  React.useEffect(() => {
    const previous = previousOwnRef.current;
    previousOwnRef.current = own;
    if (!previous || own) return;
    const takenBack = takenBackRef.current;
    takenBackRef.current = false;
    if (takenBack) return;
    // The moderator granting the ask also clears the attribute, and room
    // metadata may land a beat later: give it that beat before calling it a no.
    const timer = setTimeout(() => {
      if (isStillUnresolvedRef.current()) onDeclinedRef.current();
    }, DECLINE_GRACE_MS);
    return () => clearTimeout(timer);
  }, [isStillUnresolvedRef, onDeclinedRef, own]);

  const requests = React.useMemo<PendingAttributeAsk[]>(
    () =>
      canListRequests
        ? participants
            .filter(
              (participant) =>
                participant !== room?.localParticipant &&
                parse(participant.attributes[attribute]),
            )
            .map((participant) => ({
              identity: participant.identity,
              admissionId: participant.attributes[PARTICIPANT_ATTRIBUTE.participant] ?? "",
              userName: participant.name?.trim() || "Participant",
            }))
            .filter((request) => request.admissionId !== "")
        : [],
    [attribute, canListRequests, parse, participants, room],
  );

  const send = React.useCallback(
    async (requested: boolean) => {
      setSending(true);
      try {
        await sendRequest(requested);
      } finally {
        setSending(false);
      }
    },
    [sendRequest],
  );

  const ask = React.useCallback(() => send(true), [send]);
  const takeBack = React.useCallback(() => {
    takenBackRef.current = true;
    return send(false);
  }, [send]);

  return {
    asked: canAsk && (own || sending),
    ask,
    takeBack,
    requests,
  };
}
