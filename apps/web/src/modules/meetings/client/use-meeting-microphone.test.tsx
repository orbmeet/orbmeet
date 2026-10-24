// @vitest-environment jsdom
import { EventEmitter } from "node:events";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RoomEvent, Track, type Room } from "livekit-client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useMeetingMicrophone } from "./use-meeting-microphone";

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

    function mount(room: Room, addToast = vi.fn()) {
      function Probe() {
        useMeetingMicrophone({ roomInstance: room, code: "abc-defg-hij", addToast });
        return null;
      }
      root = createRoot(document.createElement("div"));
      act(() => root!.render(<Probe />));
      return addToast;
    }

    const denied = () => Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });

    it("asks again once the hidden page that was refused shows", async () => {
      visibility = "hidden";
      const { room } = fakeRoom({ lastMicrophoneError: denied() });
      const addToast = mount(room);
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
      const { room } = fakeRoom({ lastMicrophoneError: denied() });
      mount(room);

      const setMicrophoneEnabled = room.localParticipant.setMicrophoneEnabled as ReturnType<typeof vi.fn>;
      await vi.waitFor(() => expect(setMicrophoneEnabled).toHaveBeenCalledWith(true));
    });

    it("says the microphone is off when it is missing rather than refused", () => {
      const { room } = fakeRoom({
        lastMicrophoneError: Object.assign(new Error("Requested device not found"), { name: "NotFoundError" }),
      });
      const addToast = mount(room);

      expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Joined with microphone off" }));
      expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    });
  });
});
