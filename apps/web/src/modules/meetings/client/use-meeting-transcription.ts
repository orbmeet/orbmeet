import * as React from "react";
import type { Participant, Room } from "livekit-client";
import { useCommittedRef, type useToast } from "@orbmeet/ui/react";
import { logError } from "@/lib/logger";
import {
  PARTICIPANT_ATTRIBUTE,
  parseTranscriptionStopRequest,
  type MeetingRoomState,
} from "@/modules/meetings/contract/live-state";
import { useMeetingRoomState } from "@/modules/meetings/client/use-meeting-live-state";
import {
  declineTranscriptionStop,
  requestTranscriptionStop,
  setTranscription,
} from "@/modules/meetings/server/runtime/live.functions";
import type { HostPermissionRequest } from "@/modules/meetings/client/types";
import { useParticipantAttributeAsk } from "./use-participant-attribute-ask";

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
  roomState: providedRoomState,
  participants,
  meetingId,
  connectionId,
  canModerate,
  initiallyOn,
  addToast,
}: {
  room: Room | undefined;
  roomState?: MeetingRoomState | null;
  participants?: Participant[];
  meetingId: string;
  connectionId: string;
  canModerate: boolean;
  /** What the join reported, until room metadata says. */
  initiallyOn: boolean;
  addToast: ReturnType<typeof useToast>["add"];
}) {
  const roomState = useMeetingRoomState(room, providedRoomState);
  const on = roomState?.transcription ?? initiallyOn;
  const [pending, setPending] = React.useState(false);
  const addToastRef = useCommittedRef(addToast);

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

  const sendAsk = React.useCallback(
    async (requested: boolean) => {
      try {
        await requestTranscriptionStop({ data: { meetingId, connectionId, requested } });
      } catch (error) {
        logError("[Meeting] Could not send the transcription ask:", error);
        addToastRef.current({
          title: "Couldn't reach the host",
          description: "Try asking again in a moment.",
          data: { variant: "error" },
        });
      }
    },
    [addToastRef, connectionId, meetingId],
  );

  const askState = useParticipantAttributeAsk({
    room,
    participants,
    attribute: PARTICIPANT_ATTRIBUTE.transcriptionStop,
    parse: parseTranscriptionStopRequest,
    canAsk: !canModerate && on,
    canListRequests: canModerate && on,
    isStillUnresolved: () => on && !canModerate,
    onDeclined: () => {
      addToastRef.current({
        title: "Transcription stays on",
        description: "The host chose to keep it on. You can ask again.",
      });
    },
    sendRequest: sendAsk,
  });

  const requests = React.useMemo<HostPermissionRequest[]>(
    () =>
      askState.requests.map((request) => ({
        kind: "extension" as const,
        id: `${TRANSCRIPTION_STOP_REQUEST_PREFIX}${request.admissionId}`,
        userId: request.identity,
        userName: request.userName,
        actionLabel: "stopping transcription",
        description: "Asks to turn transcription off",
      })),
    [askState.requests],
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
    asked: askState.asked,
    askToStop: askState.ask,
    takeBackAsk: askState.takeBack,
    /** Moderators: who is asking, as tray requests. */
    requests,
    answerRequest,
  };
}
