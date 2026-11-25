// @vitest-environment jsdom
import { EventEmitter } from "node:events";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Room, RoomEvent, Track, TrackEvent } from "livekit-client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useMeetingCamera } from "./use-meeting-camera";
import { InitialMeetingMediaContext, type InitialMeetingMediaResult } from "./initial-meeting-media";

let root: Root | null = null;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  Reflect.deleteProperty(navigator, "mediaDevices");
});

/** A real LiveKit room, never connected: it owns the camera constraint either way. */
function mount(options: { initialVideoDeviceId?: string; devices?: MediaDeviceInfo[] } = {}) {
  const room = new Room();
  const setCameraEnabled = vi.spyOn(room.localParticipant, "setCameraEnabled");
  let latest: ReturnType<typeof useMeetingCamera> | null = null;
  // Stable, as the meeting's toast function is: a new one per render would
  // restart the device refresh every render.
  const addToast = vi.fn();
  const enumerateDevices = vi.fn(async () => options.devices ?? []);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { enumerateDevices, addEventListener: vi.fn(), removeEventListener: vi.fn() },
  });
  function Probe() {
    latest = useMeetingCamera({
      roomInstance: room,
      isCameraOn: false,
      initialVideoDeviceId: options.initialVideoDeviceId,
      addToast,
    });
    return null;
  }
  const container = document.createElement("div");
  act(() => {
    root = createRoot(container);
    root.render(<Probe />);
  });
  return { room, setCameraEnabled, enumerateDevices, addToast, camera: () => latest! };
}

const camera = (deviceId: string) =>
  ({ deviceId, kind: "videoinput", groupId: "g", label: deviceId, toJSON: () => ({}) }) as MediaDeviceInfo;

describe("choosing the system camera", () => {
  it("replaces the device an earlier choice pinned, without turning the camera on", async () => {
    const { room, setCameraEnabled, camera: cameraHook } = mount({ devices: [camera("cam-1")] });
    await act(async () => cameraHook().handleSelectVideoDevice("cam-1"));
    expect(room.options.videoCaptureDefaults?.deviceId).toEqual({ exact: "cam-1" });

    await act(async () => cameraHook().handleSelectVideoDevice(undefined));
    // LiveKit merges this into every later capture: a non-exact "default",
    // its own system choice, not the camera chosen before.
    expect(room.options.videoCaptureDefaults?.deviceId).toBe("default");
    expect(cameraHook().currentVideoDeviceId).toBeUndefined();
    expect(setCameraEnabled).not.toHaveBeenCalled();
  });

  it("lets go of a chosen camera that was unplugged while the camera was off", async () => {
    const { room, setCameraEnabled, enumerateDevices, camera: cameraHook } =
      mount({ initialVideoDeviceId: "cam-1", devices: [camera("cam-1")] });
    await act(async () => cameraHook().handleSelectVideoDevice("cam-1"));
    // Unplugged: the next device refresh no longer lists it.
    enumerateDevices.mockResolvedValue([]);
    await act(async () => cameraHook().refreshVideoDevices());
    expect(room.options.videoCaptureDefaults?.deviceId).toBe("default");
    expect(setCameraEnabled).not.toHaveBeenCalled();
  });
});

/** A camera publication on the room, whose track can end the way an unplug ends it. */
function publishFakeCamera(room: Room, track: Partial<{ isMuted: boolean; readyState: string; restartTrack: () => Promise<unknown> }> = {}) {
  const emitter = new EventEmitter();
  const fakeTrack = Object.assign(emitter, {
    isMuted: track.isMuted ?? false,
    mediaStreamTrack: { readyState: track.readyState ?? "live" },
    restartTrack: vi.fn(track.restartTrack ?? (async () => undefined)),
  });
  const publication = { source: Track.Source.Camera, track: fakeTrack };
  vi.spyOn(room.localParticipant, "getTrackPublication").mockImplementation((source) =>
    (source === Track.Source.Camera ? publication : undefined) as never);
  // Bind the watcher to the track, as a real publish would.
  act(() => {
    room.emit(RoomEvent.LocalTrackPublished, publication as never, room.localParticipant);
  });
  return {
    track: fakeTrack,
    /** LocalParticipant.handleTrackEnded: no camera to fall back to, so it mutes. */
    deviceLost() {
      fakeTrack.emit(TrackEvent.Ended, fakeTrack);
      fakeTrack.isMuted = true;
      room.emit(RoomEvent.TrackMuted, publication as never, room.localParticipant);
    },
    mutedByChoice() {
      fakeTrack.isMuted = true;
      room.emit(RoomEvent.TrackMuted, publication as never, room.localParticipant);
    },
  };
}

describe("a camera whose device went away", () => {
  it("says so, and turns the camera back on when one is connected", async () => {
    const { room, setCameraEnabled, enumerateDevices, camera: cameraHook, addToast } = mount();
    setCameraEnabled.mockResolvedValue(undefined);
    const published = publishFakeCamera(room);

    act(() => published.deviceLost());
    expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Camera disconnected" }));

    enumerateDevices.mockResolvedValue([camera("cam-2")]);
    await act(async () => cameraHook().refreshVideoDevices());

    expect(setCameraEnabled).toHaveBeenCalledWith(true, expect.anything(), expect.anything());
    expect(addToast).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Camera back on" }));
  });

  it("leaves a camera somebody turned off alone", async () => {
    const { room, setCameraEnabled, enumerateDevices, camera: cameraHook, addToast } = mount();
    const published = publishFakeCamera(room);

    act(() => published.mutedByChoice());
    enumerateDevices.mockResolvedValue([camera("cam-2")]);
    await act(async () => cameraHook().refreshVideoDevices());

    expect(setCameraEnabled).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
  });
});

describe("a camera the system stopped while the page was away", () => {
  const IPAD_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15";
  let visibility: DocumentVisibilityState = "visible";
  beforeAll(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  });
  afterEach(() => {
    visibility = "visible";
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "userAgent");
    Reflect.deleteProperty(navigator, "maxTouchPoints");
  });

  function asIpad() {
    Object.defineProperty(navigator, "userAgent", { configurable: true, get: () => IPAD_UA });
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, get: () => 5 });
  }

  it("re-opens it on an iPad, which LiveKit takes for a Mac", async () => {
    asIpad();
    const { room } = mount();
    const published = publishFakeCamera(room, { readyState: "ended" });

    await act(async () => document.dispatchEvent(new Event("visibilitychange")));

    expect(published.track.restartTrack).toHaveBeenCalledTimes(1);
  });

  it("turns it off and says so when it cannot be re-opened", async () => {
    asIpad();
    const { room, setCameraEnabled, addToast } = mount();
    setCameraEnabled.mockResolvedValue(undefined);
    publishFakeCamera(room, {
      readyState: "ended",
      restartTrack: async () => {
        throw new DOMException("Could not start video source", "NotReadableError");
      },
    });

    await act(async () => document.dispatchEvent(new Event("visibilitychange")));

    expect(setCameraEnabled).toHaveBeenCalledWith(false);
    expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Camera stopped" }));
  });

  it("leaves a live camera alone", async () => {
    asIpad();
    const { room } = mount();
    const published = publishFakeCamera(room, { readyState: "live" });

    await act(async () => document.dispatchEvent(new Event("visibilitychange")));

    expect(published.track.restartTrack).not.toHaveBeenCalled();
  });
});

describe("a first camera the browser refused to a hidden page", () => {
  let visibility: DocumentVisibilityState = "visible";
  beforeAll(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  });
  afterEach(() => {
    visibility = "visible";
  });

  type AddToast = Parameters<typeof useMeetingCamera>[0]["addToast"];
  function mountWith(room: Room, initialMedia: Promise<InitialMeetingMediaResult>, addToast: AddToast) {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { enumerateDevices: vi.fn(async () => []), addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    function Probe() {
      useMeetingCamera({ roomInstance: room, isCameraOn: false, initialVideoDeviceId: undefined, addToast });
      return null;
    }
    act(() => {
      root = createRoot(document.createElement("div"));
      root.render(
        <InitialMeetingMediaContext.Provider value={initialMedia}>
          <Probe />
        </InitialMeetingMediaContext.Provider>,
      );
    });
  }

  it("still asks again when the view is rebuilt while the page is hidden", async () => {
    visibility = "hidden";
    const room = new Room();
    const setCameraEnabled = vi.spyOn(room.localParticipant, "setCameraEnabled").mockResolvedValue(undefined);
    const addToast = vi.fn<AddToast>();
    const denied = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    const initialMedia = Promise.resolve<InitialMeetingMediaResult>({ audioError: null, videoError: denied });
    mountWith(room, initialMedia, addToast);
    await act(async () => {});
    act(() => root?.unmount());
    mountWith(room, initialMedia, addToast);
    await act(async () => {});
    expect(setCameraEnabled).not.toHaveBeenCalled();

    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await vi.waitFor(() => expect(setCameraEnabled).toHaveBeenCalledWith(true, expect.anything(), expect.anything()));
    expect(addToast).not.toHaveBeenCalled();
  });
});
