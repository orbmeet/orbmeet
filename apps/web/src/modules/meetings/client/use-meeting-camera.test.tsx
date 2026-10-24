// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Room } from "livekit-client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useMeetingCamera } from "./use-meeting-camera";

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
  return { room, setCameraEnabled, enumerateDevices, camera: () => latest! };
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
