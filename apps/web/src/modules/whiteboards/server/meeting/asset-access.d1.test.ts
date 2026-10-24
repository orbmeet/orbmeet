import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  meetingAdmissions,
  meetingConnections,
  meetingLinks,
  meetings,
  spaceMembers,
  users,
} from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace, seedSharedSpace } from "@/test/fixtures";
import { canActiveParticipantReadWhiteboardAsset } from "./asset-access";

let db: TestDb;
const now = new Date("2026-05-04T10:00:00.000Z");

beforeEach(async () => {
  db = await createTestDb();
});

async function seedUser(id: string) {
  await db.insert(users).values({
    id,
    name: id,
    email: `${id}@example.com`,
    normalizedEmail: `${id}@example.com`,
    plan: "free",
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedMeeting(options: {
  meetingId: string;
  spaceId: string;
  spaceKind: "personal" | "shared";
  ownerUserId: string;
  code: string;
}) {
  const allowGuests = options.spaceKind === "personal";
  await db.insert(meetingLinks).values({
    id: `link_${options.meetingId}`,
    code: options.code,
    spaceId: options.spaceId,
    spaceKind: options.spaceKind,
    title: "Board",
    allowGuests,
    joinPolicy: "open",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(meetings).values({
    id: options.meetingId,
    meetingLinkId: `link_${options.meetingId}`,
    spaceId: options.spaceId,
    spaceKind: options.spaceKind,
    title: "Board",
    startedByUserId: options.ownerUserId,
    status: "open",
    billingPrincipalType: "user",
    billingPrincipalId: options.ownerUserId,
    billingPlan: "free",
    allowGuests,
    recordingEnabled: false,
    joinPolicy: "open",
    startedAt: now,
    updatedAt: now,
  });
}

async function admit(options: {
  id: string;
  meetingId: string;
  subjectType: "user" | "guest";
  subjectUserId?: string;
}) {
  await db.insert(meetingAdmissions).values({
    id: options.id,
    meetingId: options.meetingId,
    subjectType: options.subjectType,
    subjectUserId: options.subjectUserId ?? null,
    guestSecretHash: options.subjectType === "guest" ? `hash_${options.id}` : null,
    displayName: options.id,
    admissionStatus: "approved",
    decidedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(meetingConnections).values({
    id: `conn_${options.id}`,
    meetingId: options.meetingId,
    admissionId: options.id,
    livekitIdentity: `identity_${options.id}`,
    role: "attendee",
    userId: options.subjectUserId ?? null,
    connectionStatus: "live",
    connectedAt: now,
    tokenIssuedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return {
    meetingId: options.meetingId,
    connectionId: `conn_${options.id}`,
    participantIdentity: `identity_${options.id}`,
  };
}

describe("canActiveParticipantReadWhiteboardAsset", () => {
  it("grants a signed-in attendee of a personal meeting the same access as a guest", async () => {
    await seedUser("usr_owner");
    await seedUser("usr_attendee");
    const spaceId = await seedPersonalSpace(db, "usr_owner");
    await seedMeeting({
      meetingId: "meet_personal",
      spaceId,
      spaceKind: "personal",
      ownerUserId: "usr_owner",
      code: "aaa-bbbb-ccc",
    });

    const guest = await admit({ id: "adm_guest", meetingId: "meet_personal", subjectType: "guest" });
    const attendee = await admit({
      id: "adm_user",
      meetingId: "meet_personal",
      subjectType: "user",
      subjectUserId: "usr_attendee",
    });

    // A personal Space has exactly one member, so Space `canView` is
    // owner-only there and cannot describe an admitted attendee.
    await expect(canActiveParticipantReadWhiteboardAsset(db, guest)).resolves.toBe(true);
    await expect(canActiveParticipantReadWhiteboardAsset(db, attendee)).resolves.toBe(true);
  });

  it("still revokes a shared-Space attendee whose membership is removed mid-meeting", async () => {
    await seedUser("usr_shared_owner");
    await seedUser("usr_member");
    const spaceId = await seedSharedSpace(db, {
      id: "space_shared_assets",
      ownerUserId: "usr_shared_owner",
      slug: "shared-assets",
      members: [
        { userId: "usr_shared_owner", role: "owner" },
        { userId: "usr_member", role: "member" },
      ],
    });
    await seedMeeting({
      meetingId: "meet_shared",
      spaceId,
      spaceKind: "shared",
      ownerUserId: "usr_shared_owner",
      code: "ddd-eeee-fff",
    });

    const member = await admit({
      id: "adm_member",
      meetingId: "meet_shared",
      subjectType: "user",
      subjectUserId: "usr_member",
    });
    await expect(canActiveParticipantReadWhiteboardAsset(db, member)).resolves.toBe(true);

    await db.delete(spaceMembers).where(eq(spaceMembers.userId, "usr_member"));
    await expect(canActiveParticipantReadWhiteboardAsset(db, member)).resolves.toBe(false);
  });

  it("rejects a connection identity that does not match the connection", async () => {
    await seedUser("usr_owner2");
    const spaceId = await seedPersonalSpace(db, "usr_owner2");
    await seedMeeting({
      meetingId: "meet_personal2",
      spaceId,
      spaceKind: "personal",
      ownerUserId: "usr_owner2",
      code: "ggg-hhhh-iii",
    });
    const guest = await admit({
      id: "adm_guest2",
      meetingId: "meet_personal2",
      subjectType: "guest",
    });

    await expect(
      canActiveParticipantReadWhiteboardAsset(db, {
        ...guest,
        participantIdentity: "identity_someone_else",
      }),
    ).resolves.toBe(false);
  });

  it("rejects once the meeting is no longer open", async () => {
    await seedUser("usr_owner3");
    const spaceId = await seedPersonalSpace(db, "usr_owner3");
    await seedMeeting({
      meetingId: "meet_personal3",
      spaceId,
      spaceKind: "personal",
      ownerUserId: "usr_owner3",
      code: "jjj-kkkk-lll",
    });
    const guest = await admit({
      id: "adm_guest3",
      meetingId: "meet_personal3",
      subjectType: "guest",
    });

    await db.update(meetings).set({ status: "ended", endedAt: now }).where(eq(meetings.id, "meet_personal3"));
    await expect(canActiveParticipantReadWhiteboardAsset(db, guest)).resolves.toBe(false);
  });
});
