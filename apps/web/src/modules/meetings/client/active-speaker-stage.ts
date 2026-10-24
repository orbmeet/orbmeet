/**
 * Active-speaker stage engine — a pure, time-driven reducer that decides who
 * holds the spotlight in a meeting.
 *
 * The design goal is *stability*, not responsiveness: the stage should follow
 * the conversation, not every sound. We never switch away from the current
 * holder on silence — we only switch *to* a challenger who has clearly and
 * durably taken over the floor. Four layered gates keep it calm:
 *
 *   1. Smoothing  — per-speaker score is an EMA of audio level, so brief
 *                   blips ("mhm", "yeah") never build enough score to matter.
 *   2. Margin     — a challenger must out-score the holder by `challengerMargin`,
 *                   so two similar-volume speakers don't ping-pong.
 *   3. Sustain    — the challenger must stay ahead for `challengerSustainMs`
 *                   continuously, so a single loud burst can't grab the stage.
 *   4. Min-hold + cooldown — the holder keeps the stage for at least
 *                   `minHoldMs`, and no second switch is allowed within
 *                   `cooldownMs` of the last one.
 *
 * Kept free of React and LiveKit so the hysteresis can be unit-tested directly;
 * {@link useActiveSpeakerStage} drives it from a single animation frame.
 */

export interface SpeakerSample {
  identity: string;
  /** Instantaneous audio level in 0..1. Pass 0 when the mic is muted. */
  audioLevel: number;
}

export interface StageParams {
  /** EMA time constant (ms). Larger = smoother, slower to react. */
  emaTauMs: number;
  /** Challenger must exceed the holder's score by this fraction to qualify. */
  challengerMargin: number;
  /** Challenger must stay ahead this long (ms) before it can take the stage. */
  challengerSustainMs: number;
  /** A fresh holder keeps the stage at least this long (ms). */
  minHoldMs: number;
  /** No further switch is permitted within this window (ms) of the last one. */
  cooldownMs: number;
  /** Minimum smoothed score to be considered "speaking" at all. */
  activityFloor: number;
}

/**
 * Biased toward calm. Every value is a tuning knob; these defaults make the
 * stage settle on whoever holds the floor and stay there through pauses,
 * moving only when someone genuinely takes over.
 */
export const DEFAULT_STAGE_PARAMS: StageParams = {
  emaTauMs: 350,
  challengerMargin: 0.22,
  challengerSustainMs: 1800,
  minHoldMs: 6000,
  cooldownMs: 4000,
  activityFloor: 0.05,
};

export interface StageState {
  /** Smoothed score per identity (EMA of audio level). */
  scores: Record<string, number>;
  /** Identity currently on the stage, or null before anyone has spoken. */
  holderId: string | null;
  /** Timestamp (ms) the current holder took the stage. */
  holderSince: number;
  /** Timestamp (ms) of the most recent stage switch. */
  lastSwitchAt: number;
  /** Identity currently building a sustained challenge, if any. */
  challengerId: string | null;
  /** Timestamp (ms) the current challenge began. */
  challengerSince: number;
}

export function initStageState(): StageState {
  return {
    scores: {},
    holderId: null,
    holderSince: 0,
    lastSwitchAt: 0,
    challengerId: null,
    challengerSince: 0,
  };
}

/** Speaking set with a small hysteresis band so the glow doesn't flicker. */
export function speakingSet(state: StageState, params: StageParams): Set<string> {
  const onThreshold = params.activityFloor;
  const set = new Set<string>();
  for (const [identity, score] of Object.entries(state.scores)) {
    if (score >= onThreshold) set.add(identity);
  }
  return set;
}

function argmaxScore(
  scores: Record<string, number>,
  exclude: string | null,
): { identity: string; score: number } | null {
  let best: { identity: string; score: number } | null = null;
  for (const [identity, score] of Object.entries(scores)) {
    if (identity === exclude) continue;
    if (!best || score > best.score) best = { identity, score };
  }
  return best;
}

/**
 * Advance the engine by one tick. Pure: returns a new state, never mutates.
 *
 * @param samples Present participants this frame. Identities absent here are
 *                treated as having left — their scores decay and a holder who
 *                leaves is replaced immediately (the min-hold floor only
 *                protects holders who are still in the room).
 * @param now     Monotonic timestamp (ms).
 * @param dtMs    Elapsed time since the previous tick (ms).
 */
export function tickStage(
  prev: StageState,
  samples: SpeakerSample[],
  now: number,
  dtMs: number,
  params: StageParams = DEFAULT_STAGE_PARAMS,
): StageState {
  const present = new Set(samples.map((s) => s.identity));

  // 1. Update smoothed scores. exp decay keeps the EMA frame-rate independent.
  const alpha = dtMs <= 0 ? 1 : 1 - Math.exp(-dtMs / params.emaTauMs);
  const scores: Record<string, number> = {};
  for (const sample of samples) {
    const previous = prev.scores[sample.identity] ?? 0;
    const target = Math.max(0, Math.min(1, sample.audioLevel));
    scores[sample.identity] = previous + (target - previous) * alpha;
  }
  // Participants who left simply drop out of the score map.

  let holderId = prev.holderId;
  let holderSince = prev.holderSince;
  let lastSwitchAt = prev.lastSwitchAt;
  let challengerId = prev.challengerId;
  let challengerSince = prev.challengerSince;

  const holderPresent = holderId != null && present.has(holderId);

  // 2. Holder is gone (left the room, or never set): take the loudest speaker
  //    immediately. Nothing to keep stable here.
  if (!holderPresent) {
    const top = argmaxScore(scores, null);
    if (top && top.score >= params.activityFloor) {
      holderId = top.identity;
      holderSince = now;
      lastSwitchAt = now;
    } else if (holderId != null && !present.has(holderId)) {
      // Holder left and nobody is speaking — fall back to anyone present so the
      // stage is never empty while people remain.
      const anyone = argmaxScore(scores, null);
      holderId = anyone ? anyone.identity : null;
      holderSince = now;
      lastSwitchAt = now;
    }
    return { scores, holderId, holderSince, lastSwitchAt, challengerId: null, challengerSince: 0 };
  }

  // 3. Holder is present. Only a sustained, clearly-louder challenger can win.
  const holderScore = scores[holderId!] ?? 0;
  const top = argmaxScore(scores, holderId);
  const qualifies =
    top != null &&
    top.score >= params.activityFloor &&
    top.score >= holderScore * (1 + params.challengerMargin);

  if (!qualifies) {
    // No qualifying challenger — holder keeps the stage (including on silence).
    return { scores, holderId, holderSince, lastSwitchAt, challengerId: null, challengerSince: 0 };
  }

  // Track how long this exact challenger has stayed ahead.
  if (challengerId !== top.identity) {
    challengerId = top.identity;
    challengerSince = now;
  }

  const heldLongEnough = now - holderSince >= params.minHoldMs;
  const pastCooldown = now - lastSwitchAt >= params.cooldownMs;
  const sustained = now - challengerSince >= params.challengerSustainMs;

  if (heldLongEnough && pastCooldown && sustained) {
    return {
      scores,
      holderId: challengerId,
      holderSince: now,
      lastSwitchAt: now,
      challengerId: null,
      challengerSince: 0,
    };
  }

  return { scores, holderId, holderSince, lastSwitchAt, challengerId, challengerSince };
}
