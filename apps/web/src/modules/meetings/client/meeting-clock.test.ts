import { describe, expect, it } from "vitest";
import { getMeetingElapsedSeconds, meetingClockFrom, toLocalTime } from "./meeting-clock";

const START = 1_780_000_000_000;

describe("meeting clock", () => {
  it("reads elapsed meeting time through the offset taken when the response arrived", () => {
    // The server said T+60s; this browser's clock read T+30s when that arrived.
    const clock = meetingClockFrom({ meetingStartedAtMs: START, serverNowMs: START + 60_000 }, START + 30_000);

    expect(getMeetingElapsedSeconds(clock, START + 30_000)).toBe(60);
    expect(getMeetingElapsedSeconds(clock, START + 35_000)).toBe(65);
  });

  it("puts a server instant on this browser's clock", () => {
    const clock = meetingClockFrom({ meetingStartedAtMs: START, serverNowMs: START + 60_000 }, START + 30_000);
    expect(toLocalTime(clock, START + 90_000)).toBe(START + 60_000);
  });

  it("two participants who joined at different times agree on elapsed time", () => {
    const host = meetingClockFrom({ meetingStartedAtMs: START, serverNowMs: START + 500 }, START);
    const guest = meetingClockFrom({ meetingStartedAtMs: START, serverNowMs: START + 150_500 }, START + 150_000);

    const readAt = START + 462_000;
    expect(getMeetingElapsedSeconds(host, readAt)).toBe(getMeetingElapsedSeconds(guest, readAt));
  });

  it("never displays a negative elapsed time, and fails closed on bad metadata", () => {
    const early = meetingClockFrom({ meetingStartedAtMs: START + 60_000, serverNowMs: START }, START);
    expect(getMeetingElapsedSeconds(early, START)).toBe(0);

    const broken = meetingClockFrom({ meetingStartedAtMs: Number.NaN, serverNowMs: Number.NaN }, START);
    expect(broken.serverClockOffsetMs).toBe(0);
    expect(getMeetingElapsedSeconds(broken, START)).toBe(0);
  });
});
