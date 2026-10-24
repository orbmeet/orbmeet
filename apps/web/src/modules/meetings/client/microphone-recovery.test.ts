import { describe, expect, it, vi } from "vitest";
import { Track } from "livekit-client";
import {
  getLocalMicrophoneRecoverySnapshot,
  isLocalMicrophoneHealthy,
  recoverLocalMicrophoneAfterUnmute,
  type RecoverableMicrophoneParticipant,
} from "./microphone-recovery";

function createParticipant({
  publicationMuted = false,
  trackEnabled = true,
  trackMuted = false,
  trackReadyState = "live",
  restartTrack,
}: {
  publicationMuted?: boolean;
  trackEnabled?: boolean;
  trackMuted?: boolean;
  trackReadyState?: MediaStreamTrackState;
  restartTrack?: () => Promise<void>;
} = {}): RecoverableMicrophoneParticipant {
  const mediaStreamTrack = {
    enabled: trackEnabled,
    muted: trackMuted,
    readyState: trackReadyState,
  };
  return {
    isMicrophoneEnabled: true,
    getTrackPublication: () => ({
      isMuted: publicationMuted,
      track: {
        kind: Track.Kind.Audio,
        mediaStreamTrack,
        restartTrack,
      },
    }),
    setMicrophoneEnabled: vi.fn(async (enabled: boolean) => {
      mediaStreamTrack.enabled = enabled;
    }),
  };
}

/**
 * Mirrors livekit-client's actual state model, where `isMicrophoneEnabled` is
 * derived from the publication rather than being an independent flag:
 *
 *   Participant.isMicrophoneEnabled -> !(publication?.isMuted ?? true)
 *   LocalTrackPublication.isMuted   -> track.isMuted
 *   LocalTrack.mute()               -> sets isMuted synchronously
 *
 * so `await setMicrophoneEnabled(false)` leaves `isMicrophoneEnabled` false.
 */
function createStatefulParticipant({
  browserMuted = true,
  restartTrack,
}: {
  browserMuted?: boolean;
  restartTrack?: () => Promise<void>;
} = {}) {
  let publicationMuted = false;
  let suspended = browserMuted;

  const participant: RecoverableMicrophoneParticipant = {
    get isMicrophoneEnabled() {
      return !publicationMuted;
    },
    getTrackPublication: () => ({
      get isMuted() {
        return publicationMuted;
      },
      track: {
        kind: Track.Kind.Audio,
        mediaStreamTrack: {
          get enabled() {
            return !publicationMuted;
          },
          get muted() {
            return suspended;
          },
          readyState: "live",
        },
        restartTrack,
      },
    }),
    setMicrophoneEnabled: vi.fn(async (enabled: boolean) => {
      publicationMuted = !enabled;
      // Re-acquiring the device clears the browser-level suspension, which is
      // what the disable/enable cycle exists to achieve.
      if (enabled) suspended = false;
    }),
  };

  return participant;
}

describe("microphone recovery", () => {
  it("treats a live, enabled, unmuted local microphone as healthy", () => {
    const participant = createParticipant();
    const snapshot = getLocalMicrophoneRecoverySnapshot(participant);

    expect(isLocalMicrophoneHealthy(snapshot)).toBe(true);
  });

  it("restarts a browser-muted microphone after unmute", async () => {
    let mediaTrackMuted = true;
    const restartTrack = vi.fn(async () => {
      mediaTrackMuted = false;
    });
    const participant: RecoverableMicrophoneParticipant = {
      isMicrophoneEnabled: true,
      getTrackPublication: () => ({
        isMuted: false,
        track: {
          kind: Track.Kind.Audio,
          mediaStreamTrack: {
            enabled: true,
            get muted() {
              return mediaTrackMuted;
            },
            readyState: "live",
          },
          restartTrack,
        },
      }),
      setMicrophoneEnabled: vi.fn(async () => undefined),
    };

    await expect(
      recoverLocalMicrophoneAfterUnmute(participant, { settleMs: 0 }),
    ).resolves.toBe("restarted");
    expect(restartTrack).toHaveBeenCalledTimes(1);
    expect(participant.setMicrophoneEnabled).not.toHaveBeenCalled();
  });

  it("falls back to a microphone disable-enable cycle when restart is unavailable", async () => {
    let readyState: MediaStreamTrackState = "ended";
    const participant = createParticipant({ trackReadyState: readyState });
    const setMicrophoneEnabled = vi.fn(async (enabled: boolean) => {
      participant.isMicrophoneEnabled = enabled;
      const publication = participant.getTrackPublication(Track.Source.Microphone);
      if (publication?.track) {
        readyState = enabled ? "live" : "ended";
        publication.track.mediaStreamTrack.enabled = enabled;
      }
    });
    participant.getTrackPublication = () => ({
      isMuted: false,
      track: {
        kind: Track.Kind.Audio,
        mediaStreamTrack: {
          enabled: participant.isMicrophoneEnabled,
          muted: false,
          get readyState() {
            return readyState;
          },
        },
      },
    });
    participant.setMicrophoneEnabled = setMicrophoneEnabled;

    await expect(
      recoverLocalMicrophoneAfterUnmute(participant, { settleMs: 0 }),
    ).resolves.toBe("reenabled");
    expect(setMicrophoneEnabled).toHaveBeenNthCalledWith(1, false);
    expect(setMicrophoneEnabled).toHaveBeenNthCalledWith(2, true);
  });

  it("falls back to a microphone disable-enable cycle when restart fails", async () => {
    let mediaTrackMuted = true;
    const restartTrack = vi.fn(async () => {
      throw new Error("restart failed");
    });
    const participant: RecoverableMicrophoneParticipant = {
      isMicrophoneEnabled: true,
      getTrackPublication: () => ({
        isMuted: false,
        track: {
          kind: Track.Kind.Audio,
          mediaStreamTrack: {
            enabled: participant.isMicrophoneEnabled,
            get muted() {
              return mediaTrackMuted;
            },
            readyState: "live",
          },
          restartTrack,
        },
      }),
      setMicrophoneEnabled: vi.fn(async (enabled: boolean) => {
        participant.isMicrophoneEnabled = enabled;
        mediaTrackMuted = !enabled;
      }),
    };

    await expect(
      recoverLocalMicrophoneAfterUnmute(participant, { settleMs: 0 }),
    ).resolves.toBe("reenabled");
    expect(restartTrack).toHaveBeenCalledTimes(1);
    expect(participant.setMicrophoneEnabled).toHaveBeenNthCalledWith(1, false);
    expect(participant.setMicrophoneEnabled).toHaveBeenNthCalledWith(2, true);
  });

  it("completes the disable/enable cycle even when the guard tracks live mic state", async () => {
    // Regression: the cycle disables the microphone itself, so a guard derived
    // from `isMicrophoneEnabled` used to cancel on that very action and leave
    // the user muted immediately after they pressed unmute — silently, since
    // "cancelled" is not an error and raises no toast.
    const participant = createStatefulParticipant();

    await expect(
      recoverLocalMicrophoneAfterUnmute(participant, {
        settleMs: 0,
        shouldContinue: () => participant.isMicrophoneEnabled,
      }),
    ).resolves.toBe("reenabled");
    expect(participant.isMicrophoneEnabled).toBe(true);
    expect(participant.setMicrophoneEnabled).toHaveBeenNthCalledWith(1, false);
    expect(participant.setMicrophoneEnabled).toHaveBeenNthCalledWith(2, true);
  });

  it("re-mutes when the user mutes while the disable/enable cycle is in flight", async () => {
    const participant = createStatefulParticipant();
    let userWantsMic = true;

    // The user hits mute in the window between recovery's disable and its
    // re-enable — the one moment the cycle cannot be interrupted.
    const setMicrophoneEnabled = participant.setMicrophoneEnabled;
    participant.setMicrophoneEnabled = async (enabled: boolean) => {
      if (enabled) userWantsMic = false;
      return setMicrophoneEnabled(enabled);
    };

    const result = await recoverLocalMicrophoneAfterUnmute(participant, {
      settleMs: 0,
      shouldContinue: () => userWantsMic,
    });

    expect(result).toBe("cancelled");
    expect(participant.isMicrophoneEnabled).toBe(false);
  });

  it("does not re-enable when a newer user action cancels recovery", async () => {
    const participant = createParticipant({ trackMuted: true });
    const shouldContinue = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    await expect(
      recoverLocalMicrophoneAfterUnmute(participant, { settleMs: 0, shouldContinue }),
    ).resolves.toBe("cancelled");
    expect(participant.setMicrophoneEnabled).not.toHaveBeenCalled();
  });
});
