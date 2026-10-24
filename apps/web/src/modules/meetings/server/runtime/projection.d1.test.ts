import { beforeEach, describe, expect, it } from "vitest";
import { meetingLinks, meetings, users } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";
import { initialState, type MeetingState } from "./model";
import { projectMeetingChanges } from "./projection.server";
import type { Input, Subject } from "./protocol";
import { step } from "./step";

let db: TestDb;
// Past and second-aligned: CHECK constraints compare against createdAt.
const T0 = Math.floor((Date.now() - 60 * 60_000) / 1000) * 1000;

beforeEach(async () => {
  db = await createTestDb();
  const at = new Date(T0);
  await db.insert(users).values(["host", "ada"].map((id) => ({
    id,
    name: id,
    email: `${id}@example.com`,
    normalizedEmail: `${id}@example.com`,
    plan: "free" as const,
    role: "user" as const,
    createdAt: at,
    updatedAt: at,
  })));
  await seedPersonalSpace(db, "host", { now: at });
  await db.insert(meetingLinks).values({
    id: "link_1", code: "abc-defg-hij", spaceId: "host_space", spaceKind: "personal",
    allowGuests: true, createdAt: at, updatedAt: at,
  });
  await db.insert(meetings).values({
    id: "meeting_1", meetingLinkId: "link_1", spaceId: "host_space", spaceKind: "personal",
    startedByUserId: "host", status: "open", billingPrincipalType: "user", billingPrincipalId: "host",
    billingPlan: "free", allowGuests: true, recordingEnabled: false, joinPolicy: "approval_required",
    startedAt: at, updatedAt: at,
  });
});

/** Drives the core the way its MeetingRoom does, projecting what changed to D1 with every input. */
class Projected {
  state: MeetingState = initialState({
    meetingId: "meeting_1", title: null, spaceId: "host_space", spaceKind: "personal", allowGuests: true,
    startedByUserId: "host", organizerUserId: null, startedAt: T0, joinPolicy: "approval_required", maxParticipants: null,
    recordingEnabled: false, transcription: true, maxDurationMs: null, nodeId: "node-a", firstJoinedAt: null,
  }, T0);
  now = T0 + 1_000;
  private seq = 0;

  private projected: MeetingState | null = null;
  statements = 0;

  async apply(input: Input) {
    const { state, outcome } = step(structuredClone(this.state), input, this.now);
    const [first, ...rest] = projectMeetingChanges(db, this.projected, state, this.now);
    if (first) await db.batch([first, ...rest]);
    this.statements = rest.length + (first ? 1 : 0);
    this.state = state;
    this.projected = structuredClone(state);
    this.now += 1_000;
    return outcome.reply!;
  }

  async join(subject: Subject, admissionId: string | null = null) {
    this.seq += 1;
    return this.apply({
      kind: "join", subject, admissionId, clientAttemptId: `c${this.seq}`,
      displayName: subject.kind === "user" ? subject.userId : "Guest", captionLanguage: "en-US",
      replacesAttemptId: null, newAdmissionId: `admission_${this.seq}`, newAttemptId: `connection_${this.seq}`,
      newGuestSecretHash: subject.kind === "guest" ? "hash".repeat(16) : null,
      guestNetworkKey: null,
    });
  }
}

const host: Subject = { kind: "user", userId: "host", spaceRole: "admin" };
const ada: Subject = { kind: "user", userId: "ada", spaceRole: "visitor" };
const guest: Subject = { kind: "guest", admissionId: null, verified: false };

const admissionRow = (id: string) => db.query.meetingAdmissions.findFirst({ where: { id } });
const connectionRow = (id: string) => db.query.meetingConnections.findFirst({ where: { id } });

describe("projectMeetingChanges", () => {
  it("keeps D1 matching the room through a whole meeting, within every CHECK", async () => {
    const m = new Projected();
    const hostReply = await m.join(host);
    if (hostReply.kind !== "admitted") throw new Error(hostReply.kind);
    const hostAttempt = hostReply.participant;
    await m.apply({ kind: "participantJoined", identity: hostAttempt.identity, sid: "PA_h", joinedAt: m.now, at: m.now });

    // A waiter, then an approval, a join, a moderator grant and a raised hand.
    const waiting = await m.join(ada);
    if (waiting.kind !== "waiting") throw new Error(waiting.kind);
    await expect(admissionRow(waiting.admissionId)).resolves.toMatchObject({ admissionStatus: "pending", decidedAt: null });
    await m.apply({ kind: "decideAdmission", subject: host, admissionId: waiting.admissionId, approve: true });
    const adaReply = await m.join(ada, waiting.admissionId);
    if (adaReply.kind !== "admitted") throw new Error(adaReply.kind);
    await expect(connectionRow(adaReply.participant.attemptId)).resolves.toMatchObject({ connectionStatus: "pending" });
    await m.apply({ kind: "participantJoined", identity: adaReply.participant.identity, sid: "PA_a", joinedAt: m.now, at: m.now });
    await expect(connectionRow(adaReply.participant.attemptId)).resolves.toMatchObject({
      connectionStatus: "live", livekitParticipantSid: "PA_a",
    });
    await m.apply({ kind: "setModerator", subject: host, identity: adaReply.participant.identity, moderator: true });
    await expect(admissionRow(waiting.admissionId)).resolves.toMatchObject({ meetingModerator: true });
    await expect(connectionRow(adaReply.participant.attemptId)).resolves.toMatchObject({ role: "moderator" });

    // Ada rejoins on another device; the first attempt ends as superseded.
    const again = await m.join(ada, waiting.admissionId);
    if (again.kind !== "admitted") throw new Error(again.kind);
    await m.apply({ kind: "participantJoined", identity: again.participant.identity, sid: "PA_a2", joinedAt: m.now, at: m.now });
    await expect(connectionRow(adaReply.participant.attemptId)).resolves.toMatchObject({
      connectionStatus: "ended", reason: "superseded",
    });

    // Revocation clears the grants in the same row (decision-shape CHECK).
    await m.apply({ kind: "revoke", userId: "ada", reason: "space_membership_removed" });
    await expect(admissionRow(waiting.admissionId)).resolves.toMatchObject({
      admissionStatus: "revoked", meetingModerator: false, screenShareGranted: false,
    });

    // A guest waits, and the meeting ends under them.
    const guestWait = await m.join(guest);
    if (guestWait.kind !== "waiting") throw new Error(guestWait.kind);
    await m.apply({ kind: "end", subject: host, reason: "host" });
    await expect(admissionRow(guestWait.admissionId)).resolves.toMatchObject({
      admissionStatus: "expired", decisionReason: "meeting_ended",
    });
    await expect(connectionRow(hostAttempt.attemptId)).resolves.toMatchObject({ connectionStatus: "ended" });
    await expect(db.query.meetings.findFirst({ where: { id: "meeting_1" } })).resolves.toMatchObject({
      mediaNodeId: "node-a",
      firstJoinedAt: expect.any(Date),
    });
  });

  it("writes only the rows a change touched", async () => {
    const m = new Projected();
    const hostReply = await m.join(host);
    if (hostReply.kind !== "admitted") throw new Error(hostReply.kind);
    await m.apply({ kind: "participantJoined", identity: hostReply.participant.identity, sid: "PA_h", joinedAt: m.now, at: m.now });
    // The attempt's row, and the meeting's first join.
    expect(m.statements).toBe(2);
    await m.apply({ kind: "listPending", subject: host });
    expect(m.statements).toBe(0);
    await m.apply({ kind: "setJoinPolicy", subject: host, joinPolicy: "closed" });
    expect(m.statements).toBe(1);
  });

  it("writes the title only when the room renames it, and only while D1 has the meeting open", async () => {
    const m = new Projected();
    await m.join(host);
    const title = async () => (await db.query.meetings.findFirst({ where: { id: "meeting_1" } }))?.title;

    await m.apply({ kind: "renameMeeting", subject: host, title: "Standup", expectedTitle: null });
    await expect(title()).resolves.toBe("Standup");

    // Other changes to the meeting row never carry the title with them.
    await db.update(meetings).set({ title: "Named elsewhere" }).where(eq(meetings.id, "meeting_1"));
    await m.apply({ kind: "setJoinPolicy", subject: host, joinPolicy: "closed" });
    await expect(title()).resolves.toBe("Named elsewhere");

    // Once D1 has it ended, the summary job may name it; a rename still in
    // flight from the room does not undo that.
    await db.update(meetings)
      .set({ status: "ended", endedAt: new Date(m.now), title: "From the summary" })
      .where(eq(meetings.id, "meeting_1"));
    await m.apply({ kind: "renameMeeting", subject: host, title: "Late", expectedTitle: "Standup" });
    await expect(title()).resolves.toBe("From the summary");
  });

  it("writes a rename that is the room's first change", async () => {
    const m = new Projected();
    await m.apply({ kind: "renameMeeting", subject: host, title: "Before anyone came", expectedTitle: null });
    const row = await db.query.meetings.findFirst({ where: { id: "meeting_1" } });
    expect(row?.title).toBe("Before anyone came");
  });

  it("skips the rows of a meeting deleted under its room instead of failing", async () => {
    const m = new Projected();
    await m.join(host);
    await db.delete(meetings).where(eq(meetings.id, "meeting_1"));
    await expect(m.join(ada)).resolves.toMatchObject({ kind: "waiting" });
  });
});

