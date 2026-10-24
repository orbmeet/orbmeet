import { describe, expect, it } from "vitest";
import { endedOccurrenceJoinError } from "./join-results";

describe("endedOccurrenceJoinError", () => {
  const fresh = { startedNow: false, reusableLink: true, resuming: false };

  it("asks a fresh entry through a reusable link to retry while the last meeting closes", () => {
    expect(endedOccurrenceJoinError(fresh).code).toBe("CONFLICT");
  });

  it("reports the end to anyone who belonged to the meeting that ended", () => {
    expect(endedOccurrenceJoinError({ ...fresh, resuming: true }).code).toBe("MEETING_ENDED");
    expect(endedOccurrenceJoinError({ ...fresh, reusableLink: false }).code).toBe("MEETING_ENDED");
    expect(endedOccurrenceJoinError({ ...fresh, startedNow: true }).code).toBe("MEETING_ENDED");
  });
});
