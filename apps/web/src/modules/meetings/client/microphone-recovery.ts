import { Track } from "livekit-client";

const DEFAULT_SETTLE_MS = 350;

interface RecoverableMicrophoneTrack {
  kind: Track.Kind;
  mediaStreamTrack: Pick<MediaStreamTrack, "enabled" | "muted" | "readyState">;
  restartTrack?: () => Promise<void>;
}

interface RecoverableMicrophonePublication {
  track?: RecoverableMicrophoneTrack;
  isMuted?: boolean;
}

export interface RecoverableMicrophoneParticipant {
  isMicrophoneEnabled: boolean;
  getTrackPublication: (source: Track.Source) => RecoverableMicrophonePublication | undefined;
  setMicrophoneEnabled: (enabled: boolean) => Promise<unknown>;
}

export interface MicrophoneRecoverySnapshot {
  participantMicEnabled: boolean;
  hasPublication: boolean;
  hasTrack: boolean;
  publicationMuted: boolean | null;
  trackEnabled: boolean | null;
  trackMuted: boolean | null;
  trackReadyState: MediaStreamTrackState | null;
}

export type MicrophoneRecoveryResult = "ok" | "cancelled" | "restarted" | "reenabled";

interface RecoverLocalMicrophoneOptions {
  settleMs?: number;
  /**
   * Reports whether the user still wants the microphone on. It must describe
   * *intent* (a newer user action, a torn-down room) and must not sample the
   * live microphone state — recovery toggles that state itself, so a
   * state-derived guard cancels on its own work.
   */
  shouldContinue?: () => boolean;
  onRecoveryAttempt?: (snapshot: MicrophoneRecoverySnapshot) => void;
  /** Routes recovery's own mute cycle through the controller that owns intent. */
  setMicrophoneEnabled?: (enabled: boolean) => Promise<unknown>;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getMicrophonePublication(participant: RecoverableMicrophoneParticipant) {
  return participant.getTrackPublication(Track.Source.Microphone);
}

export function getMicrophoneTrack(
  participant: RecoverableMicrophoneParticipant,
): RecoverableMicrophoneTrack | null {
  const track = getMicrophonePublication(participant)?.track;
  if (!track || track.kind !== Track.Kind.Audio) return null;
  return track;
}

export function getLocalMicrophoneRecoverySnapshot(
  participant: RecoverableMicrophoneParticipant,
): MicrophoneRecoverySnapshot {
  const publication = getMicrophonePublication(participant);
  const track = getMicrophoneTrack(participant);
  const mediaTrack = track?.mediaStreamTrack;

  return {
    participantMicEnabled: participant.isMicrophoneEnabled,
    hasPublication: Boolean(publication),
    hasTrack: Boolean(track),
    publicationMuted: typeof publication?.isMuted === "boolean" ? publication.isMuted : null,
    trackEnabled: typeof mediaTrack?.enabled === "boolean" ? mediaTrack.enabled : null,
    trackMuted: typeof mediaTrack?.muted === "boolean" ? mediaTrack.muted : null,
    trackReadyState: mediaTrack?.readyState ?? null,
  };
}

export function isLocalMicrophoneHealthy(snapshot: MicrophoneRecoverySnapshot): boolean {
  return (
    snapshot.participantMicEnabled &&
    snapshot.hasPublication &&
    snapshot.hasTrack &&
    snapshot.publicationMuted !== true &&
    snapshot.trackReadyState === "live" &&
    snapshot.trackEnabled === true &&
    snapshot.trackMuted === false
  );
}

async function waitForSettle(options: Required<Pick<RecoverLocalMicrophoneOptions, "settleMs">>) {
  if (options.settleMs <= 0) return;
  await wait(options.settleMs);
}

export async function recoverLocalMicrophoneAfterUnmute(
  participant: RecoverableMicrophoneParticipant,
  options: RecoverLocalMicrophoneOptions = {},
): Promise<MicrophoneRecoveryResult> {
  const settleOptions = { settleMs: options.settleMs ?? DEFAULT_SETTLE_MS };
  const shouldContinue = options.shouldContinue ?? (() => true);

  await waitForSettle(settleOptions);
  if (!shouldContinue()) return "cancelled";

  let snapshot = getLocalMicrophoneRecoverySnapshot(participant);
  if (isLocalMicrophoneHealthy(snapshot)) return "ok";

  options.onRecoveryAttempt?.(snapshot);

  const track = getMicrophoneTrack(participant);
  if (track?.restartTrack) {
    try {
      await track.restartTrack();
      await waitForSettle(settleOptions);
      if (!shouldContinue()) return "cancelled";

      snapshot = getLocalMicrophoneRecoverySnapshot(participant);
      if (isLocalMicrophoneHealthy(snapshot)) return "restarted";
    } catch {
      if (!shouldContinue()) return "cancelled";
    }
  }

  if (!shouldContinue()) return "cancelled";
  // The disable/enable cycle is atomic. Cancellation is checked before it
  // starts and after it completes, never in between: a guard that samples the
  // microphone state would trip on this function's own disable and strand the
  // user muted right after they asked to be unmuted.
  const setMicrophoneEnabled = options.setMicrophoneEnabled
    ?? ((enabled: boolean) => participant.setMicrophoneEnabled(enabled));
  await setMicrophoneEnabled(false);
  await setMicrophoneEnabled(true);
  if (!shouldContinue()) {
    // The user muted (or left) while the cycle was in flight. Honour that
    // intent rather than leaving the freshly re-acquired track live.
    await setMicrophoneEnabled(false).catch(() => undefined);
    return "cancelled";
  }

  await waitForSettle(settleOptions);
  if (!shouldContinue()) return "cancelled";

  snapshot = getLocalMicrophoneRecoverySnapshot(participant);
  if (isLocalMicrophoneHealthy(snapshot)) return "reenabled";

  throw new Error("The microphone did not recover after unmuting. Please rejoin the meeting.");
}
