import { describe, expect, it } from "vitest";
import { getPublisherJobTarget } from "./publisher-job.js";

describe("getPublisherJobTarget", () => {
  it("reads the meeting and participant from pre-connect job metadata", () => {
    expect(getPublisherJobTarget({
      room: { name: " meet-mtg_123 " },
      participant: { identity: " participant_123 " },
    })).toEqual({
      meetingId: "mtg_123",
      roomName: "meet-mtg_123",
      participantIdentity: "participant_123",
    });
  });

  it.each([
    { room: undefined, participant: { identity: "participant_123" } },
    { room: { name: "room-mtg_123" }, participant: { identity: "participant_123" } },
    { room: { name: "meet-" }, participant: { identity: "participant_123" } },
    { room: { name: "meet-mtg_123" }, participant: undefined },
    { room: { name: "meet-mtg_123" }, participant: { identity: " " } },
  ])("rejects malformed publisher jobs", (job) => {
    expect(getPublisherJobTarget(job)).toBeNull();
  });
});
