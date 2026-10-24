import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@orbmeet/db";
import {
  meetingAdmissions,
  meetingConnections,
  meetingLinks,
  meetingSummaries,
  meetings,
  spaceMembers,
  spaces,
  users,
} from "@orbmeet/db/schema";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";
import {selectMyThreads} from "@/modules/meetings/server/room/threads.server";

let db: Database;

beforeEach(async () => {
  db = await createTestDb();
});

const HOUR = 3_600_000;
const now = new Date("2026-07-01T12:00:00Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * HOUR);

function meetingCode(index: number): string {
  let value = index;
  let letters = "";
  for (let position = 0; position < 10; position += 1) {
    letters = String.fromCharCode(97 + (value % 26)) + letters;
    value = Math.floor(value / 26);
  }
  return `${letters.slice(0, 3)}-${letters.slice(3, 7)}-${letters.slice(7)}`;
}

async function insertUser(id: string, plan: "free" | "pro" = "pro") {
  await db.insert(users).values({
    id,
    name: id,
    email: `${id}@example.com`,
    normalizedEmail: `${id}@example.com`,
    plan,
    role: "user",
    createdAt: hoursAgo(100),
    updatedAt: hoursAgo(100),
  });
  await seedPersonalSpace(db, id, { now: hoursAgo(100) });
}

async function insertPersonalLink(
  id: string,
  ownerUserId: string,
  code: string,
  lastUsedAt: Date | null = null,
) {
  await seedPersonalSpace(db, ownerUserId);
  await db.insert(meetingLinks).values({
    id,
    code,
    reusePolicy: "reusable",
    spaceId: `${ownerUserId}_space`,
    spaceKind: "personal" as const,
    title: null,
    allowGuests: true,
    lastUsedAt,
    createdAt: hoursAgo(90),
    updatedAt: hoursAgo(90),
  });
}

async function insertOneTimeLink(id: string, ownerUserId: string, code: string) {
  await seedPersonalSpace(db, ownerUserId);
  await db.insert(meetingLinks).values({
    id,
    code,
    reusePolicy: "one_time",
    spaceId: `${ownerUserId}_space`,
    spaceKind: "personal" as const,
    allowGuests: true,
    createdAt: hoursAgo(90),
    updatedAt: hoursAgo(90),
  });
}

async function insertSpaceWithLink(
  spaceId: string,
  name: string,
  ownerUserId: string,
  linkId: string,
  code: string,
  updatedAt: Date,
) {
  await db.insert(spaces).values({
    kind: "shared",
    id: spaceId,
    name,
    slug: `slug-${spaceId}`,
    ownerUserId: ownerUserId,
    createdAt: hoursAgo(95),
    updatedAt,
  });
  await db.insert(spaceMembers).values({
    id: `member_${spaceId}_${ownerUserId}`,
    spaceId,
    userId: ownerUserId,
    role: "admin",
    joinedAt: hoursAgo(95),
  });
  await db.insert(meetingLinks).values({
    id: linkId,
    code,
    spaceId,
    spaceKind: "shared",
    reusePolicy: "reusable",
    allowGuests: false,
    createdAt: hoursAgo(95),
    updatedAt: hoursAgo(95),
  });
}

async function insertMeeting(input: {
  id: string;
  meetingLinkId: string;
  ownerUserId?: string | null;
  spaceId?: string | null;
  status: "open" | "ended";
  startedAt: Date;
  endedAt?: Date | null;
}) {
  // A meeting always lives in its link's space: the given shared space, or
  // the starter's personal space.
  const spaceId = input.spaceId ?? `${input.ownerUserId}_space`;
  await db.insert(meetings).values({
    id: input.id,
    meetingLinkId: input.meetingLinkId,
    startedByUserId: input.ownerUserId ?? null,
    spaceId,
    spaceKind: input.spaceId ? "shared" : "personal",
    billingPrincipalType: "user" as const,
    billingPrincipalId: input.ownerUserId ?? "host",
    billingPlan: "free",
    status: input.status,
    startedAt: input.startedAt,
    endedAt: input.endedAt ?? null,
    updatedAt: input.endedAt ?? input.startedAt,
  });
}

async function insertRecap(meetingId: string, createdAt: Date) {
  await db.insert(meetingSummaries).values({
    id: `recap_${meetingId}`,
    meetingId,
    summary: "Summary",
    createdAt,
  });
}

async function insertConnectedUser(meetingId: string, userId: string) {
  const admissionId = `adm_${meetingId}_${userId}`;
  await db.insert(meetingAdmissions).values({
    id: admissionId,
    meetingId,
    subjectType: "user",
    subjectUserId: userId,
    displayName: userId,
    admissionStatus: "approved",
    decidedAt: hoursAgo(1),
    createdAt: hoursAgo(1),
    updatedAt: hoursAgo(1),
  });
  await db.insert(meetingConnections).values({
    id: `conn_${meetingId}_${userId}`,
    meetingId,
    admissionId,
    livekitIdentity: `lk_${userId}`,
    userId,
    role: "attendee",
    connectionStatus: "live",
    tokenIssuedAt: hoursAgo(1),
    connectedAt: hoursAgo(1),
    createdAt: hoursAgo(1),
    updatedAt: hoursAgo(1),
  });
}

describe("selectMyThreads", () => {
  it("orders live threads first, then by last activity", async () => {
    await insertUser("me");
    await insertUser("guest");

    // One permanent personal link: an ended Meeting followed by a live one.
    await insertPersonalLink("link_a", "me", "aaa-aaaa-aaa", hoursAgo(24));
    await insertMeeting({
      id: "m_ended",
      meetingLinkId: "link_a",
      ownerUserId: "me",
      status: "ended",
      startedAt: hoursAgo(25),
      endedAt: hoursAgo(24),
    });
    await insertRecap("m_ended", hoursAgo(23));

    await insertMeeting({
      id: "m_live",
      meetingLinkId: "link_a",
      ownerUserId: "me",
      status: "open",
      startedAt: hoursAgo(0.5),
    });
    await insertConnectedUser("m_live", "guest");

    const { threads } = await selectMyThreads(db, { id: "me", plan: "pro" });

    expect(threads.map((t) => t.id)).toEqual(["link_a"]);

    const [liveThread] = threads;
    expect(liveThread.kind).toBe("personal");
    expect(liveThread).toMatchObject({
      title: "Personal meeting",
      defaultTitle: null,
      joinPolicy: "open",
    });
    expect(liveThread.openMeeting?.meetingId).toBe("m_live");
    expect(liveThread.openMeeting?.participantCount).toBe(1);

    expect(liveThread.latestMeeting?.meetingId).toBe("m_ended");
    expect(liveThread.latestMeeting?.hasSummary).toBe(true);
  });

  it("includes spaces with their latest session driving activity", async () => {
    await insertUser("me");
    await insertSpaceWithLink("spc_1", "Algebra Group A", "me", "link_spc", "ccc-cccc-ccc", hoursAgo(80));
    await insertMeeting({
      id: "m_space",
      meetingLinkId: "link_spc",
      ownerUserId: "me",
      spaceId: "spc_1",
      status: "ended",
      startedAt: hoursAgo(3),
      endedAt: hoursAgo(2),
    });

    const { threads } = await selectMyThreads(db, { id: "me", plan: "pro" });

    const spaceThread = threads.find((t) => t.kind === "space");
    expect(spaceThread?.id).toBe("spc_1");
    expect(spaceThread?.title).toBe("Algebra Group A");
    expect(spaceThread?.code).toBeNull();
    expect(spaceThread?.latestMeeting?.meetingId).toBe("m_space");
    expect(spaceThread?.latestMeeting?.hasSummary).toBe(false);
    expect(spaceThread?.lastActivityAt).toBe(hoursAgo(2).toISOString());
  });

  it("projects the Space's single open meeting separately from its history", async () => {
    await insertUser("me");
    await insertSpaceWithLink(
      "spc_1",
      "Algebra Group A",
      "me",
      "link_default",
      "ccc-cccc-ccc",
      hoursAgo(80),
    );
    await insertMeeting({
      id: "m_older",
      meetingLinkId: "link_default",
      ownerUserId: "me",
      spaceId: "spc_1",
      status: "ended",
      startedAt: hoursAgo(2),
      endedAt: hoursAgo(1.5),
    });
    await insertMeeting({
      id: "m_newer",
      meetingLinkId: "link_default",
      ownerUserId: "me",
      spaceId: "spc_1",
      status: "open",
      startedAt: hoursAgo(1),
    });

    const { threads } = await selectMyThreads(db, { id: "me", plan: "pro" });
    const spaceThread = threads.find((thread) => thread.kind === "space");

    expect(spaceThread?.openMeeting?.meetingId).toBe("m_newer");
    expect(spaceThread?.latestMeeting?.meetingId).toBe("m_older");
  });

  it("surfaces ad-hoc live meetings the user joined as their own thread", async () => {
    await insertUser("me");
    await insertUser("host");
    await insertOneTimeLink("link_host", "host", "ddd-dddd-ddd");
    await insertMeeting({
      id: "m_adhoc",
      meetingLinkId: "link_host",
      ownerUserId: "host",
      status: "open",
      startedAt: hoursAgo(1),
    });
    await insertConnectedUser("m_adhoc", "me");

    const { threads } = await selectMyThreads(db, { id: "me", plan: "pro" });

    expect(threads).toHaveLength(1);
    expect(threads[0].kind).toBe("meeting");
    expect(threads[0].code).toBe("ddd-dddd-ddd");
    expect(threads[0].openMeeting?.meetingId).toBe("m_adhoc");
  });

  it("does not expose a shared-space Meeting to its former starter after removal", async () => {
    await insertUser("me");
    await insertUser("host");
    await insertSpaceWithLink(
      "spc_host",
      "Host Space",
      "host",
      "link_host",
      "fff-ffff-fff",
      hoursAgo(2),
    );
    await db.insert(spaceMembers).values({
      id: "member_spc_host_me",
      spaceId: "spc_host",
      userId: "me",
      role: "member",
      joinedAt: hoursAgo(2),
    });
    await insertMeeting({
      id: "m_started_by_removed_member",
      meetingLinkId: "link_host",
      ownerUserId: "me",
      spaceId: "spc_host",
      status: "open",
      startedAt: hoursAgo(1),
    });
    await db.delete(spaceMembers).where(and(
      eq(spaceMembers.spaceId, "spc_host"),
      eq(spaceMembers.userId, "me"),
    ));

    const { threads } = await selectMyThreads(db, { id: "me", plan: "pro" });

    expect(threads).toHaveLength(0);
  });

  it("keeps the Free plan's permanent personal meeting link active", async () => {
    await insertUser("me", "free");
    await insertPersonalLink("link_free", "me", "eee-eeee-eee");

    const { threads } = await selectMyThreads(db, { id: "me", plan: "free" });

    expect(threads).toHaveLength(1);
  });

  it("loads latest meetings when a user has 99 Space threads", async () => {
    await insertUser("me");
    for (let index = 0; index < 99; index += 1) {
      const spaceId = `space_boundary_${index}`;
      const linkId = `link_boundary_${index}`;
      await insertSpaceWithLink(
        spaceId,
        `Boundary Space ${index}`,
        "me",
        linkId,
        meetingCode(index),
        hoursAgo(80),
      );
      await insertMeeting({
        id: `meeting_boundary_${index}`,
        meetingLinkId: linkId,
        ownerUserId: "me",
        spaceId,
        status: "ended",
        startedAt: hoursAgo(index + 2),
        endedAt: hoursAgo(index + 1),
      });
    }

    const { threads } = await selectMyThreads(db, { id: "me", plan: "pro" });

    expect(threads).toHaveLength(99);
    expect(threads.every((thread) => thread.latestMeeting !== null)).toBe(true);
  });
});
