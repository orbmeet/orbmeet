import { describe, expect, it, vi } from "vitest";
import { publishInitialMeetingMedia } from "./meeting-connection";

describe("publishInitialMeetingMedia", () => {
  it("starts the selected microphone and camera after signaling connects", async () => {
    const setMicrophoneEnabled = vi.fn(async () => undefined);
    const setCameraEnabled = vi.fn(async () => undefined);

    const result = await publishInitialMeetingMedia(
      { setMicrophoneEnabled, setCameraEnabled },
      {
        audioEnabled: true,
        audioDeviceId: "mic-1",
        videoEnabled: true,
        videoDeviceId: "camera-1",
      },
    );

    expect(setMicrophoneEnabled).toHaveBeenCalledWith(true, {
      deviceId: "mic-1",
    });
    expect(setCameraEnabled).toHaveBeenCalledWith(true, {
      deviceId: "camera-1",
    });
    expect(result).toEqual({ audioError: null, videoError: null });
  });

  it("does not pin a device onto a track that starts disabled", async () => {
    // The pre-join device choice still reaches RoomOptions capture defaults, so
    // the first in-meeting unmute lands on the chosen microphone; it just must
    // not be attached to a publish that never happens.
    const setMicrophoneEnabled = vi.fn(async () => undefined);
    const setCameraEnabled = vi.fn(async () => undefined);

    await publishInitialMeetingMedia(
      { setMicrophoneEnabled, setCameraEnabled },
      {
        audioEnabled: false,
        audioDeviceId: "mic-1",
        videoEnabled: false,
        videoDeviceId: "camera-1",
      },
    );

    expect(setMicrophoneEnabled).toHaveBeenCalledWith(false, undefined);
    expect(setCameraEnabled).toHaveBeenCalledWith(false, undefined);
  });

  it("does not invent device constraints when joining muted", async () => {
    const setMicrophoneEnabled = vi.fn(async () => undefined);
    const setCameraEnabled = vi.fn(async () => undefined);

    await publishInitialMeetingMedia(
      { setMicrophoneEnabled, setCameraEnabled },
      {
        audioEnabled: false,
        videoEnabled: false,
      },
    );

    expect(setMicrophoneEnabled).toHaveBeenCalledWith(false, undefined);
    expect(setCameraEnabled).toHaveBeenCalledWith(false, undefined);
  });

  it("settles microphone and camera independently so either device can recover in-room", async () => {
    const microphoneError = new DOMException("microphone unavailable", "NotReadableError");
    const setMicrophoneEnabled = vi.fn(async () => {
      throw microphoneError;
    });
    const setCameraEnabled = vi.fn(async () => undefined);

    const result = await publishInitialMeetingMedia(
      { setMicrophoneEnabled, setCameraEnabled },
      { audioEnabled: true, videoEnabled: true },
    );

    expect(setCameraEnabled).toHaveBeenCalledOnce();
    expect(result).toEqual({ audioError: microphoneError, videoError: null });
  });

  it("keeps microphone publication when initial camera capture fails", async () => {
    const cameraError = new DOMException("camera unavailable", "NotReadableError");
    const setMicrophoneEnabled = vi.fn(async () => undefined);
    const setCameraEnabled = vi.fn(async () => {
      throw cameraError;
    });

    const result = await publishInitialMeetingMedia(
      { setMicrophoneEnabled, setCameraEnabled },
      { audioEnabled: true, videoEnabled: true },
    );

    expect(setMicrophoneEnabled).toHaveBeenCalledOnce();
    expect(result).toEqual({ audioError: null, videoError: cameraError });
  });
});
