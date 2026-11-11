// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { leaveRoomOnPageHide, publishInitialMeetingMedia } from "./meeting-connection";

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

describe("leaveRoomOnPageHide", () => {
  function pageHide(persisted: boolean) {
    const event = new Event("pagehide");
    Object.defineProperty(event, "persisted", { value: persisted });
    window.dispatchEvent(event);
  }

  function setup() {
    const order: string[] = [];
    const room = { disconnect: vi.fn(async () => { order.push("disconnect"); }) };
    const onPageUnload = vi.fn(() => { order.push("unload"); });
    const dispose = leaveRoomOnPageHide(room, onPageUnload);
    return { room, onPageUnload, order, dispose };
  }

  it("tells the session the page is going before leaving the room", () => {
    const { order, dispose } = setup();
    pageHide(false);
    expect(order).toEqual(["unload", "disconnect"]);
    dispose();
  });

  it("leaves the room for a page entering the back/forward cache, without ending the stay", () => {
    const { room, onPageUnload, dispose } = setup();
    pageHide(true);
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    expect(onPageUnload).not.toHaveBeenCalled();
    dispose();
  });

  it("leaves nothing on beforeunload, which a page can survive", () => {
    const { room, onPageUnload, dispose } = setup();
    window.dispatchEvent(new Event("beforeunload"));
    expect(room.disconnect).not.toHaveBeenCalled();
    expect(onPageUnload).not.toHaveBeenCalled();
    dispose();
    pageHide(false);
    expect(room.disconnect).not.toHaveBeenCalled();
  });
});
