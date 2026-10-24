import * as React from "react";
import type { Room } from "livekit-client";
import { useCommittedRef, type useToast } from "@orbmeet/ui/react";
import { logError } from "@/lib/logger";
import {
  PARTICIPANT_ATTRIBUTE,
  parseTranscriptionStopRequest,
} from "@/modules/meetings/contract/live-state";
import { useMeetingRoomState, useRoomParticipants } from "@/modules/meetings/client/use-meeting-live-state";
import {
  declineTranscriptionStop,
  requestTranscriptionStop,
  setTranscription,
} from "@/modules/meetings/server/runtime/live.functions";
import type { HostPermissionRequest } from "@/modules/meetings/client/types";

/** Tray ids for asks to stop transcription; the rest of the id is the asker's admission. */
const TRANSCRIPTION_STOP_REQUEST_PREFIX = "transcription-stop:";

/**
 * Whether the meeting transcribes, and who may change it.
 *
 * Transcription is the meeting's state, not anyone's preference: while it is
 * on, everyone's speech goes to Deepgram for captions, the transcript and the
 * summary, and while it is off nobody's does. A host or co-host turns it on or
 * off; anyone else asks them to stop. The ask is a participant attribute the
 * coordinator writes, like a raised hand, so neither side loses it to a
 * reconnect. Turning transcription off answers every ask at once.
 *
 * Everyone is told when it changes, since what is sent about them changes.
 */
export function useMeetingTranscription({
  room,
  meetingId,
  connectionId,
  canModerate,
  initiallyOn,
  addToast,
}: {
  room: Room | undefined;
  meetingId: string;
  connectionId: string;
  canModerate: boolean;
  /** What the join reported, until room metadata says. */
  initiallyOn: boolean;
  addToast: ReturnType<typeof useToast>["add"];
}) {
  const roomState = useMeetingRoomState(room);
  const on = roomState?.transcription ?? initiallyOn;
  const participants = useRoomParticipants(room);
  const [pending, setPending] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const takenBackRef = React.useRef(false);
  const addToastRef = useCommittedRef(addToast);
  const onRef = useCommittedRef(on);
  const canModerateRef = useCommittedRef(canModerate);

  // Tell everyone when it changes; joining is not a change.
  const previousOnRef = React.useRef(on);
  React.useEffect(() => {
    if (previousOnRef.current === on) return;
    previousOnRef.current = on;
    addToastRef.current(
      on
        ? {
            title: "Transcription is on",
            description: "What people say is sent to Deepgram for captions, the transcript and the summary.",
          }
        : {
            title: "Transcription is off",
            description: "Nothing anyone says is sent to Deepgram until a host turns it back on.",
          },
    );
  }, [addToastRef, on]);

  // This participant's own ask, and its quiet end: an ask that disappears
  // while transcription stays on, without this client taking it back, was
  // declined — unless this participant now runs the meeting, which hides the
  // ask rather than answering it.
  const own = parseTranscriptionStopRequest(
    room?.localParticipant.attributes[PARTICIPANT_ATTRIBUTE.transcriptionStop],
  );
  const previousOwnRef = React.useRef(own);
  React.useEffect(() => {
    const previous = previousOwnRef.current;
    previousOwnRef.current = own;
    if (!previous || own) return;
    const takenBack = takenBackRef.current;
    takenBackRef.current = false;
    if (takenBack) return;
    // Turning it off also clears the ask, and room metadata may land a beat
    // after the attribute: give it that beat before calling it a no.
    const timer = setTimeout(() => {
      if (onRef.current && !canModerateRef.current) {
        addToastRef.current({
          title: "Transcription stays on",
          description: "The host chose to keep it on. You can ask again.",
        });
      }
    }, 1_500);
    return () => clearTimeout(timer);
  }, [addToastRef, canModerateRef, onRef, own]);

  const requests = React.useMemo<HostPermissionRequest[]>(
    () =>
      canModerate && on
        ? participants
            .filter(
              (participant) =>
                participant !== room?.localParticipant &&
                parseTranscriptionStopRequest(participant.attributes[PARTICIPANT_ATTRIBUTE.transcriptionStop]),
            )
            .map((participant) => ({
              admissionId: participant.attributes[PARTICIPANT_ATTRIBUTE.participant] ?? "",
              identity: participant.identity,
              userName: participant.name?.trim() || "Participant",
            }))
            .filter((request) => request.admissionId !== "")
            .map((request) => ({
              kind: "extension" as const,
              id: `${TRANSCRIPTION_STOP_REQUEST_PREFIX}${request.admissionId}`,
              userId: request.identity,
              userName: request.userName,
              actionLabel: "stopping transcription",
              description: "Asks to turn transcription off",
            }))
        : [],
    [canModerate, on, participants, room],
  );

  const turn = React.useCallback(
    async (next: boolean) => {
      setPending(true);
      try {
        await setTranscription({ data: { meetingId, connectionId, on: next } });
      } catch (error) {
        logError("[Meeting] Could not change transcription:", error);
        addToastRef.current({
          title: next ? "Couldn't turn transcription on" : "Couldn't turn transcription off",
          description: "Please try again.",
          data: { variant: "error" },
        });
      } finally {
        setPending(false);
      }
    },
    [addToastRef, connectionId, meetingId],
  );

  const sendAsk = React.useCallback(
    async (requested: boolean) => {
      setSending(true);
      try {
        await requestTranscriptionStop({ data: { meetingId, connectionId, requested } });
      } catch (error) {
        logError("[Meeting] Could not send the transcription ask:", error);
        addToastRef.current({
          title: "Couldn't reach the host",
          description: "Try asking again in a moment.",
          data: { variant: "error" },
        });
      } finally {
        setSending(false);
      }
    },
    [addToastRef, connectionId, meetingId],
  );

  const askToStop = React.useCallback(() => sendAsk(true), [sendAsk]);
  const takeBackAsk = React.useCallback(() => {
    takenBackRef.current = true;
    return sendAsk(false);
  }, [sendAsk]);

  /** The tray's answers to one ask, by its id. False when the id is not one of these. */
  const answerRequest = React.useCallback(
    (requestId: string, approve: boolean): boolean => {
      if (!requestId.startsWith(TRANSCRIPTION_STOP_REQUEST_PREFIX)) return false;
      if (approve) {
        void turn(false);
        return true;
      }
      const admissionId = requestId.slice(TRANSCRIPTION_STOP_REQUEST_PREFIX.length);
      void declineTranscriptionStop({ data: { meetingId, connectionId, admissionId } }).catch((error: unknown) => {
        logError("[Meeting] Could not decline the transcription ask:", error);
        addToastRef.current({
          title: "Action failed",
          description: "Could not answer the request. Please try again.",
          data: { variant: "error" },
        });
      });
      return true;
    },
    [addToastRef, connectionId, meetingId, turn],
  );

  return {
    /** Speech is being sent to Deepgram right now. */
    on,
    /** A host or co-host's change is on its way. */
    pending,
    /** Host and co-host: turn it on or off for everyone. */
    setOn: turn,
    /** This attendee is waiting on a host to answer their ask. */
    asked: !canModerate && on && (own || sending),
    askToStop,
    takeBackAsk,
    /** Moderators: who is asking, as tray requests. */
    requests,
    answerRequest,
  };
}
