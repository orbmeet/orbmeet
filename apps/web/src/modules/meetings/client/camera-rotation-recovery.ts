/**
 * Decision logic for recovering a WebKit camera track that didn't follow a
 * device rotation. Extracted from `use-meeting-camera` so it can be tested
 * without rendering the LiveKit hook.
 *
 * Why a viewport-rotation guard matters: with rotation lock on, orientation
 * events (`orientationchange`, `screen.orientation.change`) can still fire —
 * Stage Manager / Split View resizing, iPadOS beta quirks, or the physical
 * device turning while the interface stays locked — yet the viewport aspect
 * ratio does not change. The old logic compared the track's aspect ratio
 * against a viewport snapshot and restarted whenever they disagreed, so those
 * spurious events flipped the published frame for no reason (the "camera
 * suddenly rotated" symptom). We now restart only when the viewport *actually*
 * rotated to a new orientation and the track is still stuck in the old one.
 */

export interface RotationRecoveryInput {
  /** Viewport orientation recorded the last time recovery ran (or at setup). */
  lastViewportPortrait: boolean;
  /** Current viewport orientation, read after the orientation event settles. */
  viewportPortrait: boolean;
  /** Published camera track dimensions, if available. */
  trackWidth?: number;
  trackHeight?: number;
}

export interface RotationRecoveryDecision {
  /** Whether `restartTrack()` should be called on the local camera track. */
  restart: boolean;
  /** Value to carry forward as the next `lastViewportPortrait`. */
  nextViewportPortrait: boolean;
}

/**
 * Decide whether to restart the local camera track after an orientation event.
 * A given viewport rotation is processed at most once: `nextViewportPortrait`
 * advances whenever the viewport actually changed, so repeated events for the
 * same (e.g. locked) orientation do not retrigger a restart.
 */
export function shouldRestartCameraAfterRotation(
  input: RotationRecoveryInput,
): RotationRecoveryDecision {
  const { lastViewportPortrait, viewportPortrait, trackWidth, trackHeight } = input;

  // The interface didn't rotate (rotation lock, or only the physical device
  // turned). The track has no new orientation to adopt, so restarting would
  // only flip the frame.
  if (viewportPortrait === lastViewportPortrait) {
    return { restart: false, nextViewportPortrait: lastViewportPortrait };
  }

  // Viewport rotated but we can't read the track. Consume the rotation so a
  // later event with stale dimensions can't act on it.
  if (!trackWidth || !trackHeight) {
    return { restart: false, nextViewportPortrait: viewportPortrait };
  }

  // Track already followed the rotation on its own — modern iOS usually does.
  const trackPortrait = trackHeight > trackWidth;
  if (trackPortrait === viewportPortrait) {
    return { restart: false, nextViewportPortrait: viewportPortrait };
  }

  return { restart: true, nextViewportPortrait: viewportPortrait };
}
