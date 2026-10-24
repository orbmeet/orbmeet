import { useEffect, useMemo, useReducer } from "react";
import {
  CAPTION_TOPIC,
  MAX_CAPTION_TEXT_LENGTH,
  parseCaptionStreamAttributes,
} from "@orbmeet/caption-protocol";
import {
  ParticipantKind,
  RoomEvent,
  Track,
  type Participant,
  type Room,
  type TextStreamReader,
} from "livekit-client";
import { ReceiverRateLimiter } from "@/platform/realtime/receiver-rate-limiter";
import {
  emptyCaptionBoard,
  nextCaptionExpiry,
  reduceCaptionBoard,
  type CaptionBoardEvent,
  type CaptionBoardState,
} from "./board";

export interface ValidatedCaptionStream {
  speaker: Participant;
}

function findParticipantForTrack(room: Room, trackId: string): Participant | null {
  const participants: Participant[] = [
    room.localParticipant,
    ...room.remoteParticipants.values(),
  ];
  return participants.find((participant) => {
    const publication = participant.getTrackPublication(Track.Source.Microphone);
    return publication?.trackSid === trackId;
  }) ?? null;
}

/**
 * Resolve a caption stream to its speaker: the sender, and only when the
 * microphone the caption names is theirs.
 *
 * LiveKit asserts a stream's sender, except that an agent may publish on
 * someone's behalf, which is how the transcription agent sends captions. So
 * a participant can only ever caption their own microphone.
 */
export function validateCaptionStream(
  room: Room,
  caption: { trackId: string; participantIdentity: string; isFinal?: boolean },
): ValidatedCaptionStream | null {
  const speaker = findParticipantForTrack(room, caption.trackId);
  if (speaker?.identity === caption.participantIdentity) return { speaker };
  if (speaker) return null;

  // A microphone republish replaces the publication SID before the old
  // transcriber's interrupted final can arrive. The sender is still the
  // speaker, so fall back to them when the retired track is no longer present.
  if (!caption.isFinal) return null;
  const participant = [room.localParticipant, ...room.remoteParticipants.values()]
    .find((candidate) => candidate.identity === caption.participantIdentity);
  return participant ? { speaker: participant } : null;
}

/**
 * Read a caption stream's text, giving up (null) once it outgrows a caption.
 * A text stream has no size limit of its own, and anyone can open one on this
 * topic. An empty result is meaningful: a final with no text withdraws its
 * segment.
 */
export async function readBoundedCaption(reader: TextStreamReader): Promise<string | null> {
  // A UTF-16 code unit is at most 3 bytes of UTF-8.
  if (reader.info.size !== undefined && reader.info.size > MAX_CAPTION_TEXT_LENGTH * 3) return null;
  let text = "";
  for await (const chunk of reader) {
    text += chunk;
    if (text.length > MAX_CAPTION_TEXT_LENGTH) return null;
  }
  return text.trim();
}

/**
 * Receives server-generated Deepgram transcripts as LiveKit transcription
 * streams (`lk.transcription`), which the agent publishes on each speaker's
 * behalf.
 */
export function useLiveTranscriptions({ room }: { room: Room | undefined }) {
  const [board, dispatchBoard] = useReducer(
    (state: CaptionBoardState, event: CaptionBoardEvent) => reduceCaptionBoard(state, event),
    undefined,
    emptyCaptionBoard,
  );
  // Budget spent before a stream is read, keyed on the sender LiveKit asserts.
  // Interim updates, the bulk of the traffic, get a smaller share of it, so a
  // burst of them cannot starve the finals. The interim budget is checked
  // first: an interim it refuses must not also spend the shared budget.
  const streamLimiter = useMemo(() => new ReceiverRateLimiter(60, 1_000), []);
  const interimLimiter = useMemo(() => new ReceiverRateLimiter(30, 1_000), []);

  useEffect(() => {
    if (!room) return;
    let active = true;
    room.registerTextStreamHandler(CAPTION_TOPIC, (reader, { identity }) => {
      const caption = parseCaptionStreamAttributes(reader.info.attributes);
      if (
        !caption ||
        (!caption.isFinal && !interimLimiter.shouldAllow(identity)) ||
        !streamLimiter.shouldAllow(identity)
      ) {
        return;
      }
      void readBoundedCaption(reader).then((text) => {
        if (!active || text === null) return;
        const validated = validateCaptionStream(room, {
          trackId: caption.trackId,
          participantIdentity: identity,
          isFinal: caption.isFinal,
        });
        if (!validated) return;
        dispatchBoard({
          type: "caption",
          update: {
            segmentId: caption.segmentId,
            revision: caption.revision,
            userId: validated.speaker.identity,
            userName: validated.speaker.name?.trim() || "Participant",
            text,
            isFinal: caption.isFinal,
            receivedAt: Date.now(),
          },
        });
      }, () => undefined);
    });
    return () => {
      active = false;
      room.unregisterTextStreamHandler(CAPTION_TOPIC);
    };
  }, [interimLimiter, room, streamLimiter]);

  useEffect(() => {
    const expiresAt = nextCaptionExpiry(board);
    if (expiresAt === null) return;
    const timer = setTimeout(
      () => dispatchBoard({ type: "expire", now: Date.now() }),
      Math.max(0, expiresAt - Date.now()) + 10,
    );
    return () => clearTimeout(timer);
  }, [board]);

  useEffect(() => {
    if (!room) return;
    const onParticipantDisconnected = (participant: Participant) => {
      if (participant.kind === ParticipantKind.STANDARD && participant.identity) {
        dispatchBoard({ type: "speaker-left", userId: participant.identity });
      }
    };
    room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    return () => {
      room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
      dispatchBoard({ type: "clear" });
    };
  }, [room]);

  return board.transcript;
}
