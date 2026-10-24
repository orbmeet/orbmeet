import { describe, expect, it } from "vitest";
import {
  meetingAdmissions,
  meetingConnections,
  meetingLinks,
  meetings,
  users,
} from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";
import {selectMeetingAttendance} from "@/modules/meetings/server/history/meeting-attendance-queries.server";

async function seedEndedMeeting() {
  const db = await createTestDb();
  const now = new Date("2026-08-19T12:00:00.000Z");
  await db.insert(users).values({
    id: "owner",
    name: "Owner",
    email: "owner@example.com",
    normalizedEmail: "owner@example.com",
    plan: "free",
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
  const spaceId = await seedPersonalSpace(db, "owner", { now });
  await db.insert(meetingLinks).values({
    id: "link_1",
    code: "abc-defg-hij",
    reusePolicy: "one_time",
    spaceId,
    spaceKind: "personal",
    allowGuests: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(meetings).values({
    id: "meeting_1",
    meetingLinkId: "link_1",
    spaceId,
    spaceKind: "personal",
    startedByUserId: "owner",
    status: "ended",
    billingPrincipalType: "user",
    billingPrincipalId: "owner",
    billingPlan: "free",
    allowGuests: true,
    recordingEnabled: false,
    startedAt: now,
    endedAt: now,
    updatedAt: now,
  });
  return { db, now };
}

describe("selectMeetingAttendance", () => {
  it("returns approved and actually-connected attendees without exposing the admission queue", async () => {
    const { db, now } = await seedEndedMeeting();
    await db.insert(meetingAdmissions).values([
      {
        id: "approved",
        meetingId: "meeting_1",
        subjectType: "guest",
        guestSecretHash: "hash",
        displayName: "Approved attendee",
        admissionStatus: "approved",
        decidedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "revoked_after_join",
        meetingId: "meeting_1",
        subjectType: "guest",
        guestSecretHash: null,
        displayName: "Revoked after joining",
        admissionStatus: "revoked",
        decidedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "pending",
        meetingId: "meeting_1",
        subjectType: "guest",
        guestSecretHash: "hash",
        displayName: "Pending applicant",
        admissionStatus: "pending",
        decidedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "denied",
        meetingId: "meeting_1",
        subjectType: "guest",
        guestSecretHash: null,
        displayName: "Denied applicant",
        admissionStatus: "denied",
        decidedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(meetingConnections).values({
      id: "connection_revoked",
      meetingId: "meeting_1",
      admissionId: "revoked_after_join",
      livekitIdentity: "guest_revoked",
      role: "attendee",
      connectionStatus: "ended",
      reason: "removed",
      tokenIssuedAt: now,
      connectedAt: now,
      disconnectedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const result = await selectMeetingAttendance(db, "meeting_1", "owner");

    expect(result.participants.map(({ displayName }) => displayName)).toEqual([
      "Approved attendee",
      "Revoked after joining",
    ]);
    expect(result.participants[0]).not.toHaveProperty("userId");
    expect(result.participants[0]).not.toHaveProperty("admissionStatus");
    expect(result.participants[0]).not.toHaveProperty("connectionStatus");
  });

  it("lists someone who rejoined once, spanning their first connect to their last disconnect", async () => {
    const { db, now } = await seedEndedMeeting();
    const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
    await db.insert(meetingAdmissions).values({
      id: "rejoined",
      meetingId: "meeting_1",
      subjectType: "guest",
      guestSecretHash: "hash",
      displayName: "Rejoined",
      admissionStatus: "approved",
      decidedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const connection = (id: string, from: number, to: number, role: "attendee" | "moderator") => ({
      id,
      meetingId: "meeting_1",
      admissionId: "rejoined",
      livekitIdentity: `guest_${id}`,
      role,
      connectionStatus: "ended" as const,
      reason: "voluntary",
      tokenIssuedAt: at(from),
      connectedAt: at(from),
      disconnectedAt: at(to),
      createdAt: at(from),
      updatedAt: at(to),
    });
    await db.insert(meetingConnections).values([
      connection("first", 0, 10, "attendee"),
      connection("after_reload", 11, 30, "moderator"),
    ]);

    const result = await selectMeetingAttendance(db, "meeting_1", "owner", { limit: 1 });

    expect(result.participants).toEqual([{
      id: "rejoined",
      displayName: "Rejoined",
      role: "moderator",
      admittedAt: now.toISOString(),
      connectedAt: at(0).toISOString(),
      disconnectedAt: at(30).toISOString(),
    }]);
    expect(result.nextCursor).toBeUndefined();
  });

  it("does not expose attendance while the meeting is open", async () => {
    const { db } = await seedEndedMeeting();
    await db
      .update(meetings)
      .set({ status: "open", endedAt: null })
      .where(eq(meetings.id, "meeting_1"));

    await expect(selectMeetingAttendance(db, "meeting_1", "owner")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
