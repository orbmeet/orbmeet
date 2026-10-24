type DeviceWithId = Pick<MediaDeviceInfo, "deviceId">;
type TrackWithSettings = Pick<MediaStreamTrack, "getSettings">;

const BROWSER_DEFAULT_DEVICE_ID = "default";

export interface RefreshedMediaDeviceSelection {
  selectedDeviceId: string | undefined;
  shouldSwitchToDefault: boolean;
}

type MissingPreJoinDeviceKind = "all" | "videoinput" | "audioinput" | null;

export interface PreJoinDeviceAvailability {
  videoAvailable: boolean;
  audioAvailable: boolean;
  missing: MissingPreJoinDeviceKind;
}

/** Stable React dependency value that changes when device identity changes. */
export function mediaDeviceIdentityKey(devices: readonly DeviceWithId[]): string {
  return JSON.stringify(devices.map((device) => device.deviceId).sort());
}

/**
 * Browser device lists commonly contain an empty permission placeholder and a
 * synthetic `default` entry. The UI owns the "System default" choice, so only
 * expose concrete, unique devices from the browser.
 */
export function getConcreteMediaDevices(
  devices: readonly MediaDeviceInfo[],
  kind: MediaDeviceKind,
): MediaDeviceInfo[] {
  return devices
    .filter(
      (device) =>
        device.kind === kind && isConcreteMediaDeviceId(device.deviceId),
    )
    .filter(
      (device, index, all) =>
        all.findIndex((candidate) => candidate.deviceId === device.deviceId) ===
        index,
    );
}

export function resolvePreJoinMediaEnabled({
  isLoadingDevices,
  desiredEnabled,
  available,
}: {
  isLoadingDevices: boolean;
  desiredEnabled: boolean;
  available: boolean;
}): boolean | null {
  if (isLoadingDevices) return null;
  return desiredEnabled && available;
}

/**
 * Connections is recomputed from each complete enumeration instead of being a
 * one-way "device missing" flag. That distinction is what lets a pre-join
 * screen heal when a camera or microphone is reattached.
 */
export function resolvePreJoinDeviceAvailability({
  videoDevices,
  audioDevices,
}: {
  videoDevices: readonly DeviceWithId[];
  audioDevices: readonly DeviceWithId[];
}): PreJoinDeviceAvailability {
  const videoAvailable = videoDevices.length > 0;
  const audioAvailable = audioDevices.length > 0;
  return {
    videoAvailable,
    audioAvailable,
    missing:
      !videoAvailable && !audioAvailable
        ? "all"
        : !videoAvailable
          ? "videoinput"
          : !audioAvailable
            ? "audioinput"
            : null,
  };
}

export function isConcreteMediaDeviceId(
  deviceId: string | null | undefined,
): deviceId is string {
  return (
    typeof deviceId === "string" &&
    deviceId.length > 0 &&
    deviceId !== BROWSER_DEFAULT_DEVICE_ID
  );
}

export function getConcreteTrackDeviceId(
  track: TrackWithSettings | null | undefined,
): string | undefined {
  const deviceId = track?.getSettings().deviceId;
  return isConcreteMediaDeviceId(deviceId) ? deviceId : undefined;
}

export function resolveJoinMediaDeviceId({
  selectedDeviceId,
  activeDeviceId,
  devices,
}: {
  selectedDeviceId: string | undefined;
  activeDeviceId: string | undefined;
  devices: readonly DeviceWithId[];
}): string | undefined {
  if (
    isConcreteMediaDeviceId(selectedDeviceId) &&
    devices.some((device) => device.deviceId === selectedDeviceId)
  ) {
    return selectedDeviceId;
  }
  if (!isConcreteMediaDeviceId(activeDeviceId)) return undefined;
  return devices.some((device) => device.deviceId === activeDeviceId)
    ? activeDeviceId
    : undefined;
}

export function resolveRefreshedMediaDeviceSelection({
  selectedDeviceId,
  activeDeviceId,
  devices,
}: {
  selectedDeviceId: string | undefined;
  activeDeviceId: string | undefined;
  devices: readonly DeviceWithId[];
}): RefreshedMediaDeviceSelection {
  const selectedDeviceAvailable =
    !selectedDeviceId || devices.some((device) => device.deviceId === selectedDeviceId);
  const activeDeviceAvailable =
    !isConcreteMediaDeviceId(activeDeviceId) ||
    devices.some((device) => device.deviceId === activeDeviceId);

  return {
    selectedDeviceId: selectedDeviceAvailable ? selectedDeviceId : undefined,
    shouldSwitchToDefault:
      !selectedDeviceAvailable || (!selectedDeviceId && !activeDeviceAvailable),
  };
}

/**
 * A device as a person would name it: its label, the default of its kind when
 * none was chosen, and just its kind when the browser withholds the label (it
 * does until a permission is granted).
 */
export function selectedDeviceLabel(
  devices: readonly Pick<MediaDeviceInfo, "deviceId" | "label">[],
  deviceId: string | undefined,
  kind: "microphone" | "camera",
): string {
  if (!deviceId) return `Default ${kind}`;
  const selected = devices.find((device) => device.deviceId === deviceId);
  return selected?.label || (kind === "microphone" ? "Microphone" : "Camera");
}
