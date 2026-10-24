import { describe, expect, it } from "vitest";
import { AudioTimeline } from "./audio-timeline.js";

const at = (timeline: AudioTimeline, offset: number) => timeline.at(offset)?.capturedAt ?? null;

describe("AudioTimeline", () => {
  it("maps offsets through dropped-audio gaps using the chunk actually sent", () => {
    const timeline = new AudioTimeline();
    timeline.record({ capturedAt: 1_000, durationMs: 20, trackSid: "TR_a" });
    timeline.record({ capturedAt: 2_000, durationMs: 20, trackSid: "TR_a" });

    expect(at(timeline, 10)).toBe(1_010);
    expect(at(timeline, 20)).toBe(2_000);
    expect(at(timeline, 35)).toBe(2_015);
  });

  it("extrapolates offsets older than retained timeline history", () => {
    const timeline = new AudioTimeline();
    for (let index = 0; index < 7_000; index += 1) {
      timeline.record({ capturedAt: index * 20, durationMs: 20, trackSid: "TR_a" });
    }
    expect(at(timeline, 0)).toBe(0);
    expect(at(timeline, 139_990)).toBe(139_990);
  });

  it("preserves a pruned capture gap with compact timeline anchors", () => {
    const timeline = new AudioTimeline();
    for (let index = 0; index < 7_000; index += 1) {
      timeline.record({ capturedAt: index * 20 + (index >= 100 ? 10_000 : 0), durationMs: 20, trackSid: "TR_a" });
    }
    // Offsets older than the bounded anchor window are not extrapolated across a pause.
    expect(at(timeline, 1_000)).toBeNull();
    expect(at(timeline, 3_000)).toBe(13_000);
  });

  it("says which track the audio at an offset came from", () => {
    const timeline = new AudioTimeline();
    timeline.record({ capturedAt: 1_000, durationMs: 20, trackSid: "TR_old" });
    timeline.record({ capturedAt: 1_020, durationMs: 20, trackSid: "TR_new" });
    expect(timeline.at(5)?.trackSid).toBe("TR_old");
    expect(timeline.at(25)?.trackSid).toBe("TR_new");
  });

  it("knows nothing before any audio was sent", () => {
    expect(new AudioTimeline().at(0)).toBeNull();
  });
});
