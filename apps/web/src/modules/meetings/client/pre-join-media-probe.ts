const PERMISSION_FAILURE_NAMES = new Set([
  "NotAllowedError",
  "PermissionDeniedError",
]);

export function isMediaPermissionFailure(error: unknown): boolean {
  return (
    error instanceof Error && PERMISSION_FAILURE_NAMES.has(error.name)
  );
}

/**
 * Chromium's messages when the operating system, not the person, refused: the
 * browser has no camera, microphone or screen-recording access in macOS's or
 * Windows's privacy settings. The error is the same `NotAllowedError` a
 * refused prompt gives, and the message is the only difference
 * (third_party/blink/renderer/modules/mediastream/user_media_processor.cc).
 * Firefox and Safari do not tell the two apart.
 */
const SYSTEM_DENIAL_MESSAGES = new Set([
  "Permission denied by system",
  "System Permissions prevented access to audio capture device",
]);

/** The operating system refused the browser access; nothing in the page or the browser can grant it. */
export function isSystemPermissionDenial(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "NotAllowedError" &&
    SYSTEM_DENIAL_MESSAGES.has(error.message)
  );
}

export type MediaCaptureFailureKind =
  | "system-denied"
  | "permission-denied"
  | "not-found"
  | "device-in-use"
  | "constraints"
  | "unknown";

export function classifyMediaCaptureFailure(error: unknown): MediaCaptureFailureKind {
  const name = error instanceof Error ? error.name : "";
  if (isSystemPermissionDenial(error)) return "system-denied";
  if (PERMISSION_FAILURE_NAMES.has(name) || name === "SecurityError") {
    return "permission-denied";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "not-found";
  if (name === "NotReadableError" || name === "TrackStartError") return "device-in-use";
  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return "constraints";
  }
  return "unknown";
}

export function getMicrophoneCaptureFailureMessage(error: unknown): string {
  switch (classifyMediaCaptureFailure(error)) {
    case "system-denied":
      return "Your computer is blocking this browser from the microphone. Allow it in your privacy settings (System Settings on a Mac, Settings on Windows), then retry.";
    case "permission-denied":
      return "Microphone permission was denied. Allow microphone access in your browser, then retry.";
    case "not-found":
      return "The selected microphone is no longer available. Reconnect it or choose another microphone.";
    case "device-in-use":
      return "Your microphone may be in use by another app. Close it and retry, or join with audio off.";
    case "constraints":
      return "The selected microphone cannot satisfy the requested settings. Choose another microphone and retry.";
    case "unknown":
      return "Your microphone could not be started. Check the selected device and browser settings, then retry.";
  }
}

/**
 * A permission rejection must not immediately trigger a second browser prompt.
 * Hardware/constraint failures can be retried per kind to salvage the working
 * camera or microphone.
 */
export function shouldRetryMediaKindsSeparately(error: unknown): boolean {
  return !isMediaPermissionFailure(error);
}

export type PreJoinMediaProbeKind = "audio_video" | "audio" | "video";

export interface PreJoinMediaAcquisition {
  streams: MediaStream[];
  audioStream: MediaStream | null;
  videoStream: MediaStream | null;
  audioError: unknown | null;
  videoError: unknown | null;
  usedSeparateProbes: boolean;
}

export async function acquirePreJoinMedia(
  request: (
    constraints: MediaStreamConstraints,
    kind: PreJoinMediaProbeKind,
  ) => Promise<MediaStream | null>,
): Promise<PreJoinMediaAcquisition> {
  try {
    const combined = await request(
      { audio: true, video: true },
      "audio_video",
    );
    if (combined) {
      return {
        streams: [combined],
        audioStream: combined,
        videoStream: combined,
        audioError: null,
        videoError: null,
        usedSeparateProbes: false,
      };
    }
    return {
      streams: [],
      audioStream: null,
      videoStream: null,
      audioError: null,
      videoError: null,
      usedSeparateProbes: false,
    };
  } catch (error) {
    if (!shouldRetryMediaKindsSeparately(error)) {
      return {
        streams: [],
        audioStream: null,
        videoStream: null,
        audioError: error,
        videoError: error,
        usedSeparateProbes: false,
      };
    }
  }

  const [video, audio] = await Promise.allSettled([
    request({ video: true }, "video"),
    request({ audio: true }, "audio"),
  ]);
  const videoStream = video.status === "fulfilled" ? video.value : null;
  const audioStream = audio.status === "fulfilled" ? audio.value : null;

  return {
    streams: [...new Set([videoStream, audioStream].filter((stream) => stream !== null))],
    audioStream,
    videoStream,
    audioError: audio.status === "rejected" ? audio.reason : null,
    videoError: video.status === "rejected" ? video.reason : null,
    usedSeparateProbes: true,
  };
}

/**
 * Wait at most `timeoutMs` for a browser media call; null once it gives up.
 *
 * Not `withTimeout`: `getUserMedia` and `enumerateDevices` cannot be
 * cancelled, so the call still settles after the deadline. `onLateValue`
 * receives what it then produces — a stream to stop, or a device list to
 * reconcile — instead of leaking a capture that keeps the camera light on.
 */
export function withProbeTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
  onLateValue?: (value: T) => void,
): Promise<T | null> {
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      onTimeout();
      resolve(null);
    }, timeoutMs);
  });

  promise.then((value) => {
    if (timedOut) onLateValue?.(value);
  }).catch(() => undefined);

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== null) clearTimeout(timeoutId);
  });
}
