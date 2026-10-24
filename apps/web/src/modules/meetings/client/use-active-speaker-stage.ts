import { useCallback, useEffect, useRef, useState } from "react";
import type { Participant } from "livekit-client";
import {
  DEFAULT_STAGE_PARAMS,
  initStageState,
  tickStage,
  type SpeakerSample,
  type StageParams,
  type StageState,
} from "./active-speaker-stage";
import { useCommittedRef } from "@orbmeet/ui/react";

/**
 * How often the stage engine samples audio levels.
 *
 * 100ms is comfortably finer than the shortest constant this feeds
 * (`emaTauMs: 350`), so switching behaviour is unchanged, and it is 6× less
 * work than sampling at display refresh.
 */
const STAGE_SAMPLE_INTERVAL_MS = 100;

export interface ActiveSpeakerStage {
  /** Identity to spotlight: the manual pin when set, else the engine's holder. */
  stageId: string | null;
  /** The effective pin (null if cleared or the pinned participant has left). */
  pinnedId: string | null;
  /** Pin an identity to the stage (overrides the engine), or null to clear. */
  setPinnedId: (identity: string | null) => void;
  /** Toggle the pin for an identity. */
  togglePin: (identity: string) => void;
}

/**
 * Drives {@link tickStage} on a fixed sampling interval, reading each
 * participant's server-reported `audioLevel` (no per-tile AudioContext). The
 * stage holder only changes when the engine's hysteresis allows it, so the
 * functional `setState` below bails out of re-rendering on almost every tick —
 * this stays off React's render path the same way the voice glow does.
 *
 * Deliberately a timer rather than `requestAnimationFrame`. This samples audio
 * to make a decision; it does not paint. Running it on the frame clock meant a
 * permanently registered frame callback — which allocated a fresh array and ran
 * a full hysteresis pass 60×/s, and, worse, kept the rendering pipeline from
 * ever going idle. Measured on an iPhone with the whiteboard open, this was
 * part of a sustained 66–94 frame callbacks per second while nobody was
 * touching the screen. `tickStage` integrates over `dt`, so the coarser cadence
 * changes the sampling rate without changing the behaviour it produces.
 */
export function useActiveSpeakerStage(
  participants: Participant[],
  params: StageParams = DEFAULT_STAGE_PARAMS,
): ActiveSpeakerStage {
  const [holderId, setHolderId] = useState<string | null>(null);
  const [pinnedId, setPinnedIdState] = useState<string | null>(null);

  const participantsRef = useCommittedRef(participants);
  const stateRef = useRef<StageState>(initStageState());

  useEffect(() => {
    let last = performance.now();

    const sample = () => {
      const now = performance.now();
      const dt = now - last;
      last = now;

      const samples: SpeakerSample[] = participantsRef.current.map((p) => ({
        identity: p.identity,
        audioLevel: p.isMicrophoneEnabled ? p.audioLevel : 0,
      }));
      const next = tickStage(stateRef.current, samples, now, dt, params);
      stateRef.current = next;
      setHolderId((prev) => (prev === next.holderId ? prev : next.holderId));
    };

    const id = window.setInterval(sample, STAGE_SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [params, participantsRef]);

  const setPinnedId = useCallback((identity: string | null) => {
    setPinnedIdState(identity);
  }, []);

  const togglePin = useCallback((identity: string) => {
    setPinnedIdState((prev) => (prev === identity ? null : identity));
  }, []);

  // A pin only applies while that participant is still in the room.
  const pinPresent =
    pinnedId != null && participants.some((p) => p.identity === pinnedId);
  const effectivePin = pinPresent ? pinnedId : null;

  return {
    stageId: effectivePin ?? holderId,
    pinnedId: effectivePin,
    setPinnedId,
    togglePin,
  };
}
