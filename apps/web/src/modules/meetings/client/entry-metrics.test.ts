// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const logInfo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({ logInfo }));

import {
  beginMeetingEntryFlow,
  markMeetingEntryMetric,
  markMeetingWhiteboardRequested,
} from "./entry-metrics";

// Real wall-clock base: `markMeetingEntryMetric` keeps the first value with a
// `!state[metric]` guard, and a timestamp of 0 reads as unset.
const T0 = 1_789_000_000_000;

function lastWhiteboardStage() {
  const calls = logInfo.mock.calls.filter(
    ([, payload]) => (payload as { stage?: string })?.stage === "whiteboard",
  );
  return calls.at(-1)?.[1] as Record<string, unknown> | undefined;
}

describe("meeting entry metrics", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    logInfo.mockClear();
  });

  it("measures the whiteboard from the request, not from the meeting join", () => {
    // The bug this exists to prevent: both whiteboard metrics were anchored to
    // `joinRequestedAt`, so they also counted however long someone sat in the
    // room before asking for a board. A real session logged 167,169ms for an
    // open that took about 25 seconds.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0);
      beginMeetingEntryFlow({ source: "test" });
      markMeetingEntryMetric("joinRequestedAt");
      vi.setSystemTime(T0 + 1_000);
      markMeetingEntryMetric("liveKitConnectedAt");

      // Two minutes of doing other things in the room.
      vi.setSystemTime(T0 + 121_000);
      markMeetingWhiteboardRequested();
      vi.setSystemTime(T0 + 146_000);
      markMeetingEntryMetric("whiteboardReadyAt");

      const stage = lastWhiteboardStage();
      expect(stage?.whiteboard_open_ms).toBe(25_000);
      expect(stage?.join_click_to_whiteboard_ms).toBe(146_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times a second open on its own, not from the first request", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0);
      beginMeetingEntryFlow({ source: "test" });
      markMeetingWhiteboardRequested();
      vi.setSystemTime(T0 + 5_000);
      markMeetingEntryMetric("whiteboardReadyAt");
      expect(lastWhiteboardStage()?.whiteboard_open_ms).toBe(5_000);

      // Closed, then reopened much later. Every other mark in this module keeps
      // its first value; this one has to re-arm or the second open would be
      // measured from the first request.
      vi.setSystemTime(T0 + 300_000);
      markMeetingWhiteboardRequested();
      vi.setSystemTime(T0 + 302_000);
      markMeetingEntryMetric("whiteboardReadyAt");
      expect(lastWhiteboardStage()?.whiteboard_open_ms).toBe(2_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the first value for one-shot entry marks", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0);
      beginMeetingEntryFlow({ source: "test" });
      markMeetingEntryMetric("joinRequestedAt");
      vi.setSystemTime(T0 + 9_000);
      markMeetingEntryMetric("joinRequestedAt");
      vi.setSystemTime(T0 + 10_000);
      markMeetingEntryMetric("liveKitConnectedAt");

      const livekit = logInfo.mock.calls
        .filter(([, p]) => (p as { stage?: string })?.stage === "livekit")
        .at(-1)?.[1] as Record<string, unknown>;
      expect(livekit.join_click_to_livekit_ms).toBe(10_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
