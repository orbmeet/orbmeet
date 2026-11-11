// @vitest-environment jsdom
import { EventEmitter } from "node:events";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RoomEvent, Track, TrackEvent, type Room } from "livekit-client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useMeetingMicrophone } from "./use-meeting-microphone";
import { InitialMeetingMediaContext, type InitialMeetingMediaResult } from "./initial-meeting-media";

let root: Root | null = null;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

/** A room whose local microphone is on only once its publication lands. */
function fakeRoom({ lastMicrophoneError }: { lastMicrophoneError?: Error } = {}) {
  const room = new EventEmitter() as EventEmitter & { localParticipant: Record<string, unknown> };
  let published = false;
  room.localParticipant = {
    get isMicrophoneEnabled() {
      return published;
    },
    lastMicrophoneError,
    lastCameraError: undefined,
    setMicrophoneEnabled: vi.fn(async (enabled: boolean) => {
      published = enabled;
    }),
    getTrackPublication: () => undefined,
  };
  return {
    room: room as unknown as Room,
    publish() {
      published = true;
      room.emit(
        RoomEvent.LocalTrackPublished,
        { source: Track.Source.Microphone },
        room.localParticipant,
      );
    },
    /** What a torn-down connection does to its tracks. */
    unpublish() {
      published = false;
      room.emit(
        RoomEvent.LocalTrackUnpublished,
        { source: Track.Source.Microphone },
        room.localParticipant,
      );
    },
  };
}

describe("useMeetingMicrophone", () => {
  it("shows the mic on when the join's first publish lands after the controls mount", () => {
    const { room, publish } = fakeRoom();
    let isMicOn: boolean | null = null;
    function Probe() {
      isMicOn = useMeetingMicrophone({ roomInstance: room, code: "abc-defg-hij", addToast: vi.fn() }).isMicOn;
      return null;
    }
    root = createRoot(document.createElement("div"));
    act(() => root!.render(<Probe />));
    expect(isMicOn).toBe(false);

    act(() => publish());

    expect(isMicOn).toBe(true);
  });

  it("records a mute the participant chose, for the next connection to start from", () => {
    const { room, publish } = fakeRoom();
    const onChoice = vi.fn();
    let toggle: (() => void) | null = null;
    function Probe() {
      toggle = useMeetingMicrophone({
        roomInstance: room,
        code: "abc-defg-hij",
        addToast: vi.fn(),
        onChoice,
      }).handleToggleMic;
      return null;
    }
    root = createRoot(document.createElement("div"));
    act(() => root!.render(<Probe />));
    act(() => publish());

    act(() => toggle!());

    expect(onChoice).toHaveBeenCalledExactlyOnceWith({ audioEnabled: false });
  });

  it("does not record a mute that comes from the connection being torn down", () => {
    const { room, publish, unpublish } = fakeRoom();
    const onChoice = vi.fn();
    function Probe() {
      useMeetingMicrophone({ roomInstance: room, code: "abc-defg-hij", addToast: vi.fn(), onChoice });
      return null;
    }
    root = createRoot(document.createElement("div"));
    act(() => root!.render(<Probe />));
    act(() => publish());

    act(() => unpublish());

    expect(onChoice).not.toHaveBeenCalled();
  });

  describe("a first microphone the browser refused", () => {
    let visibility: DocumentVisibilityState = "visible";
    beforeAll(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    });
    afterEach(() => {
      visibility = "visible";
    });

    /** The join's publish, settled whenever the test says. */
    function initialPublish() {
      let settle!: (result: InitialMeetingMediaResult) => void;
      const promise = new Promise<InitialMeetingMediaResult>((resolve) => {
        settle = resolve;
      });
      return {
        promise,
        async fail(audioError: Error) {
          await act(async () => settle({ audioError, videoError: null }));
        },
      };
    }

    function mount(room: Room, initialMedia: Promise<InitialMeetingMediaResult>, addToast = vi.fn()) {
      function Probe() {
        useMeetingMicrophone({ roomInstance: room, code: "abc-defg-hij", addToast });
        return null;
      }
      root = createRoot(document.createElement("div"));
      act(() => root!.render(
        <InitialMeetingMediaContext.Provider value={initialMedia}>
          <Probe />
        </InitialMeetingMediaContext.Provider>,
      ));
      return addToast;
    }

    const denied = () => Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    const missing = () => Object.assign(new Error("Requested device not found"), { name: "NotFoundError" });

    it("asks again once the hidden page that was refused shows", async () => {
      visibility = "hidden";
      const { room } = fakeRoom();
      const publish = initialPublish();
      const addToast = mount(room, publish.promise);
      await publish.fail(denied());
      const setMicrophoneEnabled = room.localParticipant.setMicrophoneEnabled as ReturnType<typeof vi.fn>;
      expect(setMicrophoneEnabled).not.toHaveBeenCalled();

      visibility = "visible";
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });

      await vi.waitFor(() => expect(setMicrophoneEnabled).toHaveBeenCalledWith(true));
      expect(addToast).not.toHaveBeenCalled();
    });

    it("asks again at once when the page is already showing", async () => {
      const { room } = fakeRoom();
      const publish = initialPublish();
      mount(room, publish.promise);
      await publish.fail(denied());

      const setMicrophoneEnabled = room.localParticipant.setMicrophoneEnabled as ReturnType<typeof vi.fn>;
      await vi.waitFor(() => expect(setMicrophoneEnabled).toHaveBeenCalledWith(true));
    });

    it("says the microphone is off when it is missing rather than refused", async () => {
      const { room } = fakeRoom();
      const publish = initialPublish();
      const addToast = mount(room, publish.promise);
      await publish.fail(missing());

      expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Joined with microphone off" }));
      expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    });

    it("reports a failure that lands after the meeting view mounted", async () => {
      // The usual order: RTC connects and the view mounts while getUserMedia
      // is still waiting, and only then does it fail.
      const { room } = fakeRoom();
      const publish = initialPublish();
      const addToast = mount(room, publish.promise);
      expect(addToast).not.toHaveBeenCalled();

      await publish.fail(missing());

      expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Joined with microphone off" }));
    });

    it("reports a join's failure once, even when the view is rebuilt", async () => {
      const { room } = fakeRoom();
      const publish = initialPublish();
      const addToast = mount(room, publish.promise);
      await publish.fail(missing());
      act(() => root?.unmount());

      mount(room, publish.promise, addToast);
      await act(async () => {});

      expect(addToast).toHaveBeenCalledTimes(1);
    });
  });

  describe("a microphone whose device went away", () => {
    /** A room whose microphone track LiveKit can end and then mute, as it does on unplug. */
    function roomWithLiveMic() {
      const room = new EventEmitter() as EventEmitter & { localParticipant: Record<string, unknown> };
      const track = new EventEmitter();
      let enabled = true;
      const publication = { source: Track.Source.Microphone, track };
      room.localParticipant = {
        get isMicrophoneEnabled() {
          return enabled;
        },
        lastMicrophoneError: undefined,
        lastCameraError: undefined,
        setMicrophoneEnabled: vi.fn(async (next: boolean) => {
          enabled = next;
        }),
        getTrackPublication: (source: Track.Source) => (source === Track.Source.Microphone ? publication : undefined),
      };
      return {
        room: room as unknown as Room,
        /** LocalParticipant.handleTrackEnded: the restart on the default device failed, so it mutes. */
        deviceLost() {
          track.emit(TrackEvent.Ended, track);
          enabled = false;
          room.emit(RoomEvent.TrackMuted, publication, room.localParticipant);
        },
        /** Anyone else's mute: the participant's own, or a moderator's. */
        mutedElsewhere() {
          enabled = false;
          room.emit(RoomEvent.TrackMuted, publication, room.localParticipant);
        },
      };
    }

    function mount(room: Room, addToast = vi.fn()) {
      let latest: ReturnType<typeof useMeetingMicrophone> | null = null;
      function Probe() {
        latest = useMeetingMicrophone({ roomInstance: room, code: "abc-defg-hij", addToast });
        return null;
      }
      root = createRoot(document.createElement("div"));
      act(() => root!.render(<Probe />));
      return {
        result: {
          get current() {
            return latest;
          },
        },
        addToast,
      };
    }

    it("says so, and turns the microphone back on when one is connected", async () => {
      const { room, deviceLost } = roomWithLiveMic();
      const { result, addToast } = mount(room);
      expect(result.current?.isMicOn).toBe(true);

      act(() => deviceLost());
      expect(result.current?.isMicOn).toBe(false);
      expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Microphone disconnected" }));

      act(() => result.current?.restoreMicAfterDeviceLoss());
      await vi.waitFor(() => expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true));
      expect(result.current?.isMicOn).toBe(true);
      expect(addToast).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Microphone back on" }));
    });

    it("leaves a mute somebody chose alone when a microphone is connected", () => {
      const { room, mutedElsewhere } = roomWithLiveMic();
      const { result, addToast } = mount(room);

      act(() => mutedElsewhere());
      act(() => result.current?.restoreMicAfterDeviceLoss());

      expect(result.current?.isMicOn).toBe(false);
      expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
      expect(addToast).not.toHaveBeenCalled();
    });

    it("does not restore once the participant has made their own choice", () => {
      const { room, deviceLost } = roomWithLiveMic();
      const { result } = mount(room);

      act(() => deviceLost());
      act(() => result.current?.handleToggleMic()); // unmute: fails or not, it is theirs now
      act(() => result.current?.handleToggleMic()); // and mute again
      act(() => result.current?.restoreMicAfterDeviceLoss());

      expect(result.current?.isMicOn).toBe(false);
    });
  });
});
