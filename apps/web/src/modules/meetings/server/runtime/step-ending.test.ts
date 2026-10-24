import { describe, expect, it } from "vitest";
import {
  ADMISSION_PENDING_TTL_MS,
  EGRESS_START_RESULT_TIMEOUT_MS,
  EMPTY_MEETING_GRACE_MS,
  END_NOTICE_GRACE_MS,
  MEDIA_NODE_UNREACHABLE_GRACE_MS,
  PRESENCE_CHECK_MS,
  SETTLED_ATTEMPT_RETENTION_MS,
  type SurfaceFocus,
} from "./model";
import { nextWakeAt, readyToDrain } from "./plan";
import type { Command, Input, Subject } from "./protocol";
import { T0, host, ada, bob, Meeting, kinds } from "./step-test-support";

describe("ending", () => {
  it("never discards a meeting someone joined, however its attempts end (review bug #1)", () => {
    const m = new Meeting();
    const a = m.admitted(ada);
    m.joined(a.identity);
    expect(m.state.meta.phase).toBe("live");

    // The node dies; the participant's recovery issues an attempt that never
    // connects and is released.
    m.apply({ kind: "placed", nodeId: "node-b", from: "node-a" });
    const recovery = m.admitted(ada, { admissionId: a.admissionId });
    m.apply({ kind: "release", subject: ada, attemptId: recovery.attemptId });
    m.advance(EMPTY_MEETING_GRACE_MS);

    expect(m.state.meta.phase).toBe("ended");
    expect(m.state.meta.endReason).toBe("natural");
    expect(kinds(m.plan())).toContain("meeting.finalize");
    expect(kinds(m.plan())).not.toContain("meeting.discard");
  });

  it("admits a first join that reaches the room minutes after its row was created", () => {
    const m = new Meeting();
    // The request that created the row failed to reach the room; a retry does.
    m.now += 3 * 60_000;
    expect(m.admitted(host).role).toBe("host");
    expect(m.state.meta.phase).toBe("provisional");
  });

  it("discards an occurrence nobody ever joined", () => {
    const m = new Meeting();
    const a = m.admitted(host);
    m.apply({ kind: "release", subject: host, attemptId: a.attemptId });
    m.advance(EMPTY_MEETING_GRACE_MS);
    expect(m.state.meta.endReason).toBe("discarded");
    expect(kinds(m.plan())).toContain("meeting.discard");
  });

  it("drains only after every outside effect settled", () => {
    const m = new Meeting();
    const a = m.admitted(host);
    m.joined(a.identity);
    m.apply({ kind: "end", subject: host, reason: "host" });
    expect(readyToDrain(m.state)).toBe(false);

    m.apply({ kind: "finalized" });
    m.apply({ kind: "postTasksDone" });
    m.apply({ kind: "whiteboardCaptureStarted" });
    expect(readyToDrain(m.state)).toBe(false);
    m.apply({ kind: "roomDeleted", placement: m.here() });
    expect(readyToDrain(m.state)).toBe(true);
  });

  it("ends a meeting whose media node nobody can reach, once everyone is let go", () => {
    const m = new Meeting();
    const a = m.admitted(ada);
    m.joined(a.identity);
    // Everyone closed their tab while the node was down: no presence check succeeds.
    m.apply({ kind: "effectFailed", key: "presence", error: "connect ECONNREFUSED" });
    m.advance(MEDIA_NODE_UNREACHABLE_GRACE_MS);
    expect(m.state.attempts[a.attemptId]).toMatchObject({ endReason: "media_unreachable", removed: true });

    m.advance(EMPTY_MEETING_GRACE_MS);
    expect(m.state.meta).toMatchObject({ phase: "ended", endReason: "natural" });
  });

  it("keeps a meeting whose node answers again before the grace runs out", () => {
    const m = new Meeting();
    const a = m.admitted(ada);
    m.joined(a.identity);
    m.apply({ kind: "effectFailed", key: "presence", error: "timeout" });
    m.now += MEDIA_NODE_UNREACHABLE_GRACE_MS - 1_000;
    m.apply({ kind: "participantsListed", placement: m.here(), requestedAt: m.now, roomExists: true, participants: [
      { identity: a.identity, sid: `sid-${a.identity}`, joinedAt: null, standard: true },
    ] });
    m.advance(10_000);
    expect(m.state.attempts[a.attemptId].endedAt).toBeNull();
  });

  it("drains an ended meeting whose media node is gone", () => {
    const m = new Meeting();
    m.joined(m.admitted(host).identity);
    m.apply({ kind: "end", subject: host, reason: "host" });
    m.apply({ kind: "finalized" });
    m.apply({ kind: "postTasksDone" });
    m.apply({ kind: "whiteboardCaptureStarted" });
    m.apply({ kind: "effectFailed", key: "room.delete", error: "no configured media node" });
    expect(readyToDrain(m.state)).toBe(false);

    m.advance(MEDIA_NODE_UNREACHABLE_GRACE_MS);
    expect(readyToDrain(m.state)).toBe(true);
  });

  it("tells the room it ended before removing anyone", () => {
    const m = new Meeting();
    const h = m.admitted(host);
    m.joined(h.identity);
    const a = m.admitted(ada);
    m.joined(a.identity);
    m.apply({ kind: "metadataApplied", placement: m.here(), room: m.state.room.instance, version: m.state.room.version });

    m.apply({ kind: "end", subject: host, reason: "host" });
    const effects = m.plan();
    const write = effects.find((effect) => effect.kind === "livekit.roomMetadata");
    expect(write?.kind === "livekit.roomMetadata" && write.metadata.ended).toBe(true);
    // A participant removed first would take it for a kick and ask to join again.
    expect(kinds(effects)).not.toContain("livekit.remove");
    expect(nextWakeAt(m.state, m.now)).toBeLessThanOrEqual(m.now + END_NOTICE_GRACE_MS);

    if (write?.kind !== "livekit.roomMetadata") throw new Error("no metadata write");
    m.apply({ kind: "metadataApplied", placement: write.placement, room: write.room, version: write.version });
    expect(m.plan().filter((effect) => effect.kind === "livekit.remove")).toHaveLength(2);
  });

  it("removes everyone anyway once the end notice's grace runs out", () => {
    const m = new Meeting();
    const a = m.admitted(ada);
    m.joined(a.identity);
    m.apply({ kind: "end", subject: { kind: "system" }, reason: "system" });
    // The write keeps failing.
    m.apply({ kind: "effectFailed", key: "metadata", error: "timeout", placement: m.here() });
    expect(kinds(m.plan())).not.toContain("livekit.remove");

    m.advance(END_NOTICE_GRACE_MS);
    expect(kinds(m.plan())).toContain("livekit.remove");
    expect(kinds(m.plan())).not.toContain("livekit.roomMetadata");
  });

  it("ends at the plan's duration limit", () => {
    const m = new Meeting({ maxDurationMs: 60 * 60_000 });
    const a = m.admitted(ada);
    m.joined(a.identity);
    m.advance(60 * 60_000);
    expect(m.state.meta.endReason).toBe("system");
  });
});

describe("effect retries", () => {
  it("ends a listing's backoff when the listing succeeds", () => {
    const m = new Meeting();
    m.joined(m.admitted(host).identity);
    m.apply({ kind: "setEgress", subject: host, mode: "recording", on: true, target: null });
    m.now += EGRESS_START_RESULT_TIMEOUT_MS;
    m.apply({ kind: "effectFailed", key: "egress.list", error: "timeout" });
    expect(m.state.retries["egress.list"]).toBeDefined();

    m.now += 5_000;
    m.apply({ kind: "effectSucceeded", key: "egress.list", result: { kind: "egressObserved", complete: true, egresses: [] } });
    expect(m.state.retries["egress.list"]).toBeUndefined();
  });

  it("forgets the backoff of an effect nothing calls for any more, and never wakes early for it", () => {
    const m = new Meeting();
    m.joined(m.admitted(host).identity);
    const a = m.admitted(ada);
    m.joined(a.identity);
    // Promoting her owes LiveKit a new grant, which then fails to apply.
    m.apply({ kind: "setModerator", subject: host, identity: a.identity, moderator: true });
    m.apply({ kind: "effectFailed", key: `grant:${a.attemptId}`, error: "livekit down" });
    expect(m.state.retries[`grant:${a.attemptId}`]).toBeDefined();

    m.apply({ kind: "leave", subject: ada, attemptId: a.attemptId });
    expect(m.state.retries).toEqual({});
    m.now += 30_000;
    expect(nextWakeAt(m.state, m.now)! - m.now).toBeGreaterThan(1_000);
  });

  it("waits out a failing presence check's backoff instead of spinning", () => {
    const m = new Meeting();
    m.joined(m.admitted(host).identity);
    m.apply({ kind: "participantsListed", placement: m.here(), requestedAt: m.now, roomExists: true, participants: [] });
    m.now += PRESENCE_CHECK_MS;
    m.apply({ kind: "effectFailed", key: "presence", error: "livekit down" });
    m.apply({ kind: "effectFailed", key: "presence", error: "livekit down" });
    expect(nextWakeAt(m.state, m.now)).toBeGreaterThanOrEqual(m.state.retries.presence.retryAt);
  });

  it("does not wake before a due retry's effect has had time to run", () => {
    const m = new Meeting();
    m.joined(m.admitted(host).identity);
    m.apply({ kind: "effectFailed", key: "presence", error: "livekit down" });
    m.now = m.state.retries.presence.retryAt + 1;
    // Due now: this commit plans it, and the wake after it is not 250 ms away.
    expect(kinds(m.plan())).toContain("livekit.listParticipants");
    expect(nextWakeAt(m.state, m.now)! - m.now).toBeGreaterThan(1_000);
  });
});

describe("state size", () => {
  it("forgets an attempt once it has ended, left the room, and settled", () => {
    const m = new Meeting();
    m.admitted(host);
    const a = m.admitted(ada);
    m.joined(a.identity);
    m.apply({ kind: "leave", subject: ada, attemptId: a.attemptId });
    m.apply({ kind: "removed", placement: m.here(), identity: a.identity });
    m.now += SETTLED_ATTEMPT_RETENTION_MS - 1;
    m.apply({ kind: "tick" });
    expect(m.state.attempts[a.attemptId]).toBeDefined();
    m.now += 1;
    m.apply({ kind: "tick" });
    expect(m.state.attempts[a.attemptId]).toBeUndefined();
    // A late event for the forgotten identity only removes it from the room.
    m.apply({ kind: "participantJoined", identity: a.identity, sid: "late", joinedAt: null, at: m.now });
    expect(m.plan()).toContainEqual(expect.objectContaining({ kind: "livekit.remove", identity: a.identity }));
  });

  it("answers a retried leave or release for a forgotten attempt as it would an ended one", () => {
    const m = new Meeting();
    m.admitted(host);
    const a = m.admitted(ada);
    m.joined(a.identity);
    m.apply({ kind: "leave", subject: ada, attemptId: a.attemptId });
    m.apply({ kind: "removed", placement: m.here(), identity: a.identity });
    m.now += SETTLED_ATTEMPT_RETENTION_MS;
    m.apply({ kind: "tick" });
    expect(m.state.attempts[a.attemptId]).toBeUndefined();

    expect(m.apply({ kind: "leave", subject: ada, attemptId: a.attemptId }).reply).toEqual({ kind: "left", found: false });
    expect(m.apply({ kind: "release", subject: ada, attemptId: a.attemptId }).reply).toEqual({ kind: "ok" });
    // Still someone else's to ask about.
    expect(m.refuse({ kind: "leave", subject: bob, attemptId: a.attemptId }).code).toBe("FORBIDDEN");
  });

  it("ends, rather than discards, a joined meeting whose room lost its state", () => {
    const m = new Meeting({ firstJoinedAt: T0 - 60_000 });
    m.advance(0);
    m.advance(EMPTY_MEETING_GRACE_MS);
    expect(m.state.meta.phase).toBe("ended");
    expect(m.state.meta.endReason).toBe("natural");
    expect(kinds(m.plan())).toContain("meeting.finalize");
  });

  it("forgets an expired approval request, and a guest naming it asks again", () => {
    const m = new Meeting({ joinPolicy: "approval_required" });
    m.joined(m.admitted(host).identity);
    const guest: Subject = { kind: "guest", admissionId: null, verified: false };
    const waiting = m.join(guest);
    const admissionId = waiting.kind === "waiting" ? waiting.admissionId : "";
    m.advance(ADMISSION_PENDING_TTL_MS);
    expect(m.state.admissions[admissionId].status).toBe("expired");
    m.advance(SETTLED_ATTEMPT_RETENTION_MS);
    expect(m.state.admissions[admissionId]).toBeUndefined();

    const again = m.join({ kind: "guest", admissionId, verified: false });
    expect(again.kind).toBe("waiting");
    expect(again.kind === "waiting" && again.admissionId).not.toBe(admissionId);
  });

  it("changes nothing for a request that finds the room as it was", () => {
    const m = new Meeting();
    m.joined(m.admitted(host).identity);
    const a = m.admitted(ada);
    m.joined(a.identity);
    const before = JSON.stringify(m.state);
    m.now += 5_000;
    m.apply({ kind: "listPending", subject: host });
    expect(JSON.stringify(m.state)).toBe(before);
  });
});

describe("every command, repeated", () => {
  // A request whose reply is lost is sent again (client.server.ts), so a
  // command applied twice must answer the same and change nothing more.
  // Keyed by every command kind: a new command cannot skip this.
  const guest: Subject = { kind: "guest", admissionId: null, verified: false };
  const board: SurfaceFocus = { usageId: "usage_a", whiteboardId: "wb_a", syncRoomId: "room_a" };

  function scenario() {
    const m = new Meeting();
    const h = m.admitted(host);
    m.joined(h.identity);
    const a = m.admitted(ada);
    m.joined(a.identity);
    const issued = m.admitted(ada, { clientAttemptId: "second-tab" });
    m.apply({ kind: "setJoinPolicy", subject: host, joinPolicy: "approval_required" });
    const waiting = m.join(bob);
    if (waiting.kind !== "waiting") throw new Error(waiting.kind);
    m.apply({ kind: "raiseHand", subject: ada, attemptId: a.attemptId, raiseId: "r1" });
    return { m, h, a, issued, pending: waiting.admissionId };
  }
  type Scenario = ReturnType<typeof scenario>;
  /** One request, as sent the first time or as its retry, which the room gives new ids. */
  type Case = (s: Scenario, retry: boolean) => Input;

  const joinAs = (subject: Subject, clientAttemptId: string): Case => (_, retry) => ({
    kind: "join", subject, admissionId: null, clientAttemptId, displayName: "someone", captionLanguage: "en",
    replacesAttemptId: null, newAdmissionId: retry ? "admission_retry" : "admission_new",
    newAttemptId: retry ? "attempt_retry" : "attempt_new",
    newGuestSecretHash: subject.kind === "guest" ? "guest-secret-hash" : null,
    guestNetworkKey: subject.kind === "guest" ? "network-a" : null,
  });

  const cases: Record<Command["kind"], Record<string, Case>> = {
    join: {
      "a manager's join": joinAs(host, "host-tab-2"),
      "a first join that waits": joinAs({ kind: "user", userId: "carol", spaceRole: "visitor" }, "carol-tab"),
      "a guest's first join": joinAs(guest, "guest-tab"),
    },
    release: { "an unused attempt": ({ issued }) => ({ kind: "release", subject: ada, attemptId: issued.attemptId }) },
    leave: { "a live attempt": ({ a }) => ({ kind: "leave", subject: ada, attemptId: a.attemptId }) },
    listPending: { "the queue": () => ({ kind: "listPending", subject: host }) },
    authorize: { "a moderator's question": () => ({ kind: "authorize", subject: host }) },
    decideAdmission: {
      "an approval": ({ pending }) => ({ kind: "decideAdmission", subject: host, admissionId: pending, approve: true }),
      "a denial": ({ pending }) => ({ kind: "decideAdmission", subject: host, admissionId: pending, approve: false }),
    },
    setJoinPolicy: { "opening the door": () => ({ kind: "setJoinPolicy", subject: host, joinPolicy: "open" }) },
    renameMeeting: {
      "a rename": () => ({ kind: "renameMeeting", subject: host, title: "Standup", expectedTitle: null }),
    },
    setModerator: {
      "a promotion": ({ a }) => ({ kind: "setModerator", subject: host, identity: a.identity, moderator: true }),
    },
    removeParticipant: {
      "a removal": ({ a }) => ({ kind: "removeParticipant", subject: host, admissionId: a.admissionId }),
    },
    raiseHand: { "a raised hand": ({ a }) => ({ kind: "raiseHand", subject: ada, attemptId: a.attemptId, raiseId: "r2" }) },
    lowerHand: { "a lowered hand": ({ a }) => ({ kind: "lowerHand", subject: ada, attemptId: a.attemptId }) },
    resolveHand: { "a resolved hand": ({ a }) => ({ kind: "resolveHand", subject: host, admissionId: a.admissionId }) },
    requestScreenShare: {
      "a request": ({ a }) => ({ kind: "requestScreenShare", subject: ada, attemptId: a.attemptId }),
    },
    decideScreenShare: {
      "a grant": ({ a }) => ({ kind: "decideScreenShare", subject: host, admissionId: a.admissionId, allow: true }),
    },
    grantBoardEdit: {
      "a grant": () => ({ kind: "grantBoardEdit", subject: host, principal: { type: "user", id: "ada" } }),
    },
    stopScreenShare: { "a stop": ({ a }) => ({ kind: "stopScreenShare", subject: ada, attemptId: a.attemptId }) },
    requestBoard: {
      "an ask": ({ a }) => ({ kind: "requestBoard", subject: ada, attemptId: a.attemptId, requested: true }),
      "taking it back": ({ a }) => ({ kind: "requestBoard", subject: ada, attemptId: a.attemptId, requested: false }),
    },
    declineBoardRequest: {
      "a decline": ({ a }) => ({ kind: "declineBoardRequest", subject: host, admissionId: a.admissionId }),
    },
    setTranscription: {
      "turning it off": () => ({ kind: "setTranscription", subject: host, on: false }),
      "turning it on": () => ({ kind: "setTranscription", subject: host, on: true }),
    },
    requestTranscriptionStop: {
      "an ask": ({ a }) => ({ kind: "requestTranscriptionStop", subject: ada, attemptId: a.attemptId, requested: true }),
    },
    declineTranscriptionStop: {
      "a decline": ({ a }) => ({ kind: "declineTranscriptionStop", subject: host, admissionId: a.admissionId }),
    },
    setCountdown: { "a countdown": () => ({ kind: "setCountdown", subject: host, endsAt: T0 + 60_000 }) },
    setEgress: {
      "recording on": () => ({ kind: "setEgress", subject: host, mode: "recording", on: true, target: null }),
      "recording off, never on": () => ({ kind: "setEgress", subject: host, mode: "recording", on: false, target: null }),
    },
    setSurface: { "opening the board": () => ({ kind: "setSurface", subject: host, open: true, fallback: board }) },
    present: { "presenting a board": () => ({ kind: "present", subject: host, focus: board }) },
    end: { "the host's end": () => ({ kind: "end", subject: host, reason: "host" }) },
    authority: {
      "a role change": (s) => ({ kind: "authority", userId: "ada", spaceRole: "member", reason: "space_role_changed", readAt: s.m.now }),
    },
    revoke: { "a revocation": () => ({ kind: "revoke", userId: "ada", reason: "account_deleted" }) },
  };

  for (const [kind, named] of Object.entries(cases)) {
    for (const [name, build] of Object.entries(named)) {
      it(`${kind}: ${name}`, () => {
        const s = scenario();
        const first = s.m.apply(build(s, false)).reply;
        const after = structuredClone(s.m.state);
        const again = s.m.apply(build(s, true)).reply;
        expect(again).toEqual(first);
        expect(s.m.state).toEqual(after);
      });
    }
  }
});
