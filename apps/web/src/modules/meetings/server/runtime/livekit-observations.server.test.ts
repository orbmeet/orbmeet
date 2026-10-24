import { describe, expect, it } from "vitest";
import { EgressInfo, EgressStatus, type WebhookEvent } from "livekit-server-sdk";
import { observationFor } from "./livekit-observations.server";

const room = { name: "meet-meeting_1", sid: "RM_1" };

function event(fields: Record<string, unknown>): WebhookEvent {
  return { createdAt: 1_800_000_000n, ...fields } as unknown as WebhookEvent;
}

describe("observationFor", () => {
  it("forwards app participants' arrivals and departures", () => {
    const joined = observationFor(event({
      event: "participant_joined",
      room,
      participant: { identity: "ada_connection_1", sid: "PA_1", kind: 0, joinedAtMs: 1_799_999_999_500n },
    }));
    expect(joined).toEqual({
      meetingId: "meeting_1",
      observation: {
        kind: "participantJoined",
        identity: "ada_connection_1",
        sid: "PA_1",
        // The session's own join time, which orders it against reconnects.
        joinedAt: 1_799_999_999_500,
        at: 1_800_000_000_000,
      },
    });
    expect(observationFor(event({
      event: "participant_connection_aborted",
      room,
      participant: { identity: "ada_connection_1", sid: "PA_1", kind: 0 },
    }))?.observation.kind).toBe("participantLeft");
  });

  it("falls back to the session's join time in seconds, then to the join event's own time", () => {
    const at = (participant: Record<string, unknown>, fields: Record<string, unknown> = {}) => {
      const observed = observationFor(event({ event: "participant_joined", room, participant, ...fields }));
      return observed?.observation.kind === "participantJoined" ? observed.observation.joinedAt : undefined;
    };
    const participant = { identity: "ada_connection_1", sid: "PA_1", kind: 0 };
    expect(at({ ...participant, joinedAt: 1_799_999_999n })).toBe(1_799_999_999_000);
    expect(at(participant)).toBe(1_800_000_000_000);
    // Never this Worker's clock, which nothing on LiveKit's is compared with.
    expect(at(participant, { createdAt: undefined })).toBeNull();
  });

  it("leaves agents and recorders alone", () => {
    expect(observationFor(event({
      event: "participant_joined",
      room,
      participant: { identity: "agent", sid: "PA_2", kind: 4 },
    }))).toBeNull();
  });

  it("ignores rooms that are not meetings", () => {
    expect(observationFor(event({ event: "room_started", room: { name: "other", sid: "RM_2" } }))).toBeNull();
  });

  it("reports an egress's state", () => {
    const ended = observationFor(event({
      event: "egress_ended",
      egressInfo: new EgressInfo({ egressId: "EG_1", roomName: room.name, status: EgressStatus.EGRESS_COMPLETE }),
    }));
    expect(ended?.observation).toEqual({
      kind: "egressObserved",
      complete: false,
      egresses: [{ egressId: "EG_1", status: "complete", streamActive: false, streamFailure: null, error: null }],
    });
  });
});
