import { describe, expect, it } from "vitest";
import { PARTICIPANT_ATTRIBUTE } from "@/modules/meetings/contract/live-state";
import { grantFor, roleOf, type MeetingSnapshot } from "./model";
import type { Subject } from "./protocol";
import { Meeting } from "./step-test-support";

// Who hosts: the Space's owner and admins. While none of them is in the
// meeting, the organizer of the scheduled meeting it fulfils stands in if they
// are in it, else whoever started it — as long as they belong to the Space.
// Whoever will host is let in as a host.

const admin: Subject = { kind: "user", userId: "admin", spaceRole: "admin" };
const chen: Subject = { kind: "user", userId: "chen", spaceRole: "member" };
const dana: Subject = { kind: "user", userId: "dana", spaceRole: "member" };
const eli: Subject = { kind: "user", userId: "eli", spaceRole: "member" };

function sharedMeeting(overrides: Partial<MeetingSnapshot> = {}) {
  return new Meeting({ spaceKind: "shared", allowGuests: false, startedByUserId: "chen", ...overrides });
}

const roleIn = (m: Meeting, admissionId: string) => roleOf(m.state, m.state.admissions[admissionId]);

describe("who hosts", () => {
  it("lets the starter stand in until a Space admin arrives, and hands back when they leave", () => {
    const m = sharedMeeting();
    const c = m.admitted(chen);
    m.joined(c.identity);
    expect(roleIn(m, c.admissionId)).toBe("host");

    const a = m.admitted(admin);
    m.joined(a.identity);
    expect(roleIn(m, a.admissionId)).toBe("host");
    expect(roleIn(m, c.admissionId)).toBe("attendee");

    m.apply({ kind: "leave", subject: admin, attemptId: a.attemptId });
    expect(roleIn(m, c.admissionId)).toBe("host");
  });

  it("makes the scheduled meeting's organizer the stand-in once they are in it", () => {
    const m = sharedMeeting({ organizerUserId: "dana" });
    const c = m.admitted(chen);
    m.joined(c.identity);
    // The organizer is not here yet: the starter stands in meanwhile.
    expect(roleIn(m, c.admissionId)).toBe("host");

    const d = m.admitted(dana);
    m.joined(d.identity);
    expect(roleIn(m, d.admissionId)).toBe("host");
    expect(roleIn(m, c.admissionId)).toBe("attendee");

    m.apply({ kind: "leave", subject: dana, attemptId: d.attemptId });
    expect(roleIn(m, c.admissionId)).toBe("host");
  });

  it("keeps the role where it is through a dropped connection", () => {
    const m = sharedMeeting();
    const c = m.admitted(chen);
    m.joined(c.identity);
    const a = m.admitted(admin);
    m.joined(a.identity);

    // The admin's connection drops; their seat holds until the absence grace
    // runs out, so the starter does not flicker into the role.
    m.apply({ kind: "participantLeft", identity: a.identity, sid: m.state.attempts[a.attemptId].sid, at: m.now });
    expect(roleIn(m, c.admissionId)).toBe("attendee");
  });

  it("is no longer the stand-in's once they have left", () => {
    const m = sharedMeeting();
    const c = m.admitted(chen);
    m.joined(c.identity);
    const d = m.admitted(dana);
    m.joined(d.identity);
    m.apply({ kind: "setModerator", subject: chen, identity: d.identity, moderator: true });

    m.apply({ kind: "leave", subject: chen, attemptId: c.attemptId });
    expect(roleIn(m, c.admissionId)).toBe("attendee");
    // So a moderator can keep them out, as they could anyone who attends.
    m.apply({ kind: "removeParticipant", subject: dana, admissionId: c.admissionId });
    expect(m.state.admissions[c.admissionId].status).toBe("revoked");
  });

  it("gives the stand-in a host's powers from their seat", () => {
    const m = sharedMeeting();
    const c = m.admitted(chen);
    m.joined(c.identity);
    const d = m.admitted(dana);
    m.joined(d.identity);

    m.apply({ kind: "setModerator", subject: chen, identity: d.identity, moderator: true });
    expect(roleIn(m, d.admissionId)).toBe("moderator");
    // Only a host removes a moderator; the stand-in is one.
    m.apply({ kind: "removeParticipant", subject: chen, admissionId: d.admissionId });
    expect(m.state.admissions[d.admissionId].status).toBe("revoked");
    m.apply({ kind: "renameMeeting", subject: chen, title: "Study group", expectedTitle: null });
    expect(m.state.meta.title).toBe("Study group");
    m.apply({ kind: "end", subject: chen, reason: "host" });
    expect(m.state.meta.phase).not.toBe("live");
  });

  it("takes the stand-in's powers away while a Space admin is present", () => {
    const m = sharedMeeting();
    const c = m.admitted(chen);
    m.joined(c.identity);
    const a = m.admitted(admin);
    m.joined(a.identity);

    expect(m.refuse({ kind: "renameMeeting", subject: chen, title: "Mine", expectedTitle: null }).code).toBe("FORBIDDEN");
    expect(m.refuse({ kind: "setJoinPolicy", subject: chen, joinPolicy: "closed" }).code).toBe("FORBIDDEN");
    expect(m.refuse({ kind: "end", subject: chen, reason: "host" }).code).toBe("FORBIDDEN");
  });

  it("hides an attendee's hand while they stand in, and keeps their board grant for after", () => {
    const m = sharedMeeting();
    const c = m.admitted(chen);
    m.joined(c.identity);
    const a = m.admitted(admin);
    m.joined(a.identity);
    m.apply({ kind: "raiseHand", subject: chen, attemptId: c.attemptId, raiseId: "r1" });
    m.apply({ kind: "grantBoardEdit", subject: admin, principal: { type: "user", id: "chen" } });
    const shownHand = () => grantFor(m.state, m.state.admissions[c.admissionId]).attributes[PARTICIPANT_ATTRIBUTE.hand];

    m.apply({ kind: "leave", subject: admin, attemptId: a.attemptId });
    expect(roleIn(m, c.admissionId)).toBe("host");
    expect(shownHand()).toBe("");

    m.joined(m.admitted(admin).identity);
    expect(roleIn(m, c.admissionId)).toBe("attendee");
    expect(shownHand()).not.toBe("");
    expect(m.state.admissions[c.admissionId].boardEdit).toBe(true);
  });

  it("never lets someone outside the Space stand in", () => {
    // A personal meeting whose recorded starter is not its owner: the guard,
    // not the usual path, is what keeps them from hosting.
    const m = new Meeting({ startedByUserId: "ada" });
    const ada: Subject = { kind: "user", userId: "ada", spaceRole: "visitor" };
    const visitor = m.admitted(ada);
    m.joined(visitor.identity);
    expect(roleIn(m, visitor.admissionId)).toBe("attendee");
  });
});

describe("letting the host in", () => {
  it("lets the organizer past approval, and leaves everyone else for them to admit", () => {
    const m = sharedMeeting({ startedByUserId: "dana", organizerUserId: "dana", joinPolicy: "approval_required" });
    const d = m.admitted(dana);
    m.joined(d.identity);
    expect(roleIn(m, d.admissionId)).toBe("host");

    const waiting = m.join(eli);
    expect(waiting.kind).toBe("waiting");
    if (waiting.kind !== "waiting") return;
    m.apply({ kind: "decideAdmission", subject: dana, admissionId: waiting.admissionId, approve: true });
    expect(m.state.admissions[waiting.admissionId].status).toBe("approved");
  });

  it("lets the starter past approval when the organizer has not come", () => {
    const m = sharedMeeting({ organizerUserId: "dana", joinPolicy: "approval_required" });
    expect(m.join(chen).kind).toBe("admitted");
    // Someone who would not host waits, as before.
    expect(m.join(eli).kind).toBe("waiting");
  });

  it("lets whoever will host into a closed meeting", () => {
    const m = sharedMeeting({ organizerUserId: "dana", joinPolicy: "closed" });
    m.joined(m.admitted(chen).identity);
    expect(m.refuse(joinOf(m, eli)).code).toBe("MEETING_CLOSED");
    expect(m.join(dana).kind).toBe("admitted");
  });

  it("keeps a seat free for an admin, which the stand-in may take but attendees may not", () => {
    const m = sharedMeeting({ maxParticipants: 3 });
    const c = m.admitted(chen);
    m.joined(c.identity);
    m.joined(m.admitted(dana).identity);
    // Two of three seats are taken and no admin is here: the last is kept free.
    expect(m.refuse(joinOf(m, eli)).code).toBe("PLAN_LIMIT_REACHED");

    // The stand-in steps out, an attendee takes their seat, and the stand-in
    // still gets back in.
    m.apply({ kind: "leave", subject: chen, attemptId: c.attemptId });
    m.joined(m.admitted(eli).identity);
    expect(m.join(chen).kind).toBe("admitted");
  });
});

describe("a Space admin outside the meeting", () => {
  it("may end or rename it, but runs it only from a seat", () => {
    const m = sharedMeeting();
    const c = m.admitted(chen);
    m.joined(c.identity);

    m.apply({ kind: "renameMeeting", subject: admin, title: "Board review", expectedTitle: null });
    expect(m.state.meta.title).toBe("Board review");
    expect(m.refuse({ kind: "setModerator", subject: admin, identity: c.identity, moderator: true }).code).toBe("FORBIDDEN");
    expect(m.refuse({ kind: "listPending", subject: admin }).code).toBe("FORBIDDEN");

    m.apply({ kind: "end", subject: admin, reason: "host" });
    expect(m.state.meta.phase).not.toBe("live");
  });
});

/** The join a refusal is asked of: what `Meeting.join` would send, without sending it. */
function joinOf(m: Meeting, subject: Subject) {
  const seq = Object.keys(m.state.admissions).length + 100;
  return {
    kind: "join" as const,
    subject,
    admissionId: null,
    clientAttemptId: `client-refused-${seq}`,
    displayName: subject.kind === "user" ? subject.userId : "Guest",
    captionLanguage: "en-US",
    replacesAttemptId: null,
    newAdmissionId: `admission_refused_${seq}`,
    newAttemptId: `connection_refused_${seq}`,
    newGuestSecretHash: null,
    guestNetworkKey: null,
  };
}
