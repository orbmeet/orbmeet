import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";
import { meetingAdmissions, meetingConnections, meetings, meetingLinks, users } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { selectMeetingLookupByCode } from "../history/meeting-lookup.server";

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

async function insertMeetingLinkRow(input: {
  id: string;
  code: string;
  ownerUserId: string;
  joinPolicy: "open" | "approval_required" | "closed";
  type?: "one_time" | "reusable";
}) {
  const now = new Date();
  await seedPersonalSpace(db, input.ownerUserId);
  await db.insert(meetingLinks).values({
    id: input.id,
    code: input.code,
    reusePolicy: input.type ?? "reusable",
    spaceId: `${input.ownerUserId}_space`,
    spaceKind: "personal" as const,
    title: "Meeting",
    allowGuests: true,
    joinPolicy: input.joinPolicy,
    createdAt: now,
    updatedAt: now,
  });
}



async function insertEndedMeeting(input: {
  id: string;
  meetingLinkId: string;
  ownerUserId: string;
}) {
  const now = new Date();
  await seedPersonalSpace(db, input.ownerUserId);
  await db.insert(meetings).values({
    id: input.id,
    meetingLinkId: input.meetingLinkId,
    title: "Meeting",
    startedByUserId: input.ownerUserId,
    spaceId: `${input.ownerUserId}_space`,
    spaceKind: "personal" as const,
    status: "ended",
    billingPrincipalType: "user" as const,
    billingPrincipalId: input.ownerUserId,
    billingPlan: "free",
    allowGuests: true,
    joinPolicy: "open",
    recordingEnabled: false,
    startedAt: new Date(now.getTime() - 60_000),
    endedAt: now,
    updatedAt: now,
  });
}

async function insertOpenMeeting(input: {
  id: string;
  meetingLinkId: string;
  ownerUserId: string;
  joinPolicy: "open" | "approval_required" | "closed";
  allowGuests?: boolean;
}) {
  const now = new Date();
  await seedPersonalSpace(db, input.ownerUserId);
  await db.insert(meetings).values({
    id: input.id,
    meetingLinkId: input.meetingLinkId,
    title: "Meeting",
    startedByUserId: input.ownerUserId,
    spaceId: `${input.ownerUserId}_space`,
    spaceKind: "personal" as const,
    status: "open",
    billingPrincipalType: "user" as const,
    billingPrincipalId: input.ownerUserId,
    billingPlan: "free",
    allowGuests: input.allowGuests ?? true,
    joinPolicy: input.joinPolicy,
    recordingEnabled: false,
    startedAt: now,
    updatedAt: now,
  });
}

async function insertConnection(input: { meetingId: string; userId: string; status: "pending" | "live" | "ended" }) {
  const db = getAppDb();
  const now = new Date();
  const admissionId = `adm_${input.userId}`;
  await db.insert(meetingAdmissions).values({
    id: admissionId,
    meetingId: input.meetingId,
    subjectType: "user",
    subjectUserId: input.userId,
    displayName: input.userId,
    admissionStatus: "approved",
    decidedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(meetingConnections).values({
    id: `conn_${input.userId}`,
    meetingId: input.meetingId,
    admissionId,
    livekitIdentity: `lk_${input.userId}`,
    userId: input.userId,
    role: "host",
    connectionStatus: input.status,
    tokenIssuedAt: now,
    connectedAt: input.status === "pending" ? null : now,
    disconnectedAt: input.status === "ended" ? now : null,
    createdAt: now,
    updatedAt: now,
  });
}

describe("selectMeetingLookupByCode", () => {
  it("tells a signed-in viewer they are already in the meeting on another device", async () => {
    await insertUser("host");
    await insertUser("guest");
    await insertMeetingLinkRow({ id: "room_1", code: "abc-defg-hij", ownerUserId: "host", joinPolicy: "open" });
    await insertOpenMeeting({ id: "meeting_1", meetingLinkId: "room_1", ownerUserId: "host", joinPolicy: "open" });
    await insertConnection({ meetingId: "meeting_1", userId: "host", status: "live" });

    await expect(selectMeetingLookupByCode(getAppDb(), "abc-defg-hij", "host")).resolves.toMatchObject({
      viewerAdmissionsInMeeting: ["adm_host"],
    });
    await expect(selectMeetingLookupByCode(getAppDb(), "abc-defg-hij", "guest")).resolves.toMatchObject({
      viewerAdmissionsInMeeting: [],
    });
    await expect(selectMeetingLookupByCode(getAppDb(), "abc-defg-hij")).resolves.toMatchObject({
      viewerAdmissionsInMeeting: [],
    });
  });

  it("does not count a connection that has ended", async () => {
    await insertUser("host");
    await insertMeetingLinkRow({ id: "room_1", code: "abc-defg-hij", ownerUserId: "host", joinPolicy: "open" });
    await insertOpenMeeting({ id: "meeting_1", meetingLinkId: "room_1", ownerUserId: "host", joinPolicy: "open" });
    await insertConnection({ meetingId: "meeting_1", userId: "host", status: "ended" });

    await expect(selectMeetingLookupByCode(getAppDb(), "abc-defg-hij", "host")).resolves.toMatchObject({
      viewerAdmissionsInMeeting: [],
    });
  });

  it("uses the permanent link's approval setting when no Meeting is active", async () => {
    await insertUser("host");
    await insertMeetingLinkRow({
      id: "room_1",
      code: "abc-defg-hij",
      ownerUserId: "host",
      joinPolicy: "approval_required",
    });

    const result = await selectMeetingLookupByCode(getAppDb(), "abc-defg-hij", "host");

    expect(result).toMatchObject({
      exists: true,
      hasOpenMeeting: false,
      joinPolicy: "approval_required",
    });
  });

  it("uses the open meeting join-policy snapshot over the meeting-link setting", async () => {
    await insertUser("host");
    await insertMeetingLinkRow({
      id: "room_1",
      code: "abc-defg-hij",
      ownerUserId: "host",
      joinPolicy: "approval_required",
    });
    await insertOpenMeeting({
      id: "meeting_1",
      meetingLinkId: "room_1",
      ownerUserId: "host",
      joinPolicy: "open",
    });

    const result = await selectMeetingLookupByCode(getAppDb(), "abc-defg-hij", "host");

    expect(result).toMatchObject({
      exists: true,
      hasOpenMeeting: true,
      joinPolicy: "open",
    });
  });

  it("uses the open meeting guest-policy snapshot over later link edits", async () => {
    await insertUser("host");
    await insertMeetingLinkRow({
      id: "room_1",
      code: "abc-defg-hij",
      ownerUserId: "host",
      joinPolicy: "open",
    });
    await insertOpenMeeting({
      id: "meeting_1",
      meetingLinkId: "room_1",
      ownerUserId: "host",
      joinPolicy: "open",
      allowGuests: false,
    });

    const result = await selectMeetingLookupByCode(getAppDb(), "abc-defg-hij");

    expect(result).toMatchObject({
      exists: true,
      hasOpenMeeting: true,
      allowGuests: false,
      requiresAuth: true,
    });
  });

  it("keeps a never-used one-time link startable", async () => {
    await insertUser("host");
    await insertMeetingLinkRow({
      id: "link_later",
      code: "abc-defg-hij",
      ownerUserId: "host",
      joinPolicy: "open",
      type: "one_time",
    });

    const result = await selectMeetingLookupByCode(getAppDb(), "abc-defg-hij", "host");

    expect(result).toMatchObject({
      exists: true,
      reusePolicy: "one_time",
      hasOpenMeeting: false,
      canStartMeeting: true,
    });
  });

  it("tells a one-time-link visitor that only the owner can start it", async () => {
    await insertUser("host");
    await insertUser("visitor");
    await insertMeetingLinkRow({
      id: "link_later",
      code: "abc-defg-hij",
      ownerUserId: "host",
      joinPolicy: "open",
      type: "one_time",
    });

    const result = await selectMeetingLookupByCode(getAppDb(), "abc-defg-hij", "visitor");

    expect(result).toMatchObject({
      exists: true,
      reusePolicy: "one_time",
      hasOpenMeeting: false,
      canStartMeeting: false,
    });
  });

  it("does not let a visitor start a personal reusable link", async () => {
    await insertUser("host");
    await insertUser("visitor");
    await insertMeetingLinkRow({
      id: "link_reusable",
      code: "abc-defg-hij",
      ownerUserId: "host",
      joinPolicy: "open",
      type: "reusable",
    });

    const result = await selectMeetingLookupByCode(
      getAppDb(),
      "abc-defg-hij",
      "visitor",
    );

    expect(result).toMatchObject({
      exists: true,
      reusePolicy: "reusable",
      hasOpenMeeting: false,
      canStartMeeting: false,
    });
  });

  it("keeps an expired link visible while its meeting is open", async () => {
    await insertUser("host");
    await insertMeetingLinkRow({
      id: "link_expiring",
      code: "abc-defg-hij",
      ownerUserId: "host",
      joinPolicy: "open",
    });
    await insertOpenMeeting({
      id: "meeting_live",
      meetingLinkId: "link_expiring",
      ownerUserId: "host",
      joinPolicy: "open",
    });
    await db
      .update(meetingLinks)
      .set({
        createdAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() - 1_000),
      })
      .where(eq(meetingLinks.id, "link_expiring"));

    const result = await selectMeetingLookupByCode(getAppDb(), "abc-defg-hij");

    expect(result).toMatchObject({ exists: true, hasOpenMeeting: true });
  });

  it("reports an expired link with no open meeting as gone", async () => {
    await insertUser("host");
    await insertMeetingLinkRow({
      id: "link_expired",
      code: "abc-defg-hij",
      ownerUserId: "host",
      joinPolicy: "open",
    });
    await db
      .update(meetingLinks)
      .set({
        createdAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() - 1_000),
      })
      .where(eq(meetingLinks.id, "link_expired"));

    const result = await selectMeetingLookupByCode(getAppDb(), "abc-defg-hij");

    expect(result).toEqual({ exists: false });
  });

  it("reports a consumed one-time link as an ended Meeting", async () => {
    await insertUser("host");
    await insertMeetingLinkRow({
      id: "link_used",
      code: "abc-defg-hij",
      ownerUserId: "host",
      joinPolicy: "open",
      type: "one_time",
    });
    await insertEndedMeeting({
      id: "meeting_done",
      meetingLinkId: "link_used",
      ownerUserId: "host",
    });

    const result = await selectMeetingLookupByCode(getAppDb(), "abc-defg-hij");

    expect(result).toMatchObject({
      exists: true,
      ended: true,
      meetingId: "meeting_done",
      reusePolicy: "one_time",
      hasOpenMeeting: false,
      canStartMeeting: false,
      requiresAuth: true,
    });
  });
});
