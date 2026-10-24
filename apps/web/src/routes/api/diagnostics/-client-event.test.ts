import { describe, expect, it } from "vitest";
import {
  parseClientDiagnostic,
  PROBLEM_DIAGNOSTIC_EVENTS,
} from "@/modules/meetings/client/entry/diagnostic-contract";

describe("client diagnostic payload contract", () => {
  it("accepts the bounded navigator snapshot", () => {
    expect(parseClientDiagnostic({
      event: "device_probe_completed",
      browser: {
        userAgent: "Browser/1",
        platform: "MacIntel",
        maxTouchPoints: 0,
        effectiveType: "4g",
        downlink: 10,
        rtt: 20,
      },
    })).not.toBeNull();
  });

  it("rejects nested attacker-controlled fields and oversized values", () => {
    expect(parseClientDiagnostic({
      event: "forged",
      browser: { arbitrary: { nested: "value" } },
    })).toBeNull();
    expect(parseClientDiagnostic({
      event: "forged",
      browser: { userAgent: "x".repeat(513) },
    })).toBeNull();
  });

  it("carries the ids that join an event to the server's record, outside its detail", () => {
    const parsed = parseClientDiagnostic({
      event: "livekit_reconnecting",
      tabId: "tab-1",
      meetingId: "meeting_01",
      connectionId: "connection_01",
      reason: "network",
    });
    expect(parsed).toMatchObject({
      tabId: "tab-1",
      meetingId: "meeting_01",
      connectionId: "connection_01",
      detail: { reason: "network" },
    });
  });

  it("tells a participant's problem from the ordinary course of a meeting", () => {
    expect(PROBLEM_DIAGNOSTIC_EVENTS.has("livekit_error")).toBe(true);
    expect(PROBLEM_DIAGNOSTIC_EVENTS.has("admission_pending")).toBe(false);
  });
});
