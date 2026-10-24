import { AutoSubscribe, defineAgent, type JobContext } from "@livekit/agents";
import {
  RemoteAudioTrack,
  RoomEvent,
  TrackSource,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type Room,
  type TrackPublication,
} from "@livekit/rtc-node";
import { RoomServiceClient, ServerError } from "livekit-server-sdk";
import { loadAgentConfig, type AgentConfig } from "../config.js";
import { TranscriptJournal } from "../outbox/transcript-journal.js";
import { recordTranscriptionResultLoss } from "../outbox/transcription-health.js";
import { AudioSource } from "./audio-source.js";
import { CaptionPublisher } from "./caption-publisher.js";
import { deepgramSocketFactory } from "./deepgram-socket.js";
import { waitForDeparture, type PublisherPresence } from "./departure.js";
import { normalizeLanguage } from "./languages.js";
import { getPublisherJobTarget } from "./publisher-job.js";
import {
  initialAssemblerState,
  reduceTranscript,
  type TranscriptEvent,
} from "./transcript-assembler.js";
import { roomAllowsTranscription } from "@orbmeet/caption-protocol/room-transcription";
import { TranscriptionSupervisor } from "./transcription-supervisor.js";
import { logError, logInfo, logWarn } from "../log.js";

const LANGUAGE_ATTRIBUTE = "orbmeet.caption_language";
const PUBLISHER_WAIT_MS = 10_000;
/** How long captions already offered may take to go out when the job stops. */
const CAPTION_SHUTDOWN_GRACE_MS = 2_000;

export function waitForPublisher(
  room: Room,
  identity: string,
  timeoutMs = PUBLISHER_WAIT_MS,
): Promise<RemoteParticipant | null> {
  const present = room.remoteParticipants.get(identity);
  if (present) return Promise.resolve(present);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (participant: RemoteParticipant | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      room.off(RoomEvent.ParticipantConnected, onConnected);
      room.off(RoomEvent.ParticipantDisconnected, onDisconnected);
      room.off(RoomEvent.Disconnected, onRoomDisconnected);
      resolve(participant);
    };
    const onConnected = (participant: RemoteParticipant) => {
      if (participant.identity === identity) finish(participant);
    };
    const onDisconnected = (participant: RemoteParticipant) => {
      if (participant.identity === identity) finish(null);
    };
    const onRoomDisconnected = () => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();

    room.on(RoomEvent.ParticipantConnected, onConnected);
    room.on(RoomEvent.ParticipantDisconnected, onDisconnected);
    room.on(RoomEvent.Disconnected, onRoomDisconnected);
    // Close the gap between the initial lookup and listener registration.
    const connected = room.remoteParticipants.get(identity);
    if (connected) finish(connected);
  });
}

/** Ask the LiveKit server whether `identity` is in `roomName`. */
function serverPresence(config: AgentConfig, roomName: string, identity: string): PublisherPresence {
  const rooms = new RoomServiceClient(
    config.livekitUrl.replace(/^wss:/, "https:"),
    config.livekitApiKey,
    config.livekitApiSecret,
  );
  return async () => {
    try {
      const participants = await rooms.listParticipants(roomName);
      return participants.some((participant) => participant.identity === identity);
    } catch (error) {
      // The room itself is gone: so is the publisher.
      if (error instanceof ServerError && error.status === 404) return false;
      logWarn("Could not ask LiveKit whether the publisher is still in the room", { error });
      return null;
    }
  };
}

function isMicrophone(publication: TrackPublication): boolean {
  return publication.source === TrackSource.SOURCE_MICROPHONE;
}

/**
 * One publisher's transcription, for the life of their LiveKit session.
 *
 * The job owns four parts, each with one job of its own: the audio source
 * (the publisher's microphone, whichever track currently carries it), the
 * supervisor (one Deepgram connection at a time), the assembler (Deepgram
 * results into utterances) and two sinks. The journal is the durable record
 * and is written synchronously as each final arrives; the caption publisher is
 * the live view and never holds the journal up.
 */
export default defineAgent({
  entry: async (ctx: JobContext) => {
    const config = loadAgentConfig();
    const target = getPublisherJobTarget(ctx.job);
    if (!target) {
      ctx.shutdown("publisher job is missing its meeting or participant identity");
      return;
    }
    const { meetingId, roomName, participantIdentity } = target;
    const jobId = ctx.job.id;
    // Health status files are named by this id, which admits no other characters.
    const healthId = jobId.replace(/[^0-9A-Za-z-]/g, "-");
    logInfo("Publisher transcription job starting", { jobId, meetingId, participantIdentity });

    const journal = new TranscriptJournal(config.transcriptJournalPath);
    const source = new AudioSource();
    const captions = new CaptionPublisher({
      transport: () => ctx.agent,
      senderIdentity: participantIdentity,
    });
    let assembler = initialAssemblerState();
    const handleEvent = (event: TranscriptEvent) => {
      const step = reduceTranscript(assembler, event, jobId);
      assembler = step.state;
      for (const final of step.finals) {
        try {
          journal.append(meetingId, participantIdentity, final);
        } catch (error) {
          // Ids only: the text is participants' speech.
          logError("Transcript final could not be journaled", {
            jobId,
            segmentId: final.segmentId,
            error,
          });
          recordTranscriptionResultLoss(healthId, `${final.segmentId}: journal write failed`);
        }
      }
      for (const caption of step.captions) captions.offer(caption);
    };
    const supervisor = new TranscriptionSupervisor({
      source,
      open: deepgramSocketFactory(config),
      language: normalizeLanguage(ctx.job.participant?.attributes[LANGUAGE_ATTRIBUTE]),
      // Until the room says otherwise, nothing is sent (roomAllowsTranscription).
      enabled: roomAllowsTranscription(ctx.room.metadata),
      onEvent: handleEvent,
      id: healthId,
    });

    const onTrackPublished = (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (participant.identity === participantIdentity && isMicrophone(publication)) {
        publication.setSubscribed(true);
      }
    };
    const onTrackSubscribed = (
      track: RemoteTrack,
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      if (
        participant.identity !== participantIdentity ||
        !isMicrophone(publication) ||
        !(track instanceof RemoteAudioTrack) ||
        !publication.sid
      ) return;
      source.attach(track, publication.sid);
      // Transcription starts with the first microphone: a publisher who only
      // shares their screen never holds a Deepgram stream open.
      supervisor.start();
    };
    const onTrackUnsubscribed = (
      _track: RemoteTrack,
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      if (participant.identity === participantIdentity && isMicrophone(publication) && publication.sid) {
        source.detach(publication.sid);
      }
    };
    const onTrackMuted = (publication: TrackPublication, participant: Participant) => {
      if (participant.identity === participantIdentity && publication.sid === source.trackSid) {
        supervisor.finalize();
      }
    };
    const onTrackUnmuted = (publication: TrackPublication, participant: Participant) => {
      if (participant.identity === participantIdentity && publication.sid === source.trackSid) {
        supervisor.cancelFinalize();
      }
    };
    // The meeting's host or co-host turns transcription on and off; the
    // coordinator writes it to the room metadata.
    const onRoomMetadataChanged = (metadata: string) => {
      supervisor.setEnabled(roomAllowsTranscription(metadata));
    };
    const onAttributesChanged = (changed: Record<string, string>, participant: Participant) => {
      if (participant.identity !== participantIdentity || !(LANGUAGE_ATTRIBUTE in changed)) return;
      supervisor.setLanguage(normalizeLanguage(participant.attributes[LANGUAGE_ATTRIBUTE]));
    };

    ctx.room.on(RoomEvent.TrackPublished, onTrackPublished);
    ctx.room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
    ctx.room.on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
    ctx.room.on(RoomEvent.TrackMuted, onTrackMuted);
    ctx.room.on(RoomEvent.TrackUnmuted, onTrackUnmuted);
    ctx.room.on(RoomEvent.ParticipantAttributesChanged, onAttributesChanged);
    ctx.room.on(RoomEvent.RoomMetadataChanged, onRoomMetadataChanged);
    ctx.addShutdownCallback(async () => {
      ctx.room.off(RoomEvent.TrackPublished, onTrackPublished);
      ctx.room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
      ctx.room.off(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
      ctx.room.off(RoomEvent.TrackMuted, onTrackMuted);
      ctx.room.off(RoomEvent.TrackUnmuted, onTrackUnmuted);
      ctx.room.off(RoomEvent.ParticipantAttributesChanged, onAttributesChanged);
      ctx.room.off(RoomEvent.RoomMetadataChanged, onRoomMetadataChanged);
      // Stop listening first: Deepgram returns what it was sent, and every
      // final it returns is journaled as it arrives. Nothing durable is left
      // in flight once the supervisor has closed.
      await supervisor.close();
      handleEvent({ kind: "interrupt" });
      await captions.close(CAPTION_SHUTDOWN_GRACE_MS);
      await source.close();
      journal.close();
    });

    // Only the publisher's microphone: every other track in the room is
    // someone else's job, and receiving it would cost media for nothing.
    await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_NONE);
    logInfo("Publisher transcription agent connected", { jobId, meetingId, participantIdentity });
    const publisher = await waitForPublisher(ctx.room, participantIdentity);
    if (!publisher) {
      ctx.shutdown("publisher left before the transcription agent connected");
      return;
    }
    supervisor.setLanguage(normalizeLanguage(publisher.attributes[LANGUAGE_ATTRIBUTE]));
    // The room's metadata is only known once connected.
    supervisor.setEnabled(roomAllowsTranscription(ctx.room.metadata));
    for (const publication of publisher.trackPublications.values()) {
      if (!isMicrophone(publication)) continue;
      if (publication.track) onTrackSubscribed(publication.track, publication, publisher);
      else publication.setSubscribed(true);
    }

    ctx.shutdown(await waitForDeparture(ctx.room, participantIdentity, {
      checkPresence: serverPresence(config, roomName, participantIdentity),
    }));
  },
});
