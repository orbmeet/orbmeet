import { describe, expect, it } from "vitest";
import {
  ABSENT_GRACE_MS,
  ADMISSION_PENDING_TTL_MS,
  EMPTY_MEETING_GRACE_MS,
  ISSUE_GRACE_MS,
  PRESENCE_CHECK_MS,
  SETTLED_ATTEMPT_RETENTION_MS,
} from "./model";
import { nextWakeAt } from "./plan";
import type { Subject } from "./protocol";
import { T0, host, ada, bob, Meeting, kinds } from "./step-test-support";

describe("joining", () => {
  it("admits into an open meeting and repeats the same request idempotently", () => {
    const m = new Meeting();
    const first = m.admitted(ada, { clientAttemptId: "c1" });
    const again = m.admitted(ada, { admissionId: first.admissionId, clientAttemptId: "c1" });
    expect(again.attemptId).toBe(first.attemptId);
    expect(Object.keys(m.state.attempts)).toHaveLength(1);
    expect(first.identity).toBe(`ada_${first.attemptId}`);
    expect(first.role).toBe("attendee");
  });

  it("gives every rejoin its own attempt and identity, and the newest joined one wins", () => {
    const m = new Meeting();
    const first = m.admitted(ada);
    m.joined(first.identity);
    const second = m.admitted(ada, { admissionId: first.admissionId });
    expect(second.identity).not.toBe(first.identity);

    m.joined(second.identity);
    expect(m.state.attempts[first.attemptId].endReason).toBe("superseded");
    expect(m.plan()).toContainEqual(expect.objectContaining({ kind: "livekit.remove", identity: first.identity }));
    expect(m.plan()).not.toContainEqual(expect.objectContaining({ kind: "livekit.remove", identity: second.identity }));
  });

  it("keeps the newest attempt when one listing is the first to report both", () => {
    const m = new Meeting();
    const older = m.admitted(ada);
    m.now += 5_000;
    const newer = m.admitted(ada, { admissionId: older.admissionId });
    m.listed([
      { identity: older.identity, sid: "s_old", joinedAt: m.now - 5_000, standard: true },
      { identity: newer.identity, sid: "s_new", joinedAt: m.now, standard: true },
    ]);

    expect(m.state.attempts[newer.attemptId].endedAt).toBeNull();
    expect(m.state.attempts[older.attemptId].endReason).toBe("superseded");
    const removals = m.plan().filter((effect) => effect.kind === "livekit.remove");
    expect(removals).toEqual([expect.objectContaining({ identity: older.identity })]);
  });

  it("does not let an earlier attempt that joins late end a newer one", () => {
    const m = new Meeting();
    const older = m.admitted(ada);
    const newer = m.admitted(ada, { admissionId: older.admissionId });
    m.joined(older.identity);
    expect(m.state.attempts[newer.attemptId].endedAt).toBeNull();

    m.joined(newer.identity);
    expect(m.state.attempts[older.attemptId].endReason).toBe("superseded");
    expect(m.state.attempts[newer.attemptId].endedAt).toBeNull();
  });

  it("releasing a stale attempt never touches the adopted one (review bug #2)", () => {
    const m = new Meeting();
    const a = m.admitted(ada);
    m.joined(a.identity);
    // Recovery: two requests reach the server; the client adopts the older.
    const older = m.admitted(ada, { admissionId: a.admissionId });
    const newer = m.admitted(ada, { admissionId: a.admissionId });
    m.apply({ kind: "release", subject: ada, attemptId: newer.attemptId });
    m.joined(older.identity);

    expect(m.state.attempts[older.attemptId].endedAt).toBeNull();
    expect(m.state.attempts[newer.attemptId].endReason).toBe("released");
    expect(m.state.admissions[older.admissionId].status).toBe("approved");
  });

  it("waits for approval, then admits", () => {
    const m = new Meeting({ joinPolicy: "approval_required" });
    const waiting = m.join(ada);
    expect(waiting.kind).toBe("waiting");
    const admissionId = waiting.kind === "waiting" ? waiting.admissionId : "";
    expect(m.join(ada, { admissionId }).kind).toBe("waiting");

    const hostView = m.admitted(host);
    m.joined(hostView.identity);
    m.apply({ kind: "decideAdmission", subject: host, admissionId, approve: true });
    expect(m.admitted(ada, { admissionId }).admissionId).toBe(admissionId);
  });

  it("continues a signed-in user's admission from another tab instead of queueing again", () => {
    const m = new Meeting({ joinPolicy: "approval_required", maxParticipants: 3 });
    const hostView = m.admitted(host);
    m.joined(hostView.identity);
    const waiting = m.join(ada);
    const admissionId = waiting.kind === "waiting" ? waiting.admissionId : "";
    // A second tab knows no admission id; it joins the same request.
    expect(m.join(ada)).toEqual(expect.objectContaining({ kind: "waiting", admissionId }));

    m.apply({ kind: "decideAdmission", subject: host, admissionId, approve: true });
    const first = m.admitted(ada);
    m.joined(first.identity);
    const second = m.admitted(ada);
    expect(second.admissionId).toBe(admissionId);
    m.joined(second.identity);
    // One person, one seat: the newer tab is the participant.
    expect(m.state.attempts[first.attemptId].endReason).toBe("superseded");
    expect(Object.values(m.state.admissions).filter((a) => a.userId === "ada")).toHaveLength(1);
  });

  it("does not let a tab another tab took over take the seat back when it asks why it was removed", () => {
    const m = new Meeting();
    const older = m.admitted(ada);
    m.joined(older.identity);
    const newer = m.admitted(ada);
    m.joined(newer.identity);
    expect(m.state.attempts[older.attemptId].endReason).toBe("superseded");

    expect(m.refuse({
      kind: "join", subject: ada, admissionId: older.admissionId, clientAttemptId: "recheck", displayName: "ada",
      captionLanguage: "en", replacesAttemptId: older.attemptId, newAdmissionId: "x", newAttemptId: "y", newGuestSecretHash: null, guestNetworkKey: null,
    }).code).toBe("MEETING_OPEN_ELSEWHERE");
    expect(m.state.attempts[newer.attemptId].endedAt).toBeNull();

    // Removed for any other reason, the same recheck is answered as before.
    m.apply({ kind: "leave", subject: ada, attemptId: newer.attemptId });
    expect(m.join(ada, { replacesAttemptId: newer.attemptId }).kind).toBe("admitted");
  });

  it("keeps refusing a tab that was taken over after its attempt is forgotten", () => {
    const m = new Meeting();
    const older = m.admitted(ada);
    m.joined(older.identity);
    const newer = m.admitted(ada);
    m.joined(newer.identity);
    m.apply({ kind: "removed", placement: m.here(), identity: older.identity });
    m.advance(SETTLED_ATTEMPT_RETENTION_MS);
    expect(m.state.attempts[older.attemptId]).toBeUndefined();

    expect(m.refuse({
      kind: "join", subject: ada, admissionId: older.admissionId, clientAttemptId: "recheck", displayName: "ada",
      captionLanguage: "en", replacesAttemptId: older.attemptId, newAdmissionId: "x", newAttemptId: "y", newGuestSecretHash: null, guestNetworkKey: null,
    }).code).toBe("MEETING_OPEN_ELSEWHERE");
    expect(m.state.attempts[newer.attemptId].endedAt).toBeNull();
  });

  it("keeps a closed door closed except to a manager", () => {
    const m = new Meeting({ joinPolicy: "closed" });
    expect(m.refuse({
      kind: "join", subject: ada, admissionId: null, clientAttemptId: "c", displayName: "Ada",
      captionLanguage: "en", replacesAttemptId: null, newAdmissionId: "x", newAttemptId: "y", newGuestSecretHash: null, guestNetworkKey: null,
    }).code).toBe("MEETING_CLOSED");
    expect(m.admitted(host).role).toBe("host");
  });

  it("refuses someone else's admission", () => {
    const m = new Meeting();
    const a = m.admitted(ada);
    expect(m.refuse({
      kind: "join", subject: bob, admissionId: a.admissionId, clientAttemptId: "c", displayName: "Bob",
      captionLanguage: "en", replacesAttemptId: null, newAdmissionId: "x", newAttemptId: "y", newGuestSecretHash: null, guestNetworkKey: null,
    }).code).toBe("FORBIDDEN");
  });

  it("holds one seat free for a manager until one is present", () => {
    const m = new Meeting({ maxParticipants: 2 });
    m.admitted(ada);
    expect(m.refuse({
      kind: "join", subject: bob, admissionId: null, clientAttemptId: "c", displayName: "Bob",
      captionLanguage: "en", replacesAttemptId: null, newAdmissionId: "x", newAttemptId: "y", newGuestSecretHash: null, guestNetworkKey: null,
    }).code).toBe("PLAN_LIMIT_REACHED");
    expect(m.admitted(host).role).toBe("host");
  });

  it("keeps no admission for a join turned away from a full meeting", () => {
    const m = new Meeting({ maxParticipants: 1 });
    m.joined(m.admitted(host).identity);
    const guest: Subject = { kind: "guest", admissionId: null, verified: false };
    for (const attempt of ["g1", "g2", "g3"]) {
      expect(m.refuse({
        kind: "join", subject: guest, admissionId: null, clientAttemptId: attempt, displayName: "Guest",
        captionLanguage: "en", replacesAttemptId: null, newAdmissionId: `adm-${attempt}`, newAttemptId: `att-${attempt}`, newGuestSecretHash: "hash", guestNetworkKey: null,
      }).code).toBe("PLAN_LIMIT_REACHED");
    }
    expect(Object.keys(m.state.admissions)).toHaveLength(1);
  });

  it("answers a guest's repeated first join with the admission it already made", () => {
    const m = new Meeting({ maxParticipants: 2 });
    m.joined(m.admitted(host).identity);
    const guest: Subject = { kind: "guest", admissionId: null, verified: false };
    // The first answer was lost; the retry brings the same secret.
    const first = m.admitted(guest, { guestSecretHash: "first-join" });
    const retry = m.admitted(guest, { guestSecretHash: "first-join" });
    expect(retry.admissionId).toBe(first.admissionId);
    expect(Object.keys(m.state.admissions)).toHaveLength(2);
  });

  it("keeps one waiting admission however often a guest's first join is retried", () => {
    const m = new Meeting({ joinPolicy: "approval_required" });
    const guest: Subject = { kind: "guest", admissionId: null, verified: false };
    const answers = [1, 2, 3].map(() => m.join(guest, { guestSecretHash: "first-join" }));
    expect(new Set(answers.map((answer) => answer.kind === "waiting" && answer.admissionId)).size).toBe(1);
    expect(Object.values(m.state.admissions).filter((admission) => admission.status === "pending")).toHaveLength(1);
  });

  it("does not seat a token that arrives after a look found it missing", () => {
    const m = new Meeting();
    const a = m.admitted(ada);
    m.advance(ISSUE_GRACE_MS);
    m.listed([]);
    expect(m.state.attempts[a.attemptId].endReason).toBe("unused");
    m.joined(a.identity);
    expect(m.plan()).toContainEqual(expect.objectContaining({ kind: "livekit.remove", identity: a.identity }));
  });
});

describe("a token whose join was never reported", () => {
  it("keeps its seat however long the grace has passed, until a look shows it is not there", () => {
    const m = new Meeting();
    const a = m.admitted(ada);
    m.advance(ISSUE_GRACE_MS * 10);
    expect(m.state.attempts[a.attemptId].endedAt).toBeNull();
  });

  it("asks for a look at the grace's end, between the regular ones, and wakes for it", () => {
    const m = new Meeting();
    const h = m.admitted(host);
    m.joined(h.identity);
    const seenHost = { identity: h.identity, sid: `sid-${h.identity}`, joinedAt: m.now, standard: true };
    m.listed([seenHost]);
    m.now += PRESENCE_CHECK_MS / 2;
    const a = m.admitted(ada);
    const graceEnd = m.state.attempts[a.attemptId].issuedAt + ISSUE_GRACE_MS;
    // The regular look comes first and is too early to end it.
    m.now = T0 + PRESENCE_CHECK_MS;
    m.listed([seenHost]);
    expect(m.state.attempts[a.attemptId].endedAt).toBeNull();
    expect(graceEnd).toBeLessThan(T0 + 2 * PRESENCE_CHECK_MS);
    expect(nextWakeAt(m.state, m.now)).toBe(graceEnd);
    m.now = graceEnd - 1;
    expect(kinds(m.plan())).not.toContain("livekit.listParticipants");
    m.now = graceEnd;
    expect(m.plan()).toContainEqual(
      expect.objectContaining({ kind: "livekit.listParticipants", requestedAt: graceEnd }),
    );
    m.listed([seenHost]);
    expect(m.state.attempts[a.attemptId].endReason).toBe("unused");
  });

  it("is not ended by a look requested before its grace ended, whenever that look lands", () => {
    const m = new Meeting();
    const a = m.admitted(ada);
    const requestedAt = m.now;
    m.advance(ISSUE_GRACE_MS + 5_000);
    m.listed([], requestedAt);
    expect(m.state.attempts[a.attemptId].endedAt).toBeNull();
    // ...and that look does not count as the one the grace asks for.
    expect(kinds(m.plan())).toContain("livekit.listParticipants");
  });

  it("joins the participant a look finds, so a lost webhook never discards a meeting people are in", () => {
    const m = new Meeting();
    const a = m.admitted(host);
    m.listed([]);
    m.advance(ISSUE_GRACE_MS);
    m.listed([{ identity: a.identity, sid: "PA_1", joinedAt: m.now - 50_000, standard: true }]);
    expect(m.state.attempts[a.attemptId]).toMatchObject({ endedAt: null, sid: "PA_1" });
    expect(m.state.meta.phase).toBe("live");
    m.advance(EMPTY_MEETING_GRACE_MS * 2);
    expect(m.state.meta.phase).toBe("live");
    expect(kinds(m.plan())).not.toContain("meeting.discard");
  });
});

describe("presence", () => {
  it("treats a departure as absence until a presence check confirms it", () => {
    const m = new Meeting();
    const a = m.admitted(ada);
    m.joined(a.identity);
    m.apply({ kind: "participantLeft", identity: a.identity, sid: null, at: m.now });
    expect(m.state.attempts[a.attemptId].endedAt).toBeNull();

    // A full client reconnect reports the same identity back.
    m.apply({ kind: "participantsListed", placement: m.here(), requestedAt: m.now, participants: [{ identity: a.identity, sid: "s2", joinedAt: null, standard: true }], roomExists: true });
    expect(m.state.attempts[a.attemptId].absentSince).toBeNull();

    m.apply({ kind: "participantLeft", identity: a.identity, sid: null, at: m.now });
    m.apply({ kind: "participantsListed", placement: m.here(), requestedAt: m.now, participants: [], roomExists: true });
    m.now += ABSENT_GRACE_MS;
    m.apply({ kind: "participantsListed", placement: m.here(), requestedAt: m.now, participants: [], roomExists: true });
    expect(m.state.attempts[a.attemptId].endReason).toBe("participant_left");
  });

  it("removes standard participants it does not know, and leaves agents alone", () => {
    const m = new Meeting();
    const a = m.admitted(ada);
    m.joined(a.identity);
    m.apply({
      kind: "participantsListed",
      placement: m.here(),
      requestedAt: m.now,
      participants: [
        { identity: a.identity, sid: "s", joinedAt: null, standard: true },
        { identity: "intruder", sid: "i", joinedAt: null, standard: true },
        { identity: "agent-1", sid: "g", joinedAt: null, standard: false },
      ],
      roomExists: true,
    });
    const removals = () => m.plan().filter((effect) => effect.kind === "livekit.remove");
    expect(removals()).toEqual([expect.objectContaining({ identity: "intruder" })]);

    // A removal that failed is kept, and retried after its backoff.
    m.apply({ kind: "effectFailed", key: "remove:intruder", error: "livekit down" });
    expect(removals()).toEqual([]);
    m.advance(60_000);
    expect(removals()).toEqual([expect.objectContaining({ identity: "intruder" })]);
    m.apply({ kind: "effectSucceeded", key: "remove:intruder", result: { kind: "removed", placement: m.here(), identity: "intruder" } });
    expect(removals()).toEqual([]);
  });
});

describe("LiveKit sessions", () => {
  it("does not take an earlier session, reported late, for the current one", () => {
    const m = new Meeting();
    const a = m.admitted(ada);
    m.apply({ kind: "participantJoined", identity: a.identity, sid: "PA_old", joinedAt: m.now, at: m.now });
    m.now += 10_000;
    m.apply({ kind: "participantJoined", identity: a.identity, sid: "PA_new", joinedAt: m.now, at: m.now });
    // A listing taken before the reconnect lands after it.
    m.listed([{ identity: a.identity, sid: "PA_old", joinedAt: m.now - 10_000, standard: true }], m.now - 5_000);
    expect(m.state.attempts[a.attemptId].sid).toBe("PA_new");
    // So the current session's departure is still heard.
    m.apply({ kind: "participantLeft", identity: a.identity, sid: "PA_new", at: m.now });
    expect(m.state.attempts[a.attemptId].absentSince).not.toBeNull();
  });

  it("does not take a late report of an earlier session for the current one when it omits the join time", () => {
    const m = new Meeting();
    const a = m.admitted(ada);
    m.apply({ kind: "participantJoined", identity: a.identity, sid: "PA_old", joinedAt: m.now, at: m.now });
    m.now += 10_000;
    m.apply({ kind: "participantJoined", identity: a.identity, sid: "PA_new", joinedAt: m.now, at: m.now });
    const grant = m.state.attempts[a.attemptId].appliedGrant;
    // Taken before the reconnect, and LiveKit did not say when PA_old joined.
    m.listed([{ identity: a.identity, sid: "PA_old", joinedAt: null, standard: true }], m.now - 5_000);
    expect(m.state.attempts[a.attemptId]).toMatchObject({ sid: "PA_new", appliedGrant: grant });
    m.apply({ kind: "grantApplied", placement: m.here(), attemptId: a.attemptId, sid: "PA_new", hash: "applied" });
    expect(m.state.attempts[a.attemptId].appliedGrant).toBe("applied");
  });

  it("orders sessions by when their listings were asked for when LiveKit never says when they joined", () => {
    const m = new Meeting();
    const a = m.admitted(ada);
    const t0 = m.now;
    m.listed([{ identity: a.identity, sid: "PA_1", joinedAt: null, standard: true }], t0);
    m.now += 10_000;
    m.listed([{ identity: a.identity, sid: "PA_2", joinedAt: null, standard: true }], m.now);
    m.listed([{ identity: a.identity, sid: "PA_1", joinedAt: null, standard: true }], t0 + 5_000);
    expect(m.state.attempts[a.attemptId].sid).toBe("PA_2");

    // A session the room has since moved on to is taken from the next report.
    m.now += 10_000;
    m.listed([{ identity: a.identity, sid: "PA_3", joinedAt: null, standard: true }], m.now);
    expect(m.state.attempts[a.attemptId].sid).toBe("PA_3");
  });
});

describe("a meeting nobody joined", () => {
  it("is discarded, not finalized, when it reaches its duration limit", () => {
    const m = new Meeting({ joinPolicy: "approval_required", maxDurationMs: 30 * 60_000 });
    // Someone keeps asking and nobody admits them, so it never empties.
    for (let i = 0; m.state.meta.phase !== "ended"; i += 1) {
      m.join({ kind: "user", userId: `asker-${i}`, spaceRole: "visitor" });
      m.advance(ADMISSION_PENDING_TTL_MS);
    }
    expect(m.state.meta).toMatchObject({ phase: "ended", endReason: "discarded", firstJoinedAt: null });
    expect(kinds(m.plan())).toContain("meeting.discard");
    expect(kinds(m.plan())).not.toContain("meeting.finalize");
  });

  it("is discarded however it is ended", () => {
    const m = new Meeting();
    m.admitted(host);
    m.apply({ kind: "end", subject: host, reason: "host" });
    expect(m.state.meta.endReason).toBe("discarded");
  });
});
