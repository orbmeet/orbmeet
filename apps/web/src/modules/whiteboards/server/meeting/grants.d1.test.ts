import { beforeEach, describe, expect, it } from "vitest";
import {
  meetingAdmissions,
  meetingLinks,
  meetings,
  users,
} from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";

import { resolveWhiteboardCapabilities } from "./grants";

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
});

async function insertOpenMeeting(meetingId: string, hostUserId: string) {
  const now = new Date("2026-01-01T00:00:00.000Z");
  await db.insert(users).values([
    {
      id: hostUserId,
      name: hostUserId,
      email: `${hostUserId}@example.com`,
      normalizedEmail: `${hostUserId}@example.com`,
      plan: "free",
      role: "user",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "usr_grantee",
      name: "Grantee",
      email: "grantee@example.com",
      normalizedEmail: "grantee@example.com",
      plan: "free",
      role: "user",
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await seedPersonalSpace(db, hostUserId);
  await db.insert(meetingLinks).values({
    id: `room_${meetingId}`,
    code: "abc-defg-hij",
    reusePolicy: "reusable",
    spaceId: `${hostUserId}_space`,
    spaceKind: "personal" as const,
    title: "Meeting",
    allowGuests: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(meetings).values({
    id: meetingId,
    meetingLinkId: `room_${meetingId}`,
    startedByUserId: hostUserId,
    spaceId: `${hostUserId}_space`,
    spaceKind: "personal" as const,
    title: "Meeting",
    status: "open",
    billingPrincipalType: "user" as const,
    billingPrincipalId: hostUserId,
    billingPlan: "free",
    allowGuests: true,
    recordingEnabled: false,
    startedAt: now,
    endedAt: null,
    activeEgressId: null,
    activeStreamEgressId: null,
    updatedAt: now,
  });
}

async function insertAdmission(input: {
  id: string;
  meetingId: string;
  subject: { userId: string } | { guest: true };
  status: "approved" | "revoked";
  whiteboardEditGranted: boolean;
}) {
  const now = new Date();
  await db.insert(meetingAdmissions).values({
    id: input.id,
    meetingId: input.meetingId,
    subjectType: "userId" in input.subject ? "user" : "guest",
    subjectUserId: "userId" in input.subject ? input.subject.userId : null,
    guestSecretHash: "userId" in input.subject ? null : "guest-secret-hash",
    displayName: input.id,
    admissionStatus: input.status,
    whiteboardEditGranted: input.whiteboardEditGranted,
    decidedAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

const attendee = { canEditWhiteboard: false, canControlSurface: false, canManageWhiteboard: false };

// The coordinator decides edit grants (step-moderation.test.ts); this is the
// read every board token and socket check makes of what it projected.
describe("reading a board edit grant", () => {
  it("adds editing for the admission the coordinator granted, and only that one", async () => {
    await insertOpenMeeting("meeting_1", "usr_host");
    await insertAdmission({ id: "adm_grantee", meetingId: "meeting_1", subject: { userId: "usr_grantee" }, status: "approved", whiteboardEditGranted: true });

    await expect(resolveWhiteboardCapabilities(db, {
      meetingId: "meeting_1",
      principal: { type: "user", id: "usr_grantee" },
      base: attendee,
    })).resolves.toEqual({ capabilities: { ...attendee, canEditWhiteboard: true }, whiteboardEditGranted: true });
    await expect(resolveWhiteboardCapabilities(db, {
      meetingId: "meeting_1",
      principal: { type: "user", id: "usr_host" },
      base: attendee,
    })).resolves.toMatchObject({ whiteboardEditGranted: false });
  });

  it("does not honour a grant on an admission that is no longer approved", async () => {
    await insertOpenMeeting("meeting_1", "usr_host");
    await insertAdmission({ id: "adm_grantee", meetingId: "meeting_1", subject: { userId: "usr_grantee" }, status: "revoked", whiteboardEditGranted: true });

    await expect(resolveWhiteboardCapabilities(db, {
      meetingId: "meeting_1",
      principal: { type: "user", id: "usr_grantee" },
      base: attendee,
    })).resolves.toMatchObject({ whiteboardEditGranted: false, capabilities: attendee });
  });

  it("finds a guest by admission, and never lets a user's admission stand in for a guest", async () => {
    await insertOpenMeeting("meeting_1", "usr_host");
    await insertAdmission({ id: "adm_guest", meetingId: "meeting_1", subject: { guest: true }, status: "approved", whiteboardEditGranted: true });
    await insertAdmission({ id: "adm_user", meetingId: "meeting_1", subject: { userId: "usr_grantee" }, status: "approved", whiteboardEditGranted: true });

    await expect(resolveWhiteboardCapabilities(db, {
      meetingId: "meeting_1",
      principal: { type: "guest_admission", id: "adm_guest" },
      base: attendee,
    })).resolves.toMatchObject({ whiteboardEditGranted: true });
    await expect(resolveWhiteboardCapabilities(db, {
      meetingId: "meeting_1",
      principal: { type: "guest_admission", id: "adm_user" },
      base: attendee,
    })).resolves.toMatchObject({ whiteboardEditGranted: false });
  });
});
