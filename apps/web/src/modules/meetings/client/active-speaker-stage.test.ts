import { describe, expect, it } from "vitest";

import {
  DEFAULT_STAGE_PARAMS,
  initStageState,
  speakingSet,
  tickStage,
  type SpeakerSample,
  type StageParams,
  type StageState,
} from "./active-speaker-stage";

const P: StageParams = DEFAULT_STAGE_PARAMS;

/** Run the engine for `durationMs` with a fixed set of samples, 50ms steps. */
function run(
  state: StageState,
  samples: SpeakerSample[],
  durationMs: number,
  startAt: number,
  params: StageParams = P,
): { state: StageState; now: number } {
  const step = 50;
  let now = startAt;
  let s = state;
  for (let t = 0; t < durationMs; t += step) {
    now += step;
    s = tickStage(s, samples, now, step, params);
  }
  return { state: s, now };
}

const loud = (identity: string): SpeakerSample => ({ identity, audioLevel: 0.8 });
const silent = (identity: string): SpeakerSample => ({ identity, audioLevel: 0 });

describe("tickStage", () => {
  it("promotes the first speaker once they cross the activity floor", () => {
    const { state } = run(initStageState(), [loud("a"), silent("b")], 1000, 0);
    expect(state.holderId).toBe("a");
  });

  it("holds the stage through silence — never switches away on quiet alone", () => {
    let { state, now } = run(initStageState(), [loud("a"), silent("b")], 2000, 0);
    expect(state.holderId).toBe("a");
    // Everyone goes silent for a long stretch.
    ({ state, now } = run(state, [silent("a"), silent("b")], 10000, now));
    expect(state.holderId).toBe("a");
  });

  it("ignores a brief interjection (sustain gate)", () => {
    // a holds the stage well past min-hold.
    let { state, now } = run(initStageState(), [loud("a"), silent("b")], 8000, 0);
    expect(state.holderId).toBe("a");
    // b bursts in for less than challengerSustainMs while a goes quiet.
    ({ state, now } = run(state, [silent("a"), loud("b")], 1000, now));
    expect(state.holderId).toBe("a");
  });

  it("switches to a sustained, clearly-louder challenger", () => {
    let { state, now } = run(initStageState(), [loud("a"), silent("b")], 8000, 0);
    expect(state.holderId).toBe("a");
    // b takes over durably (well beyond sustain), a falls quiet.
    ({ state, now } = run(state, [silent("a"), loud("b")], 4000, now));
    expect(state.holderId).toBe("b");
  });

  it("respects the min-hold floor: no switch before minHoldMs even if challenger dominates", () => {
    // a becomes holder immediately on the first qualifying tick.
    let s = tickStage(initStageState(), [loud("a"), silent("b")], 50, 50, P);
    expect(s.holderId).toBe("a");
    // Immediately b dominates and a is silent, but we are inside min-hold.
    const { state } = run(s, [silent("a"), loud("b")], P.minHoldMs - 500, 50);
    expect(state.holderId).toBe("a");
  });

  it("enforces cooldown: a second switch cannot happen right after the first", () => {
    // a holds, then b wins after min-hold.
    let { state, now } = run(initStageState(), [loud("a"), silent("b")], 8000, 0);
    ({ state, now } = run(state, [silent("a"), loud("b")], 4000, now));
    expect(state.holderId).toBe("b");
    const switchedAt = now;
    // c immediately dominates, but we just switched — cooldown blocks it.
    ({ state, now } = run(state, [silent("a"), silent("b"), loud("c")], 2000, now));
    expect(state.holderId).toBe("b");
    expect(now - switchedAt).toBeLessThan(P.minHoldMs + P.cooldownMs);
  });

  it("does not ping-pong between two similar-volume speakers", () => {
    let { state, now } = run(initStageState(), [loud("a"), silent("b")], 8000, 0);
    // Both at the same level for a long time: margin gate keeps a on stage.
    let switches = 0;
    let last = state.holderId;
    const step = 50;
    for (let t = 0; t < 20000; t += step) {
      now += step;
      state = tickStage(
        state,
        [{ identity: "a", audioLevel: 0.6 }, { identity: "b", audioLevel: 0.6 }],
        now,
        step,
        P,
      );
      if (state.holderId !== last) {
        switches += 1;
        last = state.holderId;
      }
    }
    expect(switches).toBe(0);
    expect(state.holderId).toBe("a");
  });

  it("replaces a holder who leaves the room immediately (no min-hold)", () => {
    let { state, now } = run(initStageState(), [loud("a"), silent("b")], 1000, 0);
    expect(state.holderId).toBe("a");
    // a leaves; b is the only one present and is speaking.
    state = tickStage(state, [loud("b")], now + 50, 50, P);
    expect(state.holderId).toBe("b");
  });

  it("falls back to a present participant when the holder leaves during silence", () => {
    let { state, now } = run(initStageState(), [loud("a"), silent("b")], 1000, 0);
    state = tickStage(state, [silent("b")], now + 50, 50, P);
    expect(state.holderId).toBe("b");
  });

  it("speakingSet reflects who is above the activity floor", () => {
    const { state } = run(initStageState(), [loud("a"), silent("b")], 1000, 0);
    const set = speakingSet(state, P);
    expect(set.has("a")).toBe(true);
    expect(set.has("b")).toBe(false);
  });
});
