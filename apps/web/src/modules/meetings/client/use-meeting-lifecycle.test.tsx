// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RoomContext } from "@livekit/components-react";
import type { Room } from "livekit-client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { useMeetingLifecycle } from "./use-meeting-lifecycle";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  vi.useRealTimers();
});

function fakeRoom() {
  const track = { stop: vi.fn(), mediaStreamTrack: { stop: vi.fn() } };
  const localParticipant = {
    setCameraEnabled: vi.fn(async () => undefined),
    setMicrophoneEnabled: vi.fn(async () => undefined),
    setScreenShareEnabled: vi.fn(async () => undefined),
    trackPublications: new Map([["mic", { track }]]),
  };
  const room = { localParticipant, disconnect: vi.fn(async () => undefined) };
  return { room: room as unknown as Room, localParticipant, track, disconnect: room.disconnect };
}

it("leaves the room and its tracks alone when the view unmounts", () => {
  vi.useFakeTimers();
  const { room, localParticipant, track, disconnect } = fakeRoom();
  let seenRoom: Room | undefined;
  function View() {
    seenRoom = useMeetingLifecycle().roomInstance;
    return null;
  }

  const root = createRoot(document.createElement("div"));
  act(() => root.render(<RoomContext.Provider value={room}><View /></RoomContext.Provider>));
  expect(seenRoom).toBe(room);
  act(() => root.unmount());
  act(() => {
    vi.runAllTimers();
  });

  expect(disconnect).not.toHaveBeenCalled();
  expect(localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
  expect(track.stop).not.toHaveBeenCalled();
});

it("still leaves the room when asked to", async () => {
  const { room, localParticipant, disconnect } = fakeRoom();
  let leave: (() => Promise<void>) | null = null;
  function View() {
    leave = useMeetingLifecycle().disconnectMeetingNow;
    return null;
  }

  const root = createRoot(document.createElement("div"));
  act(() => root.render(<RoomContext.Provider value={room}><View /></RoomContext.Provider>));
  await act(async () => leave!());

  expect(localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false);
  expect(disconnect).toHaveBeenCalledWith(true);
  act(() => root.unmount());
});
