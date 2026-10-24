/**
 * Why a camera or microphone is unusable, and what to say about it.
 *
 * The pre-join screen used to derive its copy from two independent facts: a
 * single `deviceError` string assembled from a ladder of boolean flags, and a
 * picker placeholder keyed only off `devices.length === 0`. Those disagreed in
 * the most common failure of all. When permission is denied the browser still
 * reports the device, but with a blank `deviceId`, so the concrete-device
 * filter dropped it and the picker said "No microphone detected" while the
 * banner said permission was denied. Users read the picker, concluded their
 * hardware was broken, and filed hardware bugs for a permission prompt.
 *
 * So cause is modelled once, per kind, and every piece of copy is derived from
 * it. There is no path that can report "not detected" for a device the browser
 * told us about.
 */

import { classifyMediaCaptureFailure } from "@/modules/meetings/client/pre-join-media-probe";

export type MediaKind = "camera" | "microphone";

/**
 * Ordered by how actionable the fix is, not by how the browser reports it.
 * `permission-denied` and `not-found` are deliberately distinct: they send the
 * user to completely different places (browser settings vs. a cable).
 */
export type DeviceUnavailableReason =
  | "permission-denied"
  | "not-found"
  | "in-use"
  | "constraints"
  | "insecure-context"
  | "unsupported"
  | "timeout"
  | "unknown";

export type MediaKindStatus =
  | { state: "pending" }
  | { state: "ready" }
  | { state: "unavailable"; reason: DeviceUnavailableReason };

export interface PreJoinDeviceStatuses {
  camera: MediaKindStatus;
  microphone: MediaKindStatus;
}

const KIND_NOUN: Record<MediaKind, string> = {
  camera: "camera",
  microphone: "microphone",
};

const KIND_NOUN_CAPITALIZED: Record<MediaKind, string> = {
  camera: "Camera",
  microphone: "Microphone",
};

/** What the user loses by joining anyway, phrased as the consequence. */
const KIND_CONSEQUENCE: Record<MediaKind, string> = {
  camera: "join with your camera off",
  microphone: "join muted — no one will hear you",
};

/**
 * Classify a `getUserMedia` rejection, with the enumeration result as a
 * tie-breaker.
 *
 * `enumeratedCount` is the number of devices of this kind the browser listed,
 * *including* the blank-`deviceId` placeholders it emits before permission is
 * granted. That distinction is the whole point: zero really does mean no
 * hardware, and a placeholder means hardware exists but is hidden behind a
 * prompt. Pass `null` when enumeration did not complete — an absent count is
 * not the same as a count of zero, and must not be read as "no hardware".
 */
export function classifyDeviceFailure({
  error,
  enumeratedCount,
  timedOut = false,
}: {
  error: unknown;
  enumeratedCount: number | null;
  timedOut?: boolean;
}): DeviceUnavailableReason {
  if (timedOut) return "timeout";

  switch (classifyMediaCaptureFailure(error)) {
    case "permission-denied":
      return "permission-denied";
    case "device-in-use":
      return "in-use";
    case "constraints":
      return "constraints";
    case "not-found":
      return "not-found";
    case "unknown":
      // Chrome reports a hard `NotAllowedError` both for a real denial and for
      // a policy/OS-level block, and some builds report neither. Enumeration
      // is the only signal left: no entries at all means no hardware. An
      // unknown count stays "unknown" rather than guessing.
      return enumeratedCount === 0 ? "not-found" : "unknown";
  }
}

/**
 * Text for the device picker when no device of this kind can be selected.
 *
 * Never says "not detected" unless the browser genuinely listed nothing.
 */
export function getDevicePickerPlaceholder(
  kind: MediaKind,
  status: MediaKindStatus,
): string {
  if (status.state === "pending") return "Loading…";
  if (status.state === "ready") return `No ${KIND_NOUN[kind]} selected`;

  const noun = KIND_NOUN_CAPITALIZED[kind];
  switch (status.reason) {
    case "permission-denied":
      return `${noun} blocked`;
    case "not-found":
      return `No ${KIND_NOUN[kind]} detected`;
    case "in-use":
      return `${noun} in use`;
    case "constraints":
      return `${noun} unsupported`;
    case "insecure-context":
      return `${noun} unavailable`;
    case "unsupported":
      return `${noun} unsupported`;
    case "timeout":
      return "Still checking…";
    case "unknown":
      return `${noun} unavailable`;
  }
}

/**
 * Why a mic/camera toggle is inert, for the button's tooltip and accessible
 * description. `null` means the toggle works and should not be disabled.
 *
 * Before this existed the buttons stayed enabled and did nothing when clicked:
 * the single most-reported symptom of the permission bug was "I clicked unmute
 * and nothing happened".
 */
export function getToggleBlockedReason(
  kind: MediaKind,
  status: MediaKindStatus,
): string | null {
  if (status.state !== "unavailable") return null;

  const noun = KIND_NOUN[kind];
  switch (status.reason) {
    case "permission-denied":
      return `${KIND_NOUN_CAPITALIZED[kind]} access is blocked in your browser. Allow it in the address bar, then retry.`;
    case "not-found":
      return `No ${noun} detected. Connect one, then retry.`;
    case "in-use":
      return `Your ${noun} is in use by another app. Close it, then retry.`;
    case "constraints":
      return `Your ${noun} cannot satisfy the requested settings. Choose another, then retry.`;
    case "insecure-context":
      return `Your ${noun} is only available over HTTPS or on localhost.`;
    case "unsupported":
      return `This browser cannot open your ${noun}.`;
    case "timeout":
      return `Still checking for your ${noun}.`;
    case "unknown":
      return `Your ${noun} could not be started. Retry, or join without it.`;
  }
}

export interface DeviceNotice {
  /** What went wrong and how to fix it. */
  message: string;
  /**
   * What joining anyway will mean, stated plainly. Rendered alongside the join
   * button so the consequence is visible at the moment of the decision — the
   * banner alone was read as a warning about permissions, not about being
   * inaudible for the whole meeting.
   */
  consequence: string | null;
  /** Whether retrying could plausibly change the outcome. */
  retryable: boolean;
}

/**
 * The single banner for the pre-join screen.
 *
 * Reasons are merged rather than concatenated: one sentence naming both
 * devices reads better than two stacked warnings, and the shared fix
 * (permission, HTTPS) is the same sentence either way.
 */
export function getDeviceNotice(statuses: PreJoinDeviceStatuses): DeviceNotice | null {
  const { camera, microphone } = statuses;
  if (camera.state === "pending" || microphone.state === "pending") return null;

  const cameraDown = camera.state === "unavailable";
  const microphoneDown = microphone.state === "unavailable";
  if (!cameraDown && !microphoneDown) return null;

  const consequence = microphoneDown
    ? `You can still ${KIND_CONSEQUENCE.microphone}.`
    : `You can still ${KIND_CONSEQUENCE.camera}.`;

  // Both down for the same reason: say it once, about both.
  if (
    cameraDown &&
    microphoneDown &&
    camera.state === "unavailable" &&
    microphone.state === "unavailable" &&
    camera.reason === microphone.reason
  ) {
    return {
      message: describeBothUnavailable(camera.reason),
      consequence: "You can still join with audio and video off.",
      retryable: isRetryable(camera.reason),
    };
  }

  const parts: string[] = [];
  if (microphoneDown && microphone.state === "unavailable") {
    parts.push(getToggleBlockedReason("microphone", microphone) ?? "");
  }
  if (cameraDown && camera.state === "unavailable") {
    parts.push(getToggleBlockedReason("camera", camera) ?? "");
  }

  const retryable =
    (microphone.state === "unavailable" && isRetryable(microphone.reason)) ||
    (camera.state === "unavailable" && isRetryable(camera.reason));

  return {
    message: parts.filter(Boolean).join(" "),
    consequence,
    retryable,
  };
}

function describeBothUnavailable(reason: DeviceUnavailableReason): string {
  switch (reason) {
    case "permission-denied":
      return "Camera and microphone access is blocked in your browser. Allow it in the address bar, then retry.";
    case "not-found":
      return "No camera or microphone detected. Connect one, then retry.";
    case "in-use":
      return "Your camera and microphone are in use by another app. Close it, then retry.";
    case "constraints":
      return "Your camera and microphone cannot satisfy the requested settings.";
    case "insecure-context":
      return "Camera and microphone are only available over HTTPS or on localhost.";
    case "unsupported":
      return "This browser cannot open your camera or microphone.";
    case "timeout":
      return "Still checking for your camera and microphone.";
    case "unknown":
      return "Your camera and microphone could not be started. Retry, or join without them.";
  }
}

/**
 * Retrying re-runs the probe. That helps when the user has just changed
 * something outside the page (granted permission, plugged a device in, closed
 * the app holding it). It cannot help when the context itself is wrong.
 */
function isRetryable(reason: DeviceUnavailableReason): boolean {
  return reason !== "insecure-context" && reason !== "unsupported";
}

/**
 * Whether joining now means joining without audio, which is the state worth
 * confirming before the user commits to a meeting they cannot speak in.
 */
export function willJoinSilent(statuses: PreJoinDeviceStatuses): boolean {
  return statuses.microphone.state === "unavailable";
}

/**
 * Fold a `devicechange` enumeration into an existing verdict.
 *
 * A hotplug carries exactly one fact — whether the browser now lists a concrete
 * device of this kind — and that fact answers "is there hardware", never "may
 * this page use it". Overwriting the status wholesale from it reported two
 * plain falsehoods: plugging a headset in while permission was blocked replaced
 * the truthful `permission-denied` with "not detected", the precise confusion
 * this module exists to prevent; and granting permission from the address bar
 * (which makes device ids concrete, and therefore fires this event) left the
 * banner insisting the microphone was blocked while the live preview ran.
 *
 * A concrete device id is only exposed after a grant, so `present` is positive
 * evidence that permission now exists, and it clears a stale block. Absence is
 * ambiguous — no hardware, or hardware hidden behind a denial — so it may set
 * `not-found` only where nothing better is already known. Verdicts about the
 * page's environment rather than its hardware (`permission-denied`,
 * `insecure-context`, `unsupported`) already explain the absence and stand
 * until something actually reprobes.
 */
export function applyDeviceChangeToStatus(
  current: MediaKindStatus,
  present: boolean,
): MediaKindStatus {
  if (present) {
    if (
      current.state === "unavailable" &&
      (current.reason === "not-found" || current.reason === "permission-denied")
    ) {
      return { state: "ready" };
    }
    return current;
  }
  if (
    current.state === "unavailable" &&
    (current.reason === "permission-denied" ||
      current.reason === "insecure-context" ||
      current.reason === "unsupported")
  ) {
    return current;
  }
  return { state: "unavailable", reason: "not-found" };
}
