import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  appended: [] as Array<{ meetingId: string; participantIdentity: string; segmentId: string; text: string }>,
  offered: [] as Array<{ segmentId: string; text: string; isFinal: boolean }>,
  supervisors: [] as Array<{
    options: { language: string; enabled?: boolean; onEvent: (event: unknown) => void };
    start: ReturnType<typeof vi.fn>;
    setLanguage: ReturnType<typeof vi.fn>;
    setEnabled: ReturnType<typeof vi.fn>;
    finalize: ReturnType<typeof vi.fn>;
    cancelFinalize: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>,
  sources: [] as Array<{
    trackSid: string | null;
    attach: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("@livekit/agents", () => ({
  AutoSubscribe: { SUBSCRIBE_NONE: "subscribe-none" },
  defineAgent: (agent: unknown) => agent,
}));

vi.mock("@livekit/rtc-node", () => ({
  RemoteAudioTrack: class {},
  RoomEvent: {
    ParticipantAttributesChanged: "participantAttributesChanged",
    ParticipantConnected: "participantConnected",
    ParticipantDisconnected: "participantDisconnected",
    Disconnected: "disconnected",
    RoomMetadataChanged: "roomMetadataChanged",
    TrackMuted: "trackMuted",
    TrackUnmuted: "trackUnmuted",
    TrackPublished: "trackPublished",
    TrackSubscribed: "trackSubscribed",
    TrackUnsubscribed: "trackUnsubscribed",
  },
  TrackSource: { SOURCE_MICROPHONE: "microphone", SOURCE_SCREENSHARE_AUDIO: "screenshare-audio" },
}));

vi.mock("../config.js", () => ({
  loadAgentConfig: () => ({
    transcriptJournalPath: "/unused",
    livekitUrl: "wss://livekit.example",
    livekitApiKey: "key",
    livekitApiSecret: "secret",
  }),
}));
vi.mock("livekit-server-sdk", () => ({
  RoomServiceClient: class {
    async listParticipants() {
      return [{ identity: "participant-1" }];
    }
  },
  ServerError: class extends Error {},
}));
vi.mock("./deepgram-socket.js", () => ({ deepgramSocketFactory: () => async () => undefined }));
vi.mock("../outbox/transcription-health.js", () => ({ recordTranscriptionResultLoss: vi.fn() }));

vi.mock("../outbox/transcript-journal.js", () => ({
  TranscriptJournal: class {
    append(meetingId: string, participantIdentity: string, segment: { segmentId: string; text: string }) {
      mocks.appended.push({ meetingId, participantIdentity, segmentId: segment.segmentId, text: segment.text });
    }
    close() {
      mocks.order.push("journal.close");
    }
  },
}));

vi.mock("./caption-publisher.js", () => ({
  CaptionPublisher: class {
    offer(update: { segmentId: string; text: string; isFinal: boolean }) {
      mocks.offered.push({ segmentId: update.segmentId, text: update.text, isFinal: update.isFinal });
    }
    async close() {
      mocks.order.push("captions.close");
    }
  },
}));

vi.mock("./audio-source.js", () => ({
  AudioSource: class {
    trackSid: string | null = null;
    attach = vi.fn((_track: unknown, trackSid: string) => {
      this.trackSid = trackSid;
    });
    detach = vi.fn();
    close = vi.fn(async () => {
      mocks.order.push("source.close");
    });
    constructor() {
      mocks.sources.push(this);
    }
  },
}));

vi.mock("./transcription-supervisor.js", () => ({
  TranscriptionSupervisor: class {
    start = vi.fn();
    setLanguage = vi.fn();
    setEnabled = vi.fn();
    finalize = vi.fn();
    cancelFinalize = vi.fn();
    close = vi.fn(async () => {
      mocks.order.push("supervisor.close");
    });
    constructor(readonly options: { language: string; enabled?: boolean; onEvent: (event: unknown) => void }) {
      mocks.supervisors.push(this);
    }
  },
}));

import { RemoteAudioTrack } from "@livekit/rtc-node";
import agent, { waitForPublisher } from "./agent.js";

type Listener = (...args: never[]) => void;

/** What the meeting's coordinator writes to the room while transcription is on. */
const TRANSCRIBING = JSON.stringify({ version: 1, transcription: true });

function createRoom(metadata: string | undefined) {
  const listeners = new Map<string, Set<Listener>>();
  return {
    listeners,
    metadata,
    remoteParticipants: new Map<string, unknown>(),
    on: vi.fn((event: string, listener: Listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    }),
    off: vi.fn((event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener);
    }),
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) (listener as (...values: unknown[]) => void)(...args);
    },
  };
}

function publication(sid: string, source = "microphone", track: unknown = null) {
  return { sid, source, track, setSubscribed: vi.fn() };
}

function startJob(
  options: {
    publications?: ReturnType<typeof publication>[];
    attributes?: Record<string, string>;
    metadata?: string;
  } = {},
) {
  const room = createRoom("metadata" in options ? options.metadata : TRANSCRIBING);
  const publisher = {
    identity: "participant-1",
    attributes: options.attributes ?? { "orbmeet.caption_language": "fr" },
    trackPublications: new Map((options.publications ?? []).map((item) => [item.sid, item])),
  };
  room.remoteParticipants.set(publisher.identity, publisher);
  const shutdownCallbacks: Array<() => Promise<void>> = [];
  const context = {
    addShutdownCallback: vi.fn((callback: () => Promise<void>) => {
      shutdownCallbacks.push(callback);
    }),
    connect: vi.fn(async () => undefined),
    job: {
      id: "AJ_job",
      participant: { identity: publisher.identity, attributes: {} },
      room: { name: "meet-meeting-1" },
    },
    room,
    shutdown: vi.fn(),
  };
  const entry = agent.entry(context as never);
  return { room, publisher, context, entry, shutdownCallbacks };
}

/** Resolves once the job has finished setting up and is waiting for its publisher to leave. */
async function settled(room: ReturnType<typeof createRoom>) {
  await vi.waitFor(() => expect(room.listeners.get("participantDisconnected")?.size ?? 0).toBeGreaterThan(0));
}

function micTrack() {
  return Object.create(RemoteAudioTrack.prototype) as RemoteAudioTrack;
}

beforeEach(() => {
  mocks.order.length = 0;
  mocks.appended.length = 0;
  mocks.offered.length = 0;
  mocks.supervisors.length = 0;
  mocks.sources.length = 0;
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

describe("publisher transcription job", () => {
  it("subscribes to the publisher's microphone and nothing else", async () => {
    const existing = publication("TR_mic");
    const screen = publication("TR_screen", "screenshare-audio");
    const { room, context, publisher, entry } = startJob({ publications: [existing, screen] });
    await settled(room);

    expect(context.connect).toHaveBeenCalledWith(undefined, "subscribe-none");
    expect(existing.setSubscribed).toHaveBeenCalledWith(true);
    expect(screen.setSubscribed).not.toHaveBeenCalled();
    // No microphone track yet, so no Deepgram stream either.
    expect(mocks.supervisors[0].start).not.toHaveBeenCalled();

    const later = publication("TR_mic_2");
    room.emit("trackPublished", later, publisher);
    room.emit("trackPublished", publication("TR_other"), { identity: "someone-else" });
    expect(later.setSubscribed).toHaveBeenCalledWith(true);

    room.emit("participantDisconnected", publisher);
    await entry;
  });

  it("feeds whichever track carries the microphone into one audio source", async () => {
    const { room, publisher, entry } = startJob();
    await settled(room);
    const source = mocks.sources[0];

    const first = micTrack();
    room.emit("trackSubscribed", first, publication("TR_mic"), publisher);
    room.emit("trackUnsubscribed", first, publication("TR_mic"), publisher);
    const replacement = micTrack();
    room.emit("trackSubscribed", replacement, publication("TR_mic"), publisher);

    expect(source.attach.mock.calls.map(([track, sid]) => [track, sid])).toEqual([[first, "TR_mic"], [replacement, "TR_mic"]]);
    expect(mocks.supervisors[0].start).toHaveBeenCalled();
    expect(source.detach).toHaveBeenCalledWith("TR_mic");
    expect(mocks.supervisors).toHaveLength(1);

    room.emit("participantDisconnected", publisher);
    await entry;
  });

  it("finalizes on mute, keeps going on unmute, and follows the caption language", async () => {
    const { room, publisher, entry } = startJob();
    await settled(room);
    const supervisor = mocks.supervisors[0];
    expect(supervisor.setLanguage).toHaveBeenCalledWith("fr");
    room.emit("trackSubscribed", micTrack(), publication("TR_mic"), publisher);

    room.emit("trackMuted", publication("TR_mic"), publisher);
    room.emit("trackUnmuted", publication("TR_mic"), publisher);
    expect(supervisor.finalize).toHaveBeenCalledOnce();
    expect(supervisor.cancelFinalize).toHaveBeenCalledOnce();

    publisher.attributes = { "orbmeet.caption_language": "de" };
    room.emit("participantAttributesChanged", { "orbmeet.caption_language": "de" }, publisher);
    expect(supervisor.setLanguage).toHaveBeenLastCalledWith("de");

    room.emit("participantDisconnected", publisher);
    await entry;
  });

  it("follows the meeting's transcription switch", async () => {
    const { room, publisher } = startJob({ metadata: JSON.stringify({ version: 1, transcription: false }) });
    await settled(room);
    const supervisor = mocks.supervisors[0];
    expect(supervisor.options.enabled).toBe(false);
    expect(supervisor.setEnabled).toHaveBeenLastCalledWith(false);

    room.emit("roomMetadataChanged", JSON.stringify({ version: 2, transcription: true }));
    expect(supervisor.setEnabled).toHaveBeenLastCalledWith(true);
    room.emit("roomMetadataChanged", JSON.stringify({ version: 3, transcription: false }));
    expect(supervisor.setEnabled).toHaveBeenLastCalledWith(false);

    room.emit("participantDisconnected", publisher);
  });

  it("sends nothing before the room has said whether it transcribes", async () => {
    const { room, publisher } = startJob({ metadata: undefined });
    await settled(room);

    expect(mocks.supervisors[0].options.enabled).toBe(false);
    expect(mocks.supervisors[0].setEnabled).toHaveBeenLastCalledWith(false);
    room.emit("participantDisconnected", publisher);
  });

  it("journals every final as it arrives and captions the utterance", async () => {
    const { publisher, room, entry } = startJob();
    await settled(room);
    const { onEvent } = mocks.supervisors[0].options;

    onEvent({
      kind: "words", text: "hello there", isFinal: true, endpoint: true, fromFinalize: false,
      startedAt: 1_000, endedAt: 1_500, trackSid: "TR_mic", language: "en-US", receivedAt: 2_000,
    });

    expect(mocks.appended).toEqual([
      { meetingId: "meeting-1", participantIdentity: "participant-1", segmentId: "AJ_job:u0:f0", text: "hello there" },
    ]);
    expect(mocks.offered).toEqual([{ segmentId: "AJ_job:u0", text: "hello there", isFinal: true }]);

    room.emit("participantDisconnected", publisher);
    await entry;
  });

  it("stops listening before it closes the journal", async () => {
    const { publisher, room, entry, context, shutdownCallbacks } = startJob();
    await settled(room);
    room.emit("participantDisconnected", publisher);
    await entry;
    expect(context.shutdown).toHaveBeenLastCalledWith("publisher left the room");

    await shutdownCallbacks[0]();
    expect(mocks.order).toEqual(["supervisor.close", "captions.close", "source.close", "journal.close"]);
  });

  it("ends the job when the LiveKit room disconnects", async () => {
    const { room, entry, context } = startJob();
    await settled(room);
    room.emit("disconnected");
    await entry;
    expect(context.shutdown).toHaveBeenCalledWith("LiveKit room disconnected");
  });

  it("stops waiting when a dispatched publisher is already gone", async () => {
    const room = createRoom(TRANSCRIBING);
    await expect(waitForPublisher(room as never, "participant-1", 0)).resolves.toBeNull();
    expect(room.off).toHaveBeenCalledWith("participantConnected", expect.any(Function));
  });

  it("rejects malformed jobs before connecting", async () => {
    const connect = vi.fn();
    const shutdown = vi.fn();
    await agent.entry({
      connect,
      job: { id: "job-2", participant: { identity: "participant-1" }, room: undefined },
      room: createRoom(TRANSCRIBING),
      shutdown,
    } as never);

    expect(connect).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledWith("publisher job is missing its meeting or participant identity");
  });
});
