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

/** What the browser has stored for a kind; null where it cannot say. */
export type MediaPermissionQuery = (name: "camera" | "microphone") => Promise<PermissionState | null>;

/** `navigator.permissions` for the camera or microphone; null where unsupported (Firefox before 131). */
export async function queryMediaPermission(name: "camera" | "microphone"): Promise<PermissionState | null> {
  try {
    const status = await navigator.permissions?.query({ name });
    return status?.state ?? null;
  } catch {
    return null;
  }
}

/**
 * Which kinds may still open after the combined request was refused.
 *
 * `getUserMedia` is all or nothing: a camera the browser may not use refuses
 * the microphone asked for with it. Two refusals are about one kind only, and
 * neither puts up another prompt when the other kind is asked for alone:
 *
 * - The operating system blocks one kind for the browser (macOS or Windows
 *   privacy settings with the camera off and the microphone on — a managed
 *   Mac often ships that way). Chromium says so, not which kind.
 * - The site has one kind blocked and the other not: the camera set to Block
 *   in an earlier visit. That is what a stored `denied` on only one says.
 *
 * Any other refusal — the person answering this prompt with Block, or a
 * browser that cannot say what is stored — is left alone, so nobody is
 * prompted twice.
 */
async function kindsWorthRetrying(
  error: unknown,
  queryPermission: MediaPermissionQuery | undefined,
): Promise<{ video: boolean; audio: boolean }> {
  if (isSystemPermissionDenial(error)) return { video: true, audio: true };
  if (!queryPermission) return { video: false, audio: false };
  const [camera, microphone] = await Promise.all([queryPermission("camera"), queryPermission("microphone")]);
  if ((camera === "denied") === (microphone === "denied")) return { video: false, audio: false };
  return { video: camera !== "denied", audio: microphone !== "denied" };
}

export async function acquirePreJoinMedia(
  request: (
    constraints: MediaStreamConstraints,
    kind: PreJoinMediaProbeKind,
  ) => Promise<MediaStream | null>,
  queryPermission?: MediaPermissionQuery,
): Promise<PreJoinMediaAcquisition> {
  let retry = { video: true, audio: true };
  let refusal: unknown = null;
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
      retry = await kindsWorthRetrying(error, queryPermission);
      refusal = error;
      if (!retry.video && !retry.audio) {
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
  }

  const [video, audio] = await Promise.allSettled([
    retry.video ? request({ video: true }, "video") : Promise.reject(refusal),
    retry.audio ? request({ audio: true }, "audio") : Promise.reject(refusal),
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
 * cancelled, so the call still settles after the deadline — often because a
 * person took their time over the permission prompt. `onLate` receives how it
 * settled: a stream to stop rather than leak with the camera light on, a
 * device list to reconcile, or an answer to the prompt that should count.
 */
export function withProbeTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
  onLate?: (result: PromiseSettledResult<T>) => void,
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

  promise.then(
    (value) => {
      if (timedOut) onLate?.({ status: "fulfilled", value });
    },
    (reason: unknown) => {
      if (timedOut) onLate?.({ status: "rejected", reason });
    },
  );

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== null) clearTimeout(timeoutId);
  });
}
