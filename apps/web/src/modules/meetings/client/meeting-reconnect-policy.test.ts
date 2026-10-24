import { describe, expect, it, vi } from "vitest";
import {
  MAX_MEETING_RECONNECT_ELAPSED_MS,
  MeetingReconnectPolicy,
} from "./meeting-reconnect-policy";

describe("MeetingReconnectPolicy", () => {
  it("retries immediately for the first two recovery attempts", () => {
    const policy = new MeetingReconnectPolicy();
    expect(policy.nextRetryDelayInMs({ retryCount: 0, elapsedMs: 0 })).toBe(0);
    expect(policy.nextRetryDelayInMs({ retryCount: 1, elapsedMs: 100 })).toBe(0);
  });

  it("backs off with a four second ceiling", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const policy = new MeetingReconnectPolicy();
    expect(policy.nextRetryDelayInMs({ retryCount: 2, elapsedMs: 1_000 })).toBe(500);
    expect(policy.nextRetryDelayInMs({ retryCount: 20, elapsedMs: 15_000 })).toBe(4_000);
    vi.restoreAllMocks();
  });

  it("hands control back to the application before room departure grace expires", () => {
    const policy = new MeetingReconnectPolicy();
    expect(
      policy.nextRetryDelayInMs({
        retryCount: 20,
        elapsedMs: MAX_MEETING_RECONNECT_ELAPSED_MS,
      }),
    ).toBeNull();
  });
});
