import { describe, expect, it } from "vitest";
import {
  WHITEBOARD_PIN_GIVE_UP_MS,
  WHITEBOARD_PIN_START_WINDOW_MS,
  grantFor,
  roomMetadataFor,
  type SurfaceFocus,
} from "./model";
import { PARTICIPANT_ATTRIBUTE } from "@/modules/meetings/contract/live-state";
import { readyToDrain } from "./plan";
import { step } from "./step";
import { T0, snapshot, host, ada, Meeting, kinds } from "./step-test-support";

describe("whiteboard surface", () => {
  const boardA: SurfaceFocus = { usageId: "usage_a", whiteboardId: "wb_a", syncRoomId: "room_a" };
  const boardB: SurfaceFocus = { usageId: "usage_b", whiteboardId: "wb_b", syncRoomId: "room_b" };

  function openMeeting() {
    const m = new Meeting();
    const h = m.admitted(host);
    m.joined(h.identity);
    return m;
  }

  function pins(m: Meeting) {
    return m.plan().filter((effect) => effect.kind === "whiteboard.pin");
  }

  it("opens on the board it already presents, or on the Worker's fallback, in one versioned record", () => {
    const m = openMeeting();
    const opened = m.apply({ kind: "setSurface", subject: host, open: true, fallback: boardA });
    expect(opened.reply).toEqual({
      kind: "surface",
      surface: { open: true, whiteboardId: "wb_a", revision: 1, openRevision: 1 },
    });
    // Everyone learns it from room metadata, which the room keeps applying.
    expect(roomMetadataFor(m.state).surface).toEqual({ open: true, whiteboardId: "wb_a", revision: 1, openRevision: 1 });
    expect(kinds(m.plan())).toContain("livekit.roomMetadata");

    m.apply({ kind: "setSurface", subject: host, open: false, fallback: null });
    // Reopening restores the presented board, whatever fallback is offered.
    m.apply({ kind: "setSurface", subject: host, open: true, fallback: boardB });
    expect(m.state.surface.focus).toEqual(boardA);
    expect(m.state.surface.openRevision).toBe(3);
  });

  describe("an attendee asking for the board", () => {
    function withAttendee() {
      const m = openMeeting();
      const a = m.admitted(ada);
      m.joined(a.identity);
      return { m, a };
    }
    const board = (m: Meeting, admissionId: string) =>
      grantFor(m.state, m.state.admissions[admissionId]).attributes[PARTICIPANT_ATTRIBUTE.board];

    it("shows the ask to every moderator, kept on the participant like a raised hand", () => {
      const { m, a } = withAttendee();
      m.apply({ kind: "requestBoard", subject: ada, attemptId: a.attemptId, requested: true });
      expect(board(m, a.admissionId)).toBe("requested");
      expect(kinds(m.plan())).toContain("livekit.grant");

      m.apply({ kind: "requestBoard", subject: ada, attemptId: a.attemptId, requested: false });
      expect(board(m, a.admissionId)).toBe("");
    });

    it("is answered for everyone when a moderator opens the board", () => {
      const { m, a } = withAttendee();
      m.apply({ kind: "requestBoard", subject: ada, attemptId: a.attemptId, requested: true });
      m.apply({ kind: "setSurface", subject: host, open: true, fallback: boardA });
      expect(m.state.admissions[a.admissionId].boardRequested).toBe(false);
      // Asking for an open board asks for nothing.
      m.apply({ kind: "requestBoard", subject: ada, attemptId: a.attemptId, requested: true });
      expect(m.state.admissions[a.admissionId].boardRequested).toBe(false);
    });

    it("is declined by a moderator only", () => {
      const { m, a } = withAttendee();
      m.apply({ kind: "requestBoard", subject: ada, attemptId: a.attemptId, requested: true });
      expect(m.refuse({ kind: "declineBoardRequest", subject: ada, admissionId: a.admissionId }).code).toBe("FORBIDDEN");
      m.apply({ kind: "declineBoardRequest", subject: host, admissionId: a.admissionId });
      expect(board(m, a.admissionId)).toBe("");
    });

    it("is never carried by someone who can open the board themselves", () => {
      const m = openMeeting();
      const h = m.state.admissions[Object.keys(m.state.admissions)[0]];
      const attempt = Object.values(m.state.attempts).find((candidate) => candidate.admissionId === h.id)!;
      m.apply({ kind: "requestBoard", subject: host, attemptId: attempt.id, requested: true });
      expect(h.boardRequested).toBe(false);
    });
  });

  it("refuses attendees, and opening with nothing to show", () => {
    const m = openMeeting();
    const a = m.admitted(ada);
    m.joined(a.identity);
    expect(m.refuse({ kind: "setSurface", subject: ada, open: true, fallback: boardA }).code).toBe("FORBIDDEN");
    expect(m.refuse({ kind: "setSurface", subject: host, open: true, fallback: null }).code).toBe("VALIDATION_ERROR");
  });

  it("pins what a board shared when the surface closes, without waiting for the sync server", () => {
    const m = openMeeting();
    m.apply({ kind: "setSurface", subject: host, open: true, fallback: boardA });
    const closed = m.apply({ kind: "setSurface", subject: host, open: false, fallback: null });
    // The close is committed now; the pin is an effect that follows it.
    expect(closed.reply).toMatchObject({ kind: "surface", surface: { open: false } });
    const [pin] = pins(m);
    expect(pin).toMatchObject({ kind: "whiteboard.pin", pin: { usageId: "usage_a", whiteboardId: "wb_a" } });
    // The sync server may only start it close to the boundary it stands for.
    if (pin.kind !== "whiteboard.pin") throw new Error("expected a pin");
    expect(pin.pin.startBefore).toBe(m.state.surface.pins.usage_a.owedAt + WHITEBOARD_PIN_START_WINDOW_MS);

    // A failed pin stays owed and is retried.
    m.apply({ kind: "effectFailed", key: `whiteboard.pin:usage_a`, error: "sync server down" });
    expect(m.state.surface.pins.usage_a).toBeDefined();
    m.advance(60_000);
    expect(pins(m)).toHaveLength(1);

    if (pin.kind !== "whiteboard.pin") throw new Error("expected a pin");
    m.apply({ kind: "whiteboardPinned", usageId: "usage_a", commandId: pin.pin.commandId });
    expect(pins(m)).toHaveLength(0);
  });

  it("pins the board it leaves on a switch, and keeps a participant's hide across it", () => {
    const m = openMeeting();
    m.apply({ kind: "setSurface", subject: host, open: true, fallback: boardA });
    m.apply({ kind: "present", subject: host, focus: boardB });
    expect(m.state.surface).toMatchObject({ open: true, focus: boardB, revision: 2, openRevision: 1 });
    expect(pins(m)).toEqual([expect.objectContaining({ pin: expect.objectContaining({ usageId: "usage_a" }) })]);
  });

  it("presenting onto a closed surface opens it for everyone and owes no pin for a board already pinned", () => {
    const m = openMeeting();
    m.apply({ kind: "setSurface", subject: host, open: true, fallback: boardA });
    m.apply({ kind: "setSurface", subject: host, open: false, fallback: null });
    const owedAtClose = m.state.surface.pins.usage_a;
    m.apply({ kind: "present", subject: host, focus: boardB });
    expect(m.state.surface).toMatchObject({ open: true, focus: boardB, revision: 3, openRevision: 3 });
    // Still only the close's pin: edits to a closed board are not the meeting's.
    expect(m.state.surface.pins).toEqual({ usage_a: owedAtClose });
  });

  it("a newer boundary of the same board replaces an older pin that lands late", () => {
    const m = openMeeting();
    m.apply({ kind: "setSurface", subject: host, open: true, fallback: boardA });
    m.apply({ kind: "setSurface", subject: host, open: false, fallback: null });
    const first = m.state.surface.pins.usage_a.commandId;
    m.apply({ kind: "setSurface", subject: host, open: true, fallback: null });
    m.apply({ kind: "setSurface", subject: host, open: false, fallback: null });
    const second = m.state.surface.pins.usage_a.commandId;
    expect(second).not.toBe(first);
    m.apply({ kind: "whiteboardPinned", usageId: "usage_a", commandId: first });
    expect(m.state.surface.pins.usage_a.commandId).toBe(second);
  });

  it("gives a pin up after a day of failures", () => {
    const m = openMeeting();
    m.apply({ kind: "setSurface", subject: host, open: true, fallback: boardA });
    m.apply({ kind: "setSurface", subject: host, open: false, fallback: null });
    m.now += WHITEBOARD_PIN_GIVE_UP_MS;
    m.apply({ kind: "effectFailed", key: "whiteboard.pin:usage_a", error: "sync server down" });
    expect(m.state.surface.pins).toEqual({});
  });

  it("ends without waiting for the whiteboard, and starts the capture once its pins landed", () => {
    const m = openMeeting();
    m.apply({ kind: "setSurface", subject: host, open: true, fallback: boardA });
    m.apply({ kind: "end", subject: host, reason: "host" });
    // The end owes the shown board a pin, and finalization does not wait for it.
    expect(kinds(m.plan())).toEqual(expect.arrayContaining(["meeting.finalize", "whiteboard.pin"]));

    m.apply({ kind: "finalized" });
    m.apply({ kind: "postTasksDone" });
    expect(kinds(m.plan())).not.toContain("whiteboard.capture");
    const pin = m.state.surface.pins.usage_a;
    m.apply({ kind: "whiteboardPinned", usageId: "usage_a", commandId: pin.commandId });
    expect(kinds(m.plan())).toContain("whiteboard.capture");

    m.apply({ kind: "roomDeleted", placement: m.here() });
    expect(readyToDrain(m.state)).toBe(false);
    m.apply({ kind: "whiteboardCaptureStarted" });
    expect(readyToDrain(m.state)).toBe(true);
  });

  it("does not pin a surface that was already closed when the meeting ended", () => {
    const m = openMeeting();
    m.apply({ kind: "setSurface", subject: host, open: true, fallback: boardA });
    m.apply({ kind: "setSurface", subject: host, open: false, fallback: null });
    const pin = m.state.surface.pins.usage_a;
    m.apply({ kind: "whiteboardPinned", usageId: "usage_a", commandId: pin.commandId });
    m.apply({ kind: "end", subject: host, reason: "host" });
    expect(m.state.surface.pins).toEqual({});
  });

  it("tells the presented board's room when anyone's authority changes, whatever changed it", () => {
    const m = openMeeting();
    const a = m.admitted(ada);
    m.joined(a.identity);
    m.apply({ kind: "setSurface", subject: host, open: true, fallback: boardA });
    expect(m.plan().filter((effect) => effect.kind === "whiteboard.authority")).toEqual([]);

    m.apply({ kind: "setModerator", subject: host, identity: a.identity, moderator: true });
    const [promoted] = m.plan().filter((effect) => effect.kind === "whiteboard.authority");
    expect(promoted).toMatchObject({ syncRoomId: "room_a", principalKey: "user:ada", narrowed: false });
    if (promoted.kind !== "whiteboard.authority") throw new Error("expected authority");
    m.apply({ kind: "whiteboardAuthorityApplied", admissionId: promoted.admissionId, hash: promoted.hash });
    expect(m.plan().filter((effect) => effect.kind === "whiteboard.authority")).toEqual([]);

    // A demotion suspends their board writes until the room re-reads it.
    m.apply({ kind: "setModerator", subject: host, identity: a.identity, moderator: false });
    expect(m.plan()).toContainEqual(expect.objectContaining({ kind: "whiteboard.authority", narrowed: true }));
  });
});

describe("room metadata across room instances", () => {
  it("does not take a write to a room that was recreated for the new room's state", () => {
    const m = new Meeting();
    const h = m.admitted(host);
    m.joined(h.identity);
    const write = m.plan().find((effect) => effect.kind === "livekit.roomMetadata");
    if (write?.kind !== "livekit.roomMetadata") throw new Error("expected a metadata write");
    // The room restarts on the same node while the write is outstanding.
    m.apply({ kind: "roomFinished" });
    m.apply({ kind: "roomStarted" });
    m.joined(h.identity);
    m.apply({
      kind: "effectSucceeded",
      key: "metadata",
      result: { kind: "metadataApplied", placement: write.placement, room: write.room, version: write.version },
    });
    expect(m.state.room.appliedVersion).toBe(0);
    expect(m.plan()).toContainEqual(expect.objectContaining({ kind: "livekit.roomMetadata", room: write.room + 2 }));
  });
});

describe("room metadata version", () => {
  it("starts a room's state above any version an earlier state of it could have shown", () => {
    const m = new Meeting();
    m.joined(m.admitted(host).identity);
    for (let i = 0; i < 50; i += 1) m.apply({ kind: "setCountdown", subject: host, endsAt: T0 + i });
    const shown = m.state.room.version;
    // The state is lost and recreated from D1 a moment later.
    const recreated = step(null, { kind: "init", snapshot: { ...snapshot, firstJoinedAt: T0 } }, m.now + 1_000).state;
    expect(recreated.room.version).toBeGreaterThan(shown);
  });
});
