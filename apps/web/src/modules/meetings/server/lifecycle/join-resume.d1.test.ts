import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { meetingLinks, meetings, users } from "@orbmeet/db/schema";
import type { RequestFnContext } from "@/app/bootstrap/middleware";
import { createTestDb, type TestDb } from "@/test/db";
import { seedSharedSpace } from "@/test/fixtures";
import { joinMeetingImpl } from "./join.server";

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
});

async function seedEndedSpaceMeeting() {
  const now = new Date();
  for (const id of ["usr_owner", "usr_member"]) {
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
  const spaceId = await seedSharedSpace(db, {
    id: "space_resume",
    ownerUserId: "usr_owner",
    slug: "resume",
    members: [
      { userId: "usr_owner", role: "owner" },
      { userId: "usr_member", role: "member" },
    ],
  });
  await db.insert(meetingLinks).values({
    id: "link_resume",
    code: "res-umes-lnk",
    reusePolicy: "reusable",
    spaceId,
    spaceKind: "shared",
    title: null,
    allowGuests: false,
    joinPolicy: "open",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(meetings).values({
    id: "meet_ended",
    meetingLinkId: "link_resume",
    spaceId,
    spaceKind: "shared",
    title: null,
    startedByUserId: "usr_owner",
    status: "ended",
    endReason: "host",
    billingPrincipalType: "user",
    billingPrincipalId: "usr_owner",
    billingPlan: "free",
    allowGuests: false,
    recordingEnabled: false,
    joinPolicy: "open",
    startedAt: now,
    endedAt: now,
    firstJoinedAt: now,
    updatedAt: now,
  });
}

function context(): RequestFnContext {
  // The resume check answers before the coordinator, billing or cookies are reached.
  return { env: {} as Env, db, user: { id: "usr_member", name: "Member" }, clientIP: "203.0.113.7" } as unknown as RequestFnContext;
}

describe("joining back into a meeting that ended", () => {
  it("answers MEETING_ENDED instead of starting the link's next meeting", async () => {
    await seedEndedSpaceMeeting();

    const result = await joinMeetingImpl({
      data: {
        code: "res-umes-lnk",
        clientAttemptId: crypto.randomUUID(),
        resumeMeetingId: "meet_ended",
      },
      context: context(),
    });

    expect(result).toMatchObject({ state: "blocked", code: "MEETING_ENDED", retryable: false });
    const occurrences = await db.select({ id: meetings.id }).from(meetings).where(eq(meetings.meetingLinkId, "link_resume"));
    expect(occurrences.map((row) => row.id)).toEqual(["meet_ended"]);
  });

  it("answers MEETING_ENDED when the link already runs a different meeting", async () => {
    await seedEndedSpaceMeeting();
    const now = new Date();
    await db.insert(meetings).values({
      id: "meet_next",
      meetingLinkId: "link_resume",
      spaceId: "space_resume",
      spaceKind: "shared",
      title: null,
      startedByUserId: "usr_owner",
      status: "open",
      billingPrincipalType: "user",
      billingPrincipalId: "usr_owner",
      billingPlan: "free",
      allowGuests: false,
      recordingEnabled: false,
      joinPolicy: "open",
      startedAt: now,
      updatedAt: now,
    });

    const result = await joinMeetingImpl({
      data: { code: "res-umes-lnk", clientAttemptId: crypto.randomUUID(), resumeMeetingId: "meet_ended" },
      context: context(),
    });

    expect(result).toMatchObject({ state: "blocked", code: "MEETING_ENDED" });
  });
});
