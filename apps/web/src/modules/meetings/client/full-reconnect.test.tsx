// @vitest-environment jsdom
// A LiveKit full reconnect, against the meeting's own handlers.
//
// On a signal restart, livekit-client's Room.handleSignalRestarted calls
// LocalParticipant.republishAllTracks(): for every published track it runs
// unpublishTrack(track, false) — emitting LocalTrackUnpublished with the
// capture left running — and then publishes the very same track again.
//
// A real Room, LocalParticipant, LocalTrackPublications, republishAllTracks
// and unpublishTrack; only the network publish is replaced, by one that
// re-adds the publication as a successful publish does.

import { EventEmitter } from "node:events";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  LocalTrackPublication,
  ParticipantEvent,
  Room,
  RoomEvent,
  Track,
  type LocalTrack,
} from "livekit-client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const stopScreenShare = vi.fn(async () => ({ kind: "ok" }));
vi.mock("@/modules/meetings/server/runtime/live.functions", () => ({
  stopScreenShare,
  requestScreenShare: vi.fn(async () => ({ kind: "ok" })),
  decideScreenShare: vi.fn(),
}));

const { useMeetingScreenShare } = await import("./use-meeting-screen-share");
const { useMeetingMicrophone } = await import("./use-meeting-microphone");

let root: Root | null = null;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // livekit-client's isLocalTrack() does `track instanceof MediaStreamTrack`.
  (globalThis as { MediaStreamTrack?: unknown }).MediaStreamTrack ??= class {};
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.clearAllMocks();
});

const SOURCE_PROTO = {
  [Track.Source.Microphone]: 2,
  [Track.Source.ScreenShare]: 3,
  [Track.Source.ScreenShareAudio]: 4,
} as Record<string, number>;

let sidSeq = 0;

function fakeLocalTrack(kind: Track.Kind, source: Track.Source) {
  const track = Object.assign(new EventEmitter(), {
    kind,
    source,
    sid: "",
    isLocal: true,
    isMuted: false,
    isUserProvided: false,
    sender: undefined,
    simulcastCodecs: new Map(),
    mediaStreamTrack: Object.assign(new EventTarget(), { readyState: "live", muted: false, enabled: true }),
    stop: vi.fn(function (this: { mediaStreamTrack: { readyState: string } }) {
      this.mediaStreamTrack.readyState = "ended";
    }),
    stopMonitor: vi.fn(),
    restartTrack: vi.fn(async () => undefined),
    setAudioContext: vi.fn(),
    getProcessor: () => undefined,
    getDeviceId: async () => undefined,
    checkForSilence: async () => false,
  });
  return track as unknown as LocalTrack & { stop: ReturnType<typeof vi.fn> };
}

/** Adds a publication the way a completed publish leaves it. */
function addPublication(room: Room, track: LocalTrack) {
  const info = {
    sid: `TR_${++sidSeq}`,
    name: track.source,
    source: SOURCE_PROTO[track.source],
    mimeType: "",
    width: 0,
    height: 0,
    simulcast: false,
    encryption: 0,
  };
  const publication = new LocalTrackPublication(track.kind, info as never, track);
  (room.localParticipant as unknown as { addTrackPublication(p: unknown): void }).addTrackPublication(publication);
  room.localParticipant.emit(ParticipantEvent.LocalTrackPublished, publication);
  return publication;
}

/** A real, connected-looking room whose network publish always succeeds. */
function connectedRoom() {
  const room = new Room();
  // Room forwards participant events only once its participant listeners are
  // set up, which a real connect does after the join response.
  (room as unknown as { setupLocalParticipantEvents(): void }).setupLocalParticipantEvents();
  const participant = room.localParticipant as unknown as {
    permissions: unknown;
    publishOrRepublishTrack: (track: LocalTrack) => Promise<unknown>;
  };
  participant.permissions = {
    canPublish: true,
    canPublishSources: [1, 2, 3, 4],
  };
  vi.spyOn(participant, "publishOrRepublishTrack").mockImplementation(async (track: LocalTrack) =>
    addPublication(room, track),
  );
  return room;
}

function mountScreenShare(room: Room, canModerate: boolean) {
  function Probe() {
    useMeetingScreenShare({
      roomInstance: room,
      canModerate,
      meetingId: "meeting_1",
      connectionId: "connection_1",
      addToast: vi.fn(),
    });
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => root!.render(<Probe />));
}

describe("a LiveKit full reconnect while sharing a screen", () => {
  it("keeps an attendee's share and the grant it rests on", async () => {
    const room = connectedRoom();
    const screen = fakeLocalTrack(Track.Kind.Video, Track.Source.ScreenShare);
    addPublication(room, screen);
    mountScreenShare(room, false);

    await act(async () => {
      await room.localParticipant.republishAllTracks(undefined, true);
    });

    expect(room.localParticipant.isScreenShareEnabled).toBe(true);
    expect(screen.stop).not.toHaveBeenCalled();
    expect(stopScreenShare).not.toHaveBeenCalled();
  });

  it("keeps the sound of a share that has it", async () => {
    const room = connectedRoom();
    const screen = fakeLocalTrack(Track.Kind.Video, Track.Source.ScreenShare);
    const sound = fakeLocalTrack(Track.Kind.Audio, Track.Source.ScreenShareAudio);
    addPublication(room, screen);
    addPublication(room, sound);
    mountScreenShare(room, true);

    await act(async () => {
      await room.localParticipant.republishAllTracks(undefined, true);
    });

    expect(sound.stop).not.toHaveBeenCalled();
    expect(room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)?.track).toBe(sound);
    expect(room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track).toBe(screen);
  });

  it("still ends the share, sound and grant with it, when the picture really ends", async () => {
    const room = connectedRoom();
    const screen = fakeLocalTrack(Track.Kind.Video, Track.Source.ScreenShare);
    const sound = fakeLocalTrack(Track.Kind.Audio, Track.Source.ScreenShareAudio);
    addPublication(room, screen);
    addPublication(room, sound);
    mountScreenShare(room, false);

    // The browser's "Stop sharing": LiveKit unpublishes the ended picture.
    await act(async () => {
      await room.localParticipant.unpublishTrack(screen);
    });

    expect(sound.stop).toHaveBeenCalled();
    expect(room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)).toBeUndefined();
    expect(stopScreenShare).toHaveBeenCalledTimes(1);
  });
});

describe("a LiveKit full reconnect and the microphone", () => {
  function mountMicrophone(room: Room) {
    const addToast = vi.fn();
    let latest: ReturnType<typeof useMeetingMicrophone> | null = null;
    function Probe() {
      latest = useMeetingMicrophone({ roomInstance: room, code: "abc-defg-hij", addToast });
      return null;
    }
    root = createRoot(document.createElement("div"));
    act(() => root!.render(<Probe />));
    return { addToast, latest: () => latest! };
  }

  it("keeps the microphone on through the republish", async () => {
    const room = connectedRoom();
    addPublication(room, fakeLocalTrack(Track.Kind.Audio, Track.Source.Microphone));
    const mic = mountMicrophone(room);
    await act(async () => {});

    await act(async () => {
      await room.localParticipant.republishAllTracks(undefined, true);
      room.emit(RoomEvent.Reconnected);
    });

    expect(mic.latest().isMicOn).toBe(true);
    expect(mic.addToast).not.toHaveBeenCalled();
  });

  it("asks for the microphone again when the republish lost it, and says so if that fails", async () => {
    const room = connectedRoom();
    const track = fakeLocalTrack(Track.Kind.Audio, Track.Source.Microphone);
    addPublication(room, track);
    const mic = mountMicrophone(room);
    await act(async () => {});

    // Back from sleep, the capture cannot be restarted: LiveKit gives up on
    // publishing it again, and logs the failure.
    (track as unknown as { restartTrack: () => Promise<void> }).restartTrack = async () => {
      throw Object.assign(new Error("Could not start audio source"), { name: "NotReadableError" });
    };
    await act(async () => {
      await room.localParticipant.republishAllTracks(undefined, true).catch(() => undefined);
    });
    expect(room.localParticipant.getTrackPublication(Track.Source.Microphone)).toBeUndefined();
    // Not taken for the user muting.
    expect(mic.latest().isMicOn).toBe(true);

    const enable = vi
      .spyOn(room.localParticipant, "setMicrophoneEnabled")
      .mockRejectedValue(Object.assign(new Error("Could not start audio source"), { name: "NotReadableError" }));
    await act(async () => {
      room.emit(RoomEvent.Reconnected);
    });

    expect(enable).toHaveBeenCalledWith(true);
    expect(mic.addToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Could not unmute" }));
    expect(mic.latest().isMicOn).toBe(false);
  });
});
