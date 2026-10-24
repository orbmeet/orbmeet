import { describe, expect, it } from "vitest";
import { PARTICIPANT_ATTRIBUTE } from "@/modules/meetings/contract/live-state";
import { AUTHORITY_CHECK_MS, grantFor } from "./model";

import type { Subject } from "./protocol";
import type { SurfaceFocus } from "./model";
import { host, ada, bob, Meeting } from "./step-test-support";

describe("moderation state is server-owned", () => {
  it("shows a raised hand as an attribute until a moderator resolves it", () => {
    const m = new Meeting();
    const h = m.admitted(host);
    const a = m.admitted(ada);
    m.joined(h.identity);
    m.joined(a.identity);
    m.apply({ kind: "raiseHand", subject: ada, attemptId: a.attemptId, raiseId: "r1" });
    const grant = m.plan().find((e) => e.kind === "livekit.grant" && e.identity === a.identity);
    expect(grant && grant.kind === "livekit.grant" && grant.grant.attributes["orbmeet.hand"]).toMatch(/^r1:/);

    m.apply({ kind: "resolveHand", subject: host, admissionId: a.admissionId });
    expect(m.state.admissions[a.admissionId].hand).toBeNull();
  });

  it("re-applies the current grant after a full reconnect falls back to the token's", () => {
    const m = new Meeting();
    m.joined(m.admitted(host).identity);
    const a = m.admitted(ada);
    m.joined(a.identity);
    m.apply({ kind: "setModerator", subject: host, identity: a.identity, moderator: true });
    const grant = m.plan().find((e) => e.kind === "livekit.grant" && e.identity === a.identity);
    if (grant?.kind !== "livekit.grant") throw new Error("expected a grant");
    m.apply({ kind: "grantApplied", placement: m.here(), attemptId: a.attemptId, sid: grant.sid, hash: grant.hash });
    expect(m.plan()).not.toContainEqual(expect.objectContaining({ kind: "livekit.grant" }));

    // A new session was admitted on the join token, which holds the attendee grant.
    m.apply({ kind: "participantJoined", identity: a.identity, sid: "sid-reconnected", joinedAt: null, at: m.now });
    expect(m.state.attempts[a.attemptId].sid).toBe("sid-reconnected");
    const again = m.plan().find((e) => e.kind === "livekit.grant" && e.identity === a.identity);
    expect(again).toEqual(expect.objectContaining({ sid: "sid-reconnected", hash: grant.hash }));

    // A result for the session that is gone does not count for the new one.
    m.apply({ kind: "grantApplied", placement: m.here(), attemptId: a.attemptId, sid: grant.sid, hash: grant.hash });
    expect(m.plan()).toContainEqual(expect.objectContaining({ kind: "livekit.grant", identity: a.identity }));
  });

  it("grants screen share to an attendee and refuses the flag for a moderator", () => {
    const m = new Meeting();
    const h = m.admitted(host);
    const a = m.admitted(ada);
    m.joined(h.identity);
    m.joined(a.identity);
    m.apply({ kind: "requestScreenShare", subject: ada, attemptId: a.attemptId });
    m.apply({ kind: "decideScreenShare", subject: host, admissionId: a.admissionId, allow: true });
    expect(m.state.admissions[a.admissionId].screenShare).toBe("granted");
    expect(m.refuse({ kind: "decideScreenShare", subject: host, admissionId: h.admissionId, allow: false }).code)
      .toBe("VALIDATION_ERROR");
  });

  it("revokes a removed member everywhere", () => {
    const m = new Meeting({ spaceKind: "shared", allowGuests: false });
    const member: Subject = { kind: "user", userId: "ada", spaceRole: "member" };
    const a = m.admitted(member);
    m.joined(a.identity);
    m.apply({ kind: "authority", userId: "ada", spaceRole: "visitor", reason: "space_membership_removed", readAt: m.now });
    expect(m.state.admissions[a.admissionId].status).toBe("revoked");
    expect(m.plan()).toContainEqual(expect.objectContaining({ kind: "livekit.remove", identity: a.identity }));
  });

  it("re-reads seated users' Space authority on its own, so a missed push still lands", () => {
    const m = new Meeting({ spaceKind: "shared", allowGuests: false });
    const member: Subject = { kind: "user", userId: "ada", spaceRole: "member" };
    const h = m.admitted(host);
    const a = m.admitted(member);
    m.joined(h.identity);
    m.joined(a.identity);
    const checks = () => m.plan().filter((effect) => effect.kind === "space.authority");
    expect(checks()).toEqual([expect.objectContaining({ userIds: ["ada", "host"] })]);

    m.apply({
      kind: "effectSucceeded",
      key: "authority",
      result: {
        kind: "authorityChecked", requestedAt: m.now,
        roles: [{ userId: "ada", spaceRole: "visitor" }, { userId: "host", spaceRole: "admin" }],
      },
    });
    expect(m.state.admissions[a.admissionId].status).toBe("revoked");
    expect(m.plan()).toContainEqual(expect.objectContaining({ kind: "livekit.remove", identity: a.identity }));
    expect(checks()).toEqual([]);

    m.advance(AUTHORITY_CHECK_MS);
    expect(checks()).toEqual([expect.objectContaining({ userIds: ["host"] })]);
  });
});

describe("removing a participant", () => {
  const guest: Subject = { kind: "guest", admissionId: null, verified: false };

  it("takes an attendee out of the room and keeps the user out", () => {
    const m = new Meeting();
    m.joined(m.admitted(host).identity);
    const a = m.admitted(ada);
    m.joined(a.identity);

    m.apply({ kind: "removeParticipant", subject: host, admissionId: a.admissionId });
    expect(m.state.admissions[a.admissionId]).toMatchObject({ status: "revoked", decidedByUserId: "host" });
    expect(m.state.attempts[a.attemptId].endedAt).not.toBeNull();
    expect(m.plan()).toContainEqual(expect.objectContaining({ kind: "livekit.remove", identity: a.identity }));

    // A fresh join is a new admission, and it is refused before one is made.
    const refused = m.refuse({
      kind: "join", subject: ada, admissionId: null, clientAttemptId: "ada-again", displayName: "ada",
      captionLanguage: "en", replacesAttemptId: null, newAdmissionId: "adm-again", newAttemptId: "att-again",
      newGuestSecretHash: null, guestNetworkKey: null,
    });
    expect(refused).toMatchObject({ code: "MEETING_ADMISSION_DENIED", message: "A moderator removed you from this meeting." });
    // Anyone else still joins.
    expect(m.join(bob).kind).toBe("admitted");
  });

  it("bars a removed guest's network for guests only", () => {
    const m = new Meeting();
    m.joined(m.admitted(host).identity);
    const g = m.admitted(guest, { guestSecretHash: "first-cookie", guestNetworkKey: "network-a" });
    m.joined(g.identity);
    m.apply({ kind: "removeParticipant", subject: host, admissionId: g.admissionId });

    const again = {
      kind: "join" as const, subject: guest, admissionId: null, clientAttemptId: "new-cookie-tab", displayName: "Guest",
      captionLanguage: "en", replacesAttemptId: null, newAdmissionId: "adm-new", newAttemptId: "att-new",
      newGuestSecretHash: "cleared-cookie",
    };
    expect(m.refuse({ ...again, guestNetworkKey: "network-a" }).code).toBe("MEETING_ADMISSION_DENIED");
    // Another network, or a signed-in user on the same one, is not barred.
    expect(m.join(guest, { guestSecretHash: "other-guest", guestNetworkKey: "network-b" }).kind).toBe("admitted");
    expect(m.join(ada).kind).toBe("admitted");
  });

  it("does not bar every guest when the removed guest's address was unknown", () => {
    const m = new Meeting();
    m.joined(m.admitted(host).identity);
    const g = m.admitted(guest, { guestSecretHash: "first-cookie" });
    m.apply({ kind: "removeParticipant", subject: host, admissionId: g.admissionId });
    expect(m.state.barred?.guestNetworks).toEqual([]);
    expect(m.join(guest, { guestSecretHash: "second-cookie" }).kind).toBe("admitted");
  });

  it("lets a moderator remove attendees but only a host remove a moderator, and nobody a host", () => {
    const m = new Meeting();
    const h = m.admitted(host);
    m.joined(h.identity);
    const a = m.admitted(ada);
    m.joined(a.identity);
    const b = m.admitted(bob);
    m.joined(b.identity);
    const carol: Subject = { kind: "user", userId: "carol", spaceRole: "visitor" };
    const c = m.admitted(carol);
    m.joined(c.identity);
    m.apply({ kind: "setModerator", subject: host, identity: a.identity, moderator: true });
    m.apply({ kind: "setModerator", subject: host, identity: b.identity, moderator: true });

    expect(m.refuse({ kind: "removeParticipant", subject: ada, admissionId: h.admissionId }).code).toBe("FORBIDDEN");
    expect(m.refuse({ kind: "removeParticipant", subject: ada, admissionId: b.admissionId }).code).toBe("FORBIDDEN");
    expect(m.refuse({ kind: "removeParticipant", subject: ada, admissionId: a.admissionId }).code)
      .toBe("VALIDATION_ERROR");
    expect(m.refuse({ kind: "removeParticipant", subject: carol, admissionId: b.admissionId }).code)
      .toBe("FORBIDDEN");

    m.apply({ kind: "removeParticipant", subject: ada, admissionId: c.admissionId });
    expect(m.state.admissions[c.admissionId].status).toBe("revoked");
    m.apply({ kind: "removeParticipant", subject: host, admissionId: b.admissionId });
    expect(m.state.admissions[b.admissionId]).toMatchObject({ status: "revoked", moderator: false });
  });

  it("revokes every admission a guest holds from a barred network, so none is a way back in", () => {
    const m = new Meeting();
    m.joined(m.admitted(host).identity);
    const first = m.admitted(guest, { guestSecretHash: "cookie-a", guestNetworkKey: "network-a" });
    m.joined(first.identity);
    const second = m.admitted(guest, { guestSecretHash: "cookie-b", guestNetworkKey: "network-a" });
    m.apply({ kind: "leave", subject: { ...guest, admissionId: second.admissionId, verified: true }, attemptId: second.attemptId });

    m.apply({ kind: "removeParticipant", subject: host, admissionId: first.admissionId });
    expect(m.state.admissions[second.admissionId].status).toBe("revoked");
    const rejoin = m.refuse({
      kind: "join", subject: { kind: "guest", admissionId: second.admissionId, verified: true },
      admissionId: second.admissionId, clientAttemptId: "back", displayName: "Guest", captionLanguage: "en",
      replacesAttemptId: null, newAdmissionId: "adm-back", newAttemptId: "att-back", newGuestSecretHash: null,
      guestNetworkKey: "network-a",
    });
    expect(rejoin.code).toBe("MEETING_ADMISSION_DENIED");
  });

  it("turns away an attendee guest's existing admission joining from a barred network", () => {
    const m = new Meeting();
    m.joined(m.admitted(host).identity);
    const removed = m.admitted(guest, { guestSecretHash: "cookie-a", guestNetworkKey: "network-a" });
    const elsewhere = m.admitted(guest, { guestSecretHash: "cookie-b", guestNetworkKey: "network-b" });
    m.apply({ kind: "removeParticipant", subject: host, admissionId: removed.admissionId });
    const subject: Subject = { kind: "guest", admissionId: elsewhere.admissionId, verified: true };
    expect(m.refuse({
      kind: "join", subject, admissionId: elsewhere.admissionId, clientAttemptId: "moved", displayName: "Guest",
      captionLanguage: "en", replacesAttemptId: null, newAdmissionId: "adm-moved", newAttemptId: "att-moved",
      newGuestSecretHash: null, guestNetworkKey: "network-a",
    }).code).toBe("MEETING_ADMISSION_DENIED");
  });

  it("leaves a guest moderator on a barred network in, and lets them reconnect", () => {
    const m = new Meeting();
    m.joined(m.admitted(host).identity);
    const trusted = m.admitted(guest, { guestSecretHash: "cookie-m", guestNetworkKey: "network-a" });
    m.joined(trusted.identity);
    m.apply({ kind: "setModerator", subject: host, identity: trusted.identity, moderator: true });
    const removed = m.admitted(guest, { guestSecretHash: "cookie-a", guestNetworkKey: "network-a" });
    m.apply({ kind: "removeParticipant", subject: host, admissionId: removed.admissionId });

    expect(m.state.admissions[trusted.admissionId].status).toBe("approved");
    const subject: Subject = { kind: "guest", admissionId: trusted.admissionId, verified: true };
    expect(m.admitted(subject, { admissionId: trusted.admissionId, guestNetworkKey: "network-a" }).role)
      .toBe("moderator");
  });

  it("judges a removal by the role the person holds now, not by an admission already revoked", () => {
    const m = new Meeting({ spaceKind: "shared" });
    m.joined(m.admitted(host).identity);
    const member: Subject = { kind: "user", userId: "ada", spaceRole: "member" };
    const old = m.admitted(member);
    m.joined(old.identity);
    m.apply({ kind: "authority", userId: "ada", spaceRole: "visitor", reason: "space_membership_removed", readAt: m.now });
    m.now += 1;
    const current = m.admitted(member);
    m.joined(current.identity);
    m.apply({ kind: "setModerator", subject: host, identity: current.identity, moderator: true });
    const carol: Subject = { kind: "user", userId: "carol", spaceRole: "member" };
    const c = m.admitted(carol);
    m.joined(c.identity);
    m.apply({ kind: "setModerator", subject: host, identity: c.identity, moderator: true });

    expect(m.refuse({ kind: "removeParticipant", subject: carol, admissionId: old.admissionId }).code)
      .toBe("FORBIDDEN");
    expect(m.state.admissions[current.admissionId].status).toBe("approved");
    // A host may, and the bar then takes the live admission too.
    m.apply({ kind: "removeParticipant", subject: host, admissionId: old.admissionId });
    expect(m.state.admissions[current.admissionId].status).toBe("revoked");
  });

  it("refuses a request still waiting: that is a denial", () => {
    const m = new Meeting({ joinPolicy: "approval_required" });
    m.joined(m.admitted(host).identity);
    const waiting = m.join(ada);
    if (waiting.kind !== "waiting") throw new Error(waiting.kind);
    expect(m.refuse({ kind: "removeParticipant", subject: host, admissionId: waiting.admissionId }).code)
      .toBe("NOT_FOUND");
  });
});

describe("Space authority over time", () => {
  const promoted: Subject = { kind: "user", userId: "ada", spaceRole: "admin" };

  it("does not apply a periodic read older than a change pushed since", () => {
    const m = new Meeting();
    const a = m.admitted(ada);
    m.joined(a.identity);
    const check = m.plan().find((effect) => effect.kind === "space.authority");
    if (check?.kind !== "space.authority") throw new Error("expected an authority check");
    m.now += 1_000;
    m.apply({ kind: "authority", userId: "ada", spaceRole: "admin", reason: "role_changed", readAt: m.now });
    m.now += 1_000;
    m.apply({
      kind: "effectSucceeded",
      key: "authority",
      result: { kind: "authorityChecked", requestedAt: check.requestedAt, roles: [{ userId: "ada", spaceRole: "visitor" }] },
    });
    expect(m.state.admissions[a.admissionId]).toMatchObject({ spaceRole: "admin", status: "approved" });
  });

  it("applies a read requested after the last change", () => {
    const m = new Meeting({ spaceKind: "shared" });
    const member: Subject = { kind: "user", userId: "ada", spaceRole: "member" };
    const a = m.admitted(member);
    m.joined(a.identity);
    m.now += 1_000;
    m.apply({
      kind: "effectSucceeded",
      key: "authority",
      result: { kind: "authorityChecked", requestedAt: m.now, roles: [{ userId: "ada", spaceRole: "visitor" }] },
    });
    expect(m.state.admissions[a.admissionId].status).toBe("revoked");
  });

  it("hides an attendee's raised hand and screen-share request while their Space makes them host", () => {
    const m = new Meeting();
    const a = m.admitted(ada);
    m.joined(a.identity);
    m.apply({ kind: "raiseHand", subject: ada, attemptId: a.attemptId, raiseId: "r1" });
    m.apply({ kind: "requestScreenShare", subject: ada, attemptId: a.attemptId });
    const shown = () => grantFor(m.state, m.state.admissions[a.admissionId]).attributes;
    m.now += 1;
    m.apply({ kind: "authority", userId: "ada", spaceRole: promoted.spaceRole, reason: "role_changed", readAt: m.now });
    expect(shown()).toMatchObject({ [PARTICIPANT_ATTRIBUTE.hand]: "", [PARTICIPANT_ATTRIBUTE.screenShare]: "" });

    // Demoted again, they are an attendee with what they had asked for.
    m.now += 1;
    m.apply({ kind: "authority", userId: "ada", spaceRole: "visitor", reason: "role_changed", readAt: m.now });
    expect(shown()[PARTICIPANT_ATTRIBUTE.hand]).not.toBe("");
    expect(shown()[PARTICIPANT_ATTRIBUTE.screenShare]).toBe("requested");
  });
});

describe("Space authority read order", () => {
  it("does not let a read taken before a demotion land after it", () => {
    const m = new Meeting({ spaceKind: "shared" });
    const manager: Subject = { kind: "user", userId: "ada", spaceRole: "admin" };
    const a = m.admitted(manager);
    m.joined(a.identity);
    const staleReadAt = m.now;
    m.now += 1_000;
    m.apply({ kind: "authority", userId: "ada", spaceRole: "member", reason: "space_role_changed", readAt: m.now });
    m.now += 1_000;
    // A request whose authority was read before the demotion arrives last.
    m.apply({ kind: "authority", userId: "ada", spaceRole: "admin", reason: "space_membership_removed", readAt: staleReadAt });
    expect(m.state.admissions[a.admissionId]).toMatchObject({ spaceRole: "member", status: "approved" });
    expect(m.refuse({ kind: "end", subject: { ...manager, spaceRole: "member" }, reason: "host" }).code).toBe("FORBIDDEN");
  });
});

describe("what a removal keeps out", () => {
  it("says whether it barred an account, a guest's network, or nothing", () => {
    const m = new Meeting();
    m.joined(m.admitted(host).identity);
    const user = m.admitted(ada);
    const known = m.admitted({ kind: "guest", admissionId: null, verified: false }, { guestNetworkKey: "net-1" });
    const unknown = m.admitted({ kind: "guest", admissionId: null, verified: false }, { guestSecretHash: "hash-2" });
    const remove = (admissionId: string) =>
      m.apply({ kind: "removeParticipant", subject: host, admissionId }).reply;
    expect(remove(user.admissionId)).toEqual({ kind: "removed", keptOut: "account" });
    expect(remove(known.admissionId)).toEqual({ kind: "removed", keptOut: "network" });
    expect(remove(unknown.admissionId)).toEqual({ kind: "removed", keptOut: "none" });
  });
});

describe("board edit grants", () => {
  const board: SurfaceFocus = { usageId: "usage_a", whiteboardId: "wb_a", syncRoomId: "room_a" };
  const guest: Subject = { kind: "guest", admissionId: null, verified: false };
  const authorityFor = (m: Meeting, admissionId: string) =>
    m.plan().find((effect) => effect.kind === "whiteboard.authority" && effect.admissionId === admissionId);

  function presenting() {
    const m = new Meeting();
    const h = m.admitted(host);
    m.joined(h.identity);
    const a = m.admitted(ada);
    m.joined(a.identity);
    m.apply({ kind: "present", subject: host, focus: board });
    for (const admission of Object.values(m.state.admissions)) {
      const effect = authorityFor(m, admission.id);
      if (effect?.kind === "whiteboard.authority") {
        m.apply({ kind: "whiteboardAuthorityApplied", admissionId: admission.id, hash: effect.hash });
      }
    }
    return { m, h, a };
  }

  it("lets a moderator grant an attendee board editing, and tells the presented board's room", () => {
    const { m, a } = presenting();
    expect(authorityFor(m, a.admissionId)).toBeUndefined();

    m.apply({ kind: "grantBoardEdit", subject: host, principal: { type: "user", id: "ada" } });

    expect(m.state.admissions[a.admissionId].boardEdit).toBe(true);
    expect(authorityFor(m, a.admissionId)).toMatchObject({
      kind: "whiteboard.authority",
      syncRoomId: "room_a",
      principalKey: "user:ada",
    });
  });

  it("refuses a grant from an attendee, and a target who is not admitted", () => {
    const { m } = presenting();
    m.joined(m.admitted(bob).identity);
    expect(m.refuse({ kind: "grantBoardEdit", subject: bob, principal: { type: "user", id: "ada" } }).code)
      .toBe("FORBIDDEN");
    expect(m.refuse({ kind: "grantBoardEdit", subject: host, principal: { type: "user", id: "carol" } }).code)
      .toBe("VALIDATION_ERROR");
  });

  it("names a guest by their admission, never a user's admission", () => {
    const { m, a } = presenting();
    const g = m.admitted(guest);
    m.joined(g.identity);

    m.apply({ kind: "grantBoardEdit", subject: host, principal: { type: "guest_admission", id: g.admissionId } });
    expect(m.state.admissions[g.admissionId].boardEdit).toBe(true);
    expect(m.refuse({ kind: "grantBoardEdit", subject: host, principal: { type: "guest_admission", id: a.admissionId } }).code)
      .toBe("VALIDATION_ERROR");
  });

  it("has nothing to grant a moderator, outlives a promotion, and ends with the admission", () => {
    const { m, a } = presenting();
    m.apply({ kind: "setModerator", subject: host, identity: a.identity, moderator: true });
    m.apply({ kind: "grantBoardEdit", subject: host, principal: { type: "user", id: "ada" } });
    expect(m.state.admissions[a.admissionId].boardEdit).toBe(false);

    m.apply({ kind: "setModerator", subject: host, identity: a.identity, moderator: false });
    m.apply({ kind: "grantBoardEdit", subject: host, principal: { type: "user", id: "ada" } });
    // A grant an attendee holds is still theirs after a spell as moderator.
    m.apply({ kind: "setModerator", subject: host, identity: a.identity, moderator: true });
    m.apply({ kind: "setModerator", subject: host, identity: a.identity, moderator: false });
    expect(m.state.admissions[a.admissionId].boardEdit).toBe(true);

    m.apply({ kind: "removeParticipant", subject: host, admissionId: a.admissionId });
    expect(m.state.admissions[a.admissionId]).toMatchObject({ status: "revoked", boardEdit: false });
  });
});

describe("renaming the meeting", () => {
  it("lets a manager rename it, refuses everyone else, and answers a repeat", () => {
    const m = new Meeting();
    m.joined(m.admitted(host).identity);
    const a = m.admitted(ada);
    m.joined(a.identity);

    expect(m.refuse({ kind: "renameMeeting", subject: ada, title: "Mine", expectedTitle: null }).code).toBe("FORBIDDEN");
    m.apply({ kind: "renameMeeting", subject: host, title: "Standup", expectedTitle: null });
    expect(m.state.meta.title).toBe("Standup");
    // The same rename again, as a retry would send it.
    m.apply({ kind: "renameMeeting", subject: host, title: "Standup", expectedTitle: null });
    expect(m.state.meta.title).toBe("Standup");
  });

  it("refuses a rename made against a title that has changed since", () => {
    const m = new Meeting();
    m.joined(m.admitted(host).identity);
    m.apply({ kind: "renameMeeting", subject: host, title: "Standup", expectedTitle: null });
    expect(m.refuse({ kind: "renameMeeting", subject: host, title: "Retro", expectedTitle: null }).code).toBe("CONFLICT");
    expect(m.state.meta.title).toBe("Standup");
  });

  it("does not rename a meeting that has ended", () => {
    const m = new Meeting();
    m.joined(m.admitted(host).identity);
    m.apply({ kind: "end", subject: host, reason: "host" });
    expect(m.refuse({ kind: "renameMeeting", subject: host, title: "Late", expectedTitle: null }).code).toBe("NOT_FOUND");
  });
});
