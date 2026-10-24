import { describe, expect, it } from "vitest";

import {
  initialPreJoinDeviceState,
  preJoinDeviceReducer,
  type PreJoinDeviceAction,
  type PreJoinDeviceState,
  type ProbedKind,
} from "./pre-join-device-state";

function device(kind: MediaDeviceKind, deviceId: string): MediaDeviceInfo {
  return { kind, deviceId, groupId: "", label: deviceId, toJSON: () => ({}) };
}

const camera = device("videoinput", "cam-1");
const otherCamera = device("videoinput", "cam-2");
const mic = device("audioinput", "mic-1");
const speaker = device("audiooutput", "speaker-1");

const granted = (deviceId: string): ProbedKind => ({ granted: true, error: null, timedOut: false, deviceId });
const refused = (name: string): ProbedKind => ({
  granted: false,
  error: new DOMException(`${name} raised`, name),
  timedOut: false,
  deviceId: undefined,
});

function run(...actions: PreJoinDeviceAction[]): PreJoinDeviceState {
  return actions.reduce(preJoinDeviceReducer, initialPreJoinDeviceState);
}

const probedBoth: PreJoinDeviceAction = {
  type: "probe-finished",
  video: granted("cam-1"),
  audio: granted("mic-1"),
  devices: [camera, otherCamera, mic, speaker],
};

describe("preJoinDeviceReducer", () => {
  it("makes both kinds ready from a granted probe, with the devices it opened", () => {
    const state = run({ type: "probe-started" }, probedBoth, { type: "probe-settled" });
    expect(state).toMatchObject({
      videoAvailable: true,
      audioAvailable: true,
      probedVideoDeviceId: "cam-1",
      probedAudioDeviceId: "mic-1",
      cameraStatus: { state: "ready" },
      microphoneStatus: { state: "ready" },
      isLoadingDevices: false,
      deviceNote: null,
    });
    expect(state.videoDevices).toEqual([camera, otherCamera]);
    expect(state.audioOutputDevices).toEqual([speaker]);
  });

  it("calls a denied camera blocked, not missing, when the browser lists only a placeholder", () => {
    const state = run({
      type: "probe-finished",
      video: refused("NotAllowedError"),
      audio: granted("mic-1"),
      devices: [device("videoinput", ""), mic],
    });
    expect(state.videoDevices).toEqual([]);
    expect(state.videoAvailable).toBe(false);
    expect(state.cameraStatus).toEqual({ state: "unavailable", reason: "permission-denied" });
  });

  it("notes a working device the browser would not list, without calling it unavailable", () => {
    const state = run({ type: "probe-finished", video: granted("cam-1"), audio: granted("mic-1"), devices: [mic] });
    expect(state.videoAvailable).toBe(true);
    expect(state.cameraStatus).toEqual({ state: "ready" });
    expect(state.deviceNote).toMatch(/camera is available, but this browser could not list it/);
  });

  it("keeps the last lists and choice when enumeration times out, and catches up when it arrives", () => {
    const listed = run(probedBoth, { type: "select", kind: "video", deviceId: "cam-2" });
    const timedOut = preJoinDeviceReducer(listed, {
      type: "probe-finished",
      video: granted("cam-2"),
      audio: refused("NotReadableError"),
      devices: null,
    });
    expect(timedOut.videoDevices).toEqual([camera, otherCamera]);
    expect(timedOut.selectedVideoDevice).toBe("cam-2");
    expect(timedOut.microphoneStatus).toEqual({ state: "unavailable", reason: "in-use" });
    expect(timedOut.deviceNote).toMatch(/taking longer than expected/);

    const late = preJoinDeviceReducer(timedOut, {
      type: "late-enumeration",
      video: granted("cam-2"),
      audio: granted("mic-1"),
      devices: [otherCamera, mic],
    });
    expect(late.videoDevices).toEqual([otherCamera]);
    expect(late.audioAvailable).toBe(true);
    expect(late.deviceNote).toBeNull();
  });

  it("drops a choice of a device that is no longer listed", () => {
    const chosen = run(
      probedBoth,
      { type: "select", kind: "video", deviceId: "cam-2" },
      { type: "select", kind: "audioOutput", deviceId: "speaker-1" },
    );
    expect(chosen.selectedVideoDevice).toBe("cam-2");

    const unplugged = preJoinDeviceReducer(chosen, { type: "devices-changed", devices: [camera, mic] });
    expect(unplugged.selectedVideoDevice).toBeUndefined();
    expect(unplugged.selectedAudioOutputDevice).toBeUndefined();
    expect(unplugged.videoAvailable).toBe(true);

    expect(preJoinDeviceReducer(chosen, { type: "select", kind: "video", deviceId: "gone" }).selectedVideoDevice)
      .toBeUndefined();
  });

  it("forgets the camera when the last one is unplugged, but keeps a permission block standing", () => {
    const previewing = run(probedBoth, { type: "preview-opened", deviceId: "cam-1" });
    const unplugged = preJoinDeviceReducer(previewing, { type: "devices-changed", devices: [mic] });
    expect(unplugged).toMatchObject({
      videoAvailable: false,
      previewVideoDeviceId: undefined,
      probedVideoDeviceId: undefined,
      cameraStatus: { state: "unavailable", reason: "not-found" },
    });

    const denied = run({
      type: "probe-finished",
      video: refused("NotAllowedError"),
      audio: granted("mic-1"),
      devices: [device("videoinput", ""), mic],
    }, { type: "devices-changed", devices: [mic] });
    expect(denied.cameraStatus).toEqual({ state: "unavailable", reason: "permission-denied" });
  });

  it("keeps what the user wants apart from what the hardware allows", () => {
    const muted = run(probedBoth, { type: "set-desired", kind: "audio", desired: false });
    const failed = preJoinDeviceReducer(muted, {
      type: "capture-failed",
      kind: "audio",
      error: new DOMException("busy", "NotReadableError"),
    });
    expect(failed).toMatchObject({
      audioDesired: false,
      audioAvailable: false,
      microphoneStatus: { state: "unavailable", reason: "in-use" },
    });
    expect(preJoinDeviceReducer(failed, { type: "retrying", kind: "audio" }).microphoneStatus)
      .toEqual({ state: "pending" });
  });

  it("reports both kinds unusable where no probe can run", () => {
    const state = run(probedBoth, { type: "probe-impossible", reason: "insecure-context" });
    expect(state).toMatchObject({
      videoAvailable: false,
      audioAvailable: false,
      videoDevices: [],
      cameraStatus: { state: "unavailable", reason: "insecure-context" },
      microphoneStatus: { state: "unavailable", reason: "insecure-context" },
    });
  });
});
