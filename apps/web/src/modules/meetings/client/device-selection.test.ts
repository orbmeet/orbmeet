import { describe, expect, it } from "vitest";
import {
  getConcreteMediaDevices,
  getConcreteTrackDeviceId,
  isConcreteMediaDeviceId,
  mediaDeviceIdentityKey,
  resolvePreJoinDeviceAvailability,
  resolvePreJoinMediaEnabled,
  resolveRefreshedMediaDeviceSelection,
  resolveJoinMediaDeviceId,
  selectedDeviceLabel,
} from "./device-selection";

function mediaDevice(
  kind: MediaDeviceKind,
  deviceId: string,
  label = deviceId,
): MediaDeviceInfo {
  return {
    kind,
    deviceId,
    label,
    groupId: "group",
    toJSON: () => ({}),
  };
}

const devices = [
  { deviceId: "default" },
  { deviceId: "camera-macbook" },
  { deviceId: "camera-iphone" },
] as const;

describe("meeting device selection", () => {
  it("returns unique concrete devices and leaves system default to the UI", () => {
    const concrete = getConcreteMediaDevices(
      [
        mediaDevice("audiooutput", ""),
        mediaDevice("audiooutput", "default", "System default"),
        mediaDevice("audiooutput", "speaker-usb"),
        mediaDevice("audiooutput", "speaker-usb"),
        mediaDevice("audioinput", "mic-built-in"),
      ],
      "audiooutput",
    );

    expect(concrete.map((device) => device.deviceId)).toEqual(["speaker-usb"]);
  });

  it("detects one-for-one device replacements", () => {
    expect(mediaDeviceIdentityKey([{ deviceId: "camera-a" }]))
      .not.toBe(mediaDeviceIdentityKey([{ deviceId: "camera-b" }]));
    expect(mediaDeviceIdentityKey([{ deviceId: "camera-a" }, { deviceId: "camera-b" }]))
      .toBe(mediaDeviceIdentityKey([{ deviceId: "camera-b" }, { deviceId: "camera-a" }]));
  });

  it("blocks joining until discovery settles without changing user intent", () => {
    expect(
      resolvePreJoinMediaEnabled({
        isLoadingDevices: true,
        desiredEnabled: true,
        available: false,
      }),
    ).toBeNull();
    expect(
      resolvePreJoinMediaEnabled({
        isLoadingDevices: false,
        desiredEnabled: true,
        available: true,
      }),
    ).toBe(true);
    expect(
      resolvePreJoinMediaEnabled({
        isLoadingDevices: false,
        desiredEnabled: false,
        available: true,
      }),
    ).toBe(false);
  });

  it("restores pre-join availability when devices are reattached", () => {
    expect(
      resolvePreJoinDeviceAvailability({ videoDevices: [], audioDevices: [] }),
    ).toEqual({
      videoAvailable: false,
      audioAvailable: false,
      missing: "all",
    });

    expect(
      resolvePreJoinDeviceAvailability({
        videoDevices: [{ deviceId: "camera-reattached" }],
        audioDevices: [{ deviceId: "mic-reattached" }],
      }),
    ).toEqual({
      videoAvailable: true,
      audioAvailable: true,
      missing: null,
    });
  });

  it("treats empty and browser-default ids as non-concrete", () => {
    expect(isConcreteMediaDeviceId(undefined)).toBe(false);
    expect(isConcreteMediaDeviceId("")).toBe(false);
    expect(isConcreteMediaDeviceId("default")).toBe(false);
    expect(isConcreteMediaDeviceId("camera-macbook")).toBe(true);
  });

  it("prefers an explicit selected device", () => {
    expect(
      resolveJoinMediaDeviceId({
        selectedDeviceId: "camera-iphone",
        activeDeviceId: "camera-macbook",
        devices,
      }),
    ).toBe("camera-iphone");
  });

  it("pins system default to the active preview device when it is still present", () => {
    expect(
      resolveJoinMediaDeviceId({
        selectedDeviceId: undefined,
        activeDeviceId: "camera-macbook",
        devices,
      }),
    ).toBe("camera-macbook");
  });

  it("does not return stale active devices", () => {
    expect(
      resolveJoinMediaDeviceId({
        selectedDeviceId: undefined,
        activeDeviceId: "camera-disconnected",
        devices,
      }),
    ).toBeUndefined();
  });

  it("does not return an explicitly selected device after it disconnects", () => {
    expect(
      resolveJoinMediaDeviceId({
        selectedDeviceId: "camera-disconnected",
        activeDeviceId: undefined,
        devices,
      }),
    ).toBeUndefined();
  });

  it("reads concrete ids from media track settings", () => {
    expect(getConcreteTrackDeviceId({ getSettings: () => ({ deviceId: "camera-macbook" }) })).toBe("camera-macbook");
    expect(getConcreteTrackDeviceId({ getSettings: () => ({ deviceId: "default" }) })).toBeUndefined();
  });

  it("falls back to system default when an explicitly selected microphone disappears", () => {
    expect(
      resolveRefreshedMediaDeviceSelection({
        selectedDeviceId: "mic-usb",
        activeDeviceId: "mic-usb",
        devices: [{ deviceId: "mic-built-in" }],
      }),
    ).toEqual({
      selectedDeviceId: undefined,
      shouldSwitchToDefault: true,
    });
  });

  it("recovers system-default selection when its concrete active microphone disappears", () => {
    expect(
      resolveRefreshedMediaDeviceSelection({
        selectedDeviceId: undefined,
        activeDeviceId: "mic-disconnected",
        devices: [{ deviceId: "mic-built-in" }],
      }),
    ).toEqual({
      selectedDeviceId: undefined,
      shouldSwitchToDefault: true,
    });
  });

  it("falls back to the system camera when the active camera disconnects", () => {
    expect(
      resolveRefreshedMediaDeviceSelection({
        selectedDeviceId: "camera-usb",
        activeDeviceId: "camera-usb",
        devices: [{ deviceId: "camera-built-in" }],
      }),
    ).toEqual({
      selectedDeviceId: undefined,
      shouldSwitchToDefault: true,
    });
  });

  it("does not restart a valid system-default microphone", () => {
    expect(
      resolveRefreshedMediaDeviceSelection({
        selectedDeviceId: undefined,
        activeDeviceId: "mic-built-in",
        devices: [{ deviceId: "mic-built-in" }],
      }),
    ).toEqual({
      selectedDeviceId: undefined,
      shouldSwitchToDefault: false,
    });
  });
});

describe("selectedDeviceLabel", () => {
  const devices = [
    { deviceId: "mic-1", label: "MacBook Pro Microphone" },
    { deviceId: "mic-2", label: "" },
  ];
  it("names the chosen device, the system default, or admits it has no name yet", () => {
    expect(selectedDeviceLabel(devices, "mic-1", "microphone")).toBe("MacBook Pro Microphone");
    expect(selectedDeviceLabel(devices, undefined, "microphone")).toBe("Default microphone");
    expect(selectedDeviceLabel(devices, "mic-2", "microphone")).toBe("Microphone");
  });
});
