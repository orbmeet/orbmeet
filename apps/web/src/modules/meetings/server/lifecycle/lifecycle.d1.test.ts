import { beforeEach, describe, expect, it } from "vitest";
import { meetingAdmissions, meetingConnections, meetingLinks, meetings, users } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";
import { discardUnstartedMeeting } from "./lifecycle";

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
  const now = new Date();
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
  await seedPersonalSpace(db, "owner");
  await db.insert(meetingLinks).values({
    id: "link",
    code: "abc-defg-hij",
    reusePolicy: "one_time",
    spaceId: "owner_space",
    spaceKind: "personal" as const,
    allowGuests: true,
    joinPolicy: "open",
    spentAt: null,
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(meetings).values({
    id: "meeting",
    meetingLinkId: "link",
    spaceId: "owner_space",
    spaceKind: "personal" as const,
    startedByUserId: "owner",
    status: "open",
    billingPrincipalType: "user" as const,
    billingPrincipalId: "owner",
    billingPlan: "free",
    allowGuests: true,
    recordingEnabled: false,
    joinPolicy: "open",
    startedAt: now,
    updatedAt: now,
  });
  await db
    .update(meetingLinks)
    .set({ spentAt: now, lastUsedAt: now, updatedAt: now })
    .where(eq(meetingLinks.id, "link"));
  await db.insert(meetingAdmissions).values({
    id: "admission",
    meetingId: "meeting",
    subjectType: "user",
    subjectUserId: "owner",
    displayName: "Owner",
    admissionStatus: "approved",
    decidedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  // The abandoned-join baseline: the joiner was admitted and their only
  // attempt never reached the room.
  await db.insert(meetingConnections).values({
    id: "connection_owner",
    meetingId: "meeting",
    admissionId: "admission",
    livekitIdentity: "owner_admission",
    userId: "owner",
    role: "host",
    connectionStatus: "ended",
    reason: "connect_failed",
    tokenIssuedAt: now,
    connectedAt: null,
    disconnectedAt: now,
    createdAt: now,
    updatedAt: now,
  });
});

describe("discardUnstartedMeeting", () => {
  const meetingRow = () => db.query.meetings.findFirst({ where: { id: "meeting" }, columns: { id: true } });

  it("removes an occurrence nobody joined and gives its one-time link back", async () => {
    await discardUnstartedMeeting(db, "meeting");

    await expect(meetingRow()).resolves.toBeUndefined();
    await expect(
      db.query.meetingLinks.findFirst({
        where: { id: "link" },
        columns: { spentAt: true, lastUsedAt: true },
      }),
    ).resolves.toEqual({ spentAt: null, lastUsedAt: null });
  });

  it("never removes a meeting someone joined (review bug #1)", async () => {
    // A reconnect used to clear the evidence that anyone had connected; the
    // first join is now recorded once on the meeting and never cleared.
    await db
      .update(meetings)
      .set({ firstJoinedAt: new Date() })
      .where(eq(meetings.id, "meeting"));

    await discardUnstartedMeeting(db, "meeting");
    await expect(meetingRow()).resolves.toEqual({ id: "meeting" });
  });

  it("leaves an ended meeting alone", async () => {
    const now = new Date();
    await db
      .update(meetings)
      .set({ status: "ended", endedAt: now, updatedAt: now })
      .where(eq(meetings.id, "meeting"));

    await discardUnstartedMeeting(db, "meeting");
    await expect(meetingRow()).resolves.toEqual({ id: "meeting" });
  });
});
