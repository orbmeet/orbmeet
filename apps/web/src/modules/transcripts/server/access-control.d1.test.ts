import { seedPersonalSpace } from "@/test/fixtures";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import { eq } from "drizzle-orm";
import { meetingAdmissions, meetingConnections, meetings, meetingLinks, spaceMembers, spaces, users } from "@orbmeet/db/schema";
import { canAccessActiveMeeting, canAccessMeetingHistory } from "@/modules/meetings/server/access/resource-access";

let db: TestDb;
const getAppDb = () => db;

beforeEach(async () => {
  db = await createTestDb();
});

async function insertUser(id: string) {
  const now = new Date();
  await db.insert(users).values({
    id,
    name: id,
    email: `${id}@example.com`,
    normalizedEmail: `${id}@example.com`,
    image: null,
    plan: "free",
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
}

async function insertSpace(spaceId: string, ownerUserId: string) {
  const now = new Date();
  await db.insert(spaces).values({
    kind: "shared",
    id: spaceId,
    slug: `${spaceId}-slug`,
    name: "Space",
    description: null,
    ownerUserId,
    createdAt: now,
    updatedAt: now,
  });
}

async function insertMembership(spaceId: string, userId: string, role: "owner" | "admin" | "member") {
  await db.insert(spaceMembers).values({
    id: `mbr_${spaceId}_${userId}`,
    spaceId,
    userId,
    // An owner is named on the Space and stored as an admin member.
    role: role === "owner" ? "admin" : role,
    joinedAt: new Date(),
  });
}

async function insertMeeting(meetingId: string, ownerUserId: string, sharedSpaceId: string | null, status: "open" | "ended" = "open") {
  const now = new Date();
  const personalSpaceId = await seedPersonalSpace(db, ownerUserId, { now });
  const spaceId = sharedSpaceId ?? personalSpaceId;
  const spaceKind = sharedSpaceId ? ("shared" as const) : ("personal" as const);
  await db.insert(meetingLinks).values({
    id: `room_${meetingId}`,
    code: "abc-defg-hij",
    spaceId,
    spaceKind,
    title: "Meeting",
    allowGuests: false,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(meetings).values({
    id: meetingId,
    meetingLinkId: `room_${meetingId}`,
    startedByUserId: ownerUserId,
    spaceId,
    spaceKind,
    billingPrincipalType: "user" as const,
    billingPrincipalId: ownerUserId,
    billingPlan: "free",
    title: "Meeting",
    status,
    allowGuests: false,
    recordingEnabled: false,
    startedAt: now,
    endedAt: status === "ended" ? now : null,
    updatedAt: now,
  });
}

async function insertAdmission(
  meetingId: string,
  userId: string,
  opts?: {
    role?: "host" | "moderator" | "attendee";
    admissionStatus?: "pending" | "approved" | "denied" | "revoked";
    connectionStatus?: "pending" | "live" | "ended";
    /** For an `ended` connection: whether it reached the room before it ended. */
    reachedRoom?: boolean;
  },
) {
  const now = new Date();
  const admissionStatus = opts?.admissionStatus ?? "approved";
  await db.insert(meetingAdmissions).values({
    id: `mad_${meetingId}_${userId}`,
    meetingId: meetingId,
    subjectType: "user",
    subjectUserId: userId,
    displayName: userId,
    meetingModerator: admissionStatus === "approved" && opts?.role === "moderator",
    admissionStatus,
    decidedAt: admissionStatus === "pending" ? null : now,
    createdAt: now,
    updatedAt: now,
  });
  if (opts?.connectionStatus) {
    await db.insert(meetingConnections).values({
      id: `mlp_${meetingId}_${userId}`,
      meetingId: meetingId,
      admissionId: `mad_${meetingId}_${userId}`,
      livekitIdentity: userId,
      userId,
      role: opts.role ?? "attendee",
      connectionStatus: opts.connectionStatus,
      tokenIssuedAt: now,
      connectedAt: opts.connectionStatus === "live" || opts.reachedRoom ? now : null,
      disconnectedAt: opts.connectionStatus === "ended" ? now : null,
      createdAt: now,
      updatedAt: now,
    });
  }
}

describe("meeting transcript/asset access", () => {
  it("allows transcript access to every current Space member without requiring admission", async () => {
    await insertUser("host");
    await insertUser("participant");
    await insertSpace("space_1", "host");
    await insertMembership("space_1", "host", "owner");
    await insertMembership("space_1", "participant", "member");
    await insertMeeting("meeting_1", "host", "space_1");
    await expect(
      canAccessMeetingHistory(getAppDb(), "meeting_1", "participant"),
    ).resolves.toBe(true);
  });

  it("ends occurrence access with Space membership, admission or not", async () => {
    // Shared-Space entry is member-guarded, so an approved admission here can
    // only belong to someone who was a member when they attended. Honouring it
    // after their membership is gone is the access that removing them is meant
    // to end — and eviction cannot revoke it, because it only touches meetings
    // that are still open.
    await insertUser("host");
    await insertUser("participant");
    await insertSpace("space_1", "host");
    await insertMembership("space_1", "host", "owner");
    await insertMeeting("meeting_1", "host", "space_1");
    await insertAdmission("meeting_1", "participant");

    await insertMembership("space_1", "participant", "member");
    await expect(
      canAccessMeetingHistory(getAppDb(), "meeting_1", "participant"),
    ).resolves.toBe(true);

    await db.delete(spaceMembers).where(eq(spaceMembers.id, "mbr_space_1_participant"));
    await expect(
      canAccessMeetingHistory(getAppDb(), "meeting_1", "participant"),
    ).resolves.toBe(false);
  });

  it("keeps personal-Space occurrence access for someone who attended", async () => {
    // A personal Space has one member, so attendance is the only record that an
    // invited user was there — and there is no membership that could stand in
    // for it.
    await insertUser("host");
    await insertUser("participant");
    await insertMeeting("meeting_1", "host", null);
    await insertAdmission("meeting_1", "participant", { connectionStatus: "ended", reachedRoom: true });

    await expect(
      canAccessMeetingHistory(getAppDb(), "meeting_1", "participant"),
    ).resolves.toBe(true);
  });

  it("does not count approval without reaching the room as attending", async () => {
    // An open Meeting approves whoever asks to join before their connection
    // reaches the room. Someone who clicked Join and left never heard anything.
    await insertUser("host");
    await insertUser("participant");
    await insertMeeting("meeting_1", "host", null);
    await insertAdmission("meeting_1", "participant", { connectionStatus: "ended", reachedRoom: false });

    await expect(
      canAccessMeetingHistory(getAppDb(), "meeting_1", "participant"),
    ).resolves.toBe(false);
  });

  it("does not count an approved admission with no connection as attending", async () => {
    await insertUser("host");
    await insertUser("participant");
    await insertMeeting("meeting_1", "host", null);
    await insertAdmission("meeting_1", "participant");

    await expect(
      canAccessMeetingHistory(getAppDb(), "meeting_1", "participant"),
    ).resolves.toBe(false);
  });

  it("does not let a historical Space starter bypass current membership", async () => {
    await insertUser("host");
    await insertSpace("space_1", "host");
    await insertMeeting("meeting_1", "host", "space_1");

    await expect(
      canAccessMeetingHistory(getAppDb(), "meeting_1", "host"),
    ).resolves.toBe(false);
  });

  it("denies transcript access to users who were denied admission", async () => {
    await insertUser("host");
    await insertUser("participant");
    await insertMeeting("meeting_1", "host", null, "ended");
    await insertAdmission("meeting_1", "participant", { admissionStatus: "denied" });

    await expect(
      canAccessMeetingHistory(getAppDb(), "meeting_1", "participant"),
    ).resolves.toBe(false);
  });

  it("denies transcript access to users still awaiting approval", async () => {
    await insertUser("host");
    await insertUser("participant");
    await insertMeeting("meeting_1", "host", null, "ended");
    await insertAdmission("meeting_1", "participant", { admissionStatus: "pending" });

    await expect(
      canAccessMeetingHistory(getAppDb(), "meeting_1", "participant"),
    ).resolves.toBe(false);
  });

  it("denies active asset access to participants who have already left", async () => {
    await insertUser("host");
    await insertUser("participant");
    await insertMeeting("meeting_1", "host", null, "open");
    await insertAdmission("meeting_1", "participant", { connectionStatus: "ended" });

    await expect(
      canAccessActiveMeeting(getAppDb(), "meeting_1", "participant"),
    ).resolves.toBe(false);
  });

  it("allows active asset access to the host of an active meeting", async () => {
    await insertUser("host");
    await insertMeeting("meeting_1", "host", null, "open");

    await expect(
      canAccessActiveMeeting(getAppDb(), "meeting_1", "host"),
    ).resolves.toBe(true);
  });
});
