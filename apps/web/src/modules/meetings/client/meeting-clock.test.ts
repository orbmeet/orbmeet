import { describe, expect, it } from "vitest";
import { getMeetingElapsedSeconds, getServerClockOffsetMs } from "./meeting-clock";

describe("meeting clock", () => {
  it("computes elapsed meeting time from server time, corrected for client clock skew", () => {
    const meetingStartedAtMs = 1_780_000_000_000;
    const serverNowMs = 1_780_000_060_000;
    const clientReceivedAtMs = 1_780_000_030_000;
    const offset = getServerClockOffsetMs(serverNowMs, clientReceivedAtMs);

    expect(getMeetingElapsedSeconds({ meetingStartedAtMs }, offset, clientReceivedAtMs)).toBe(60);
    expect(getMeetingElapsedSeconds({ meetingStartedAtMs }, offset, clientReceivedAtMs + 5_000)).toBe(65);
  });

  it("fails closed to zero for non-finite clock metadata", () => {
    expect(getServerClockOffsetMs(Number.NaN, 1)).toBe(0);
    expect(getMeetingElapsedSeconds({ meetingStartedAtMs: Number.NaN }, 0, 1)).toBe(0);
  });

  it("never displays a negative elapsed time", () => {
    const meetingStartedAtMs = 1_780_000_060_000;
    const serverNowMs = 1_780_000_000_000;
    const offset = getServerClockOffsetMs(serverNowMs, serverNowMs);

    expect(getMeetingElapsedSeconds({ meetingStartedAtMs }, offset, serverNowMs)).toBe(0);
  });

  it("two participants who received different responses agree on elapsed time", () => {
    // The regression: a host joined at T+0 and a guest at T+150s read the same
    // stored `startedAt`, but each derived its own offset. As long as every
    // offset pairs its own server instant with the client instant that
    // received it, the readings converge.
    const meetingStartedAtMs = 1_780_000_000_000;

    const hostOffset = getServerClockOffsetMs(1_780_000_000_500, 1_780_000_000_000);
    const guestOffset = getServerClockOffsetMs(1_780_000_150_500, 1_780_000_150_000);

    const readAt = 1_780_000_462_000;
    expect(getMeetingElapsedSeconds({ meetingStartedAtMs }, hostOffset, readAt)).toBe(
      getMeetingElapsedSeconds({ meetingStartedAtMs }, guestOffset, readAt),
    );
  });

  it("does not fold the age of a response into the offset", () => {
    // The actual defect. `serverNowMs` came off a response built at T+0, but
    // the offset was recomputed on a later remount with a fresh `Date.now()`.
    // The difference — the age of the response — was then subtracted from
    // every reading, putting the host 2m28s behind the guest.
    const meetingStartedAtMs = 1_780_000_000_000;
    const serverNowMs = 1_780_000_000_000;
    const remountedAtMs = serverNowMs + 148_000;

    const correct = getServerClockOffsetMs(serverNowMs, serverNowMs);
    const stale = getServerClockOffsetMs(serverNowMs, remountedAtMs);

    const readAt = serverNowMs + 462_000;
    expect(getMeetingElapsedSeconds({ meetingStartedAtMs }, correct, readAt)).toBe(462);
    // Documents the failure mode the type signature now makes awkward to write.
    expect(getMeetingElapsedSeconds({ meetingStartedAtMs }, stale, readAt)).toBe(462 - 148);
  });
});
