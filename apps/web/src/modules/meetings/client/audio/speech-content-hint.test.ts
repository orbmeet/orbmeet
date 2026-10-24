import { describe, expect, it, vi } from "vitest";
import {
  RoomEvent,
  Track,
  TrackEvent,
  type LocalTrack,
  type LocalTrackPublication,
  type Room,
} from "livekit-client";
import {
  applySpeechContentHint,
  installMeetingMicrophoneSpeechHint,
} from "./speech-content-hint";

describe("applySpeechContentHint", () => {
  it("marks a supported media track as speech", () => {
    const mediaTrack = { contentHint: "" };

    expect(applySpeechContentHint(mediaTrack)).toBe(true);
    expect(mediaTrack.contentHint).toBe("speech");
  });

  it("does not break capture when the browser rejects the hint", () => {
    const mediaTrack = Object.defineProperty({}, "contentHint", {
      configurable: true,
      get: () => "",
      set: () => {
        throw new DOMException("Unsupported content hint", "NotSupportedError");
      },
    }) as Pick<MediaStreamTrack, "contentHint">;

    expect(applySpeechContentHint(mediaTrack)).toBe(false);
  });
});

describe("installMeetingMicrophoneSpeechHint", () => {
  it("applies the hint after publication and every track restart", () => {
    let restarted: ((track: LocalTrack) => void) | undefined;
    const firstMediaTrack = { contentHint: "" };
    const track = {
      kind: Track.Kind.Audio,
      mediaStreamTrack: firstMediaTrack,
      on: vi.fn((event: TrackEvent, listener: (track: LocalTrack) => void) => {
        if (event === TrackEvent.Restarted) restarted = listener;
        return track;
      }),
      off: vi.fn(() => track),
    };
    const roomListeners = new Map<RoomEvent, (publication: LocalTrackPublication) => void>();
    const room = {
      localParticipant: { trackPublications: new Map() },
      on: vi.fn((event: RoomEvent, listener: (publication: LocalTrackPublication) => void) => {
        roomListeners.set(event, listener);
        return room;
      }),
      off: vi.fn((event: RoomEvent) => {
        roomListeners.delete(event);
        return room;
      }),
    };
    const publication = {
      source: Track.Source.Microphone,
      track,
    } as unknown as LocalTrackPublication;

    const dispose = installMeetingMicrophoneSpeechHint(room as unknown as Room);
    roomListeners.get(RoomEvent.LocalTrackPublished)?.(publication);

    expect(firstMediaTrack.contentHint).toBe("speech");
    expect(track.on).toHaveBeenCalledWith(TrackEvent.Restarted, expect.any(Function));

    const replacementMediaTrack = { contentHint: "" };
    track.mediaStreamTrack = replacementMediaTrack;
    restarted?.(track as unknown as LocalTrack);

    expect(replacementMediaTrack.contentHint).toBe("speech");

    roomListeners.get(RoomEvent.LocalTrackUnpublished)?.(publication);
    expect(track.off).toHaveBeenCalledWith(TrackEvent.Restarted, expect.any(Function));

    dispose();
  });

  it("ignores non-microphone audio tracks", () => {
    const mediaTrack = { contentHint: "" };
    const track = {
      kind: Track.Kind.Audio,
      mediaStreamTrack: mediaTrack,
      on: vi.fn(),
      off: vi.fn(),
    };
    const publication = {
      source: Track.Source.ScreenShareAudio,
      track,
    } as unknown as LocalTrackPublication;
    const roomListeners = new Map<RoomEvent, (publication: LocalTrackPublication) => void>();
    const room = {
      localParticipant: { trackPublications: new Map() },
      on: vi.fn((event: RoomEvent, listener: (publication: LocalTrackPublication) => void) => {
        roomListeners.set(event, listener);
        return room;
      }),
      off: vi.fn(() => room),
    };

    const dispose = installMeetingMicrophoneSpeechHint(room as unknown as Room);
    roomListeners.get(RoomEvent.LocalTrackPublished)?.(publication);

    expect(mediaTrack.contentHint).toBe("");
    expect(track.on).not.toHaveBeenCalled();

    dispose();
  });
});
