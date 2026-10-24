import { beforeEach, describe, expect, it } from "vitest";
import { meetingLinks, meetingSchedules, users } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { personalSpaceIdFor, seedPersonalSpace } from "@/test/fixtures";
import { selectMeetingLookupByCode } from "./meeting-lookup.server";

const OWNER = "usr_owner";
let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
  const now = new Date(Date.now() - 60 * 60_000);
  await db.insert(users).values({
    id: OWNER,
    name: "Owner",
    email: "owner@example.com",
    normalizedEmail: "owner@example.com",
    plan: "free",
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
  await seedPersonalSpace(db, OWNER, { now });
  await db.insert(meetingLinks).values({
    id: "link_reusable",
    code: "abc-defg-hij",
    spaceId: personalSpaceIdFor(OWNER),
    spaceKind: "personal",
    reusePolicy: "reusable",
    title: "Personal room",
    allowGuests: true,
    joinPolicy: "open",
    createdAt: now,
    updatedAt: now,
  });
});

async function scheduleStartingIn(minutes: number) {
  const startsAt = new Date(Date.now() + minutes * 60_000);
  await db.insert(meetingSchedules).values({
    id: "schedule_1",
    meetingLinkId: "link_reusable",
    meetingId: null,
    organizerUserId: OWNER,
    spaceId: personalSpaceIdFor(OWNER),
    title: "Design review",
    joinPolicy: "approval_required",
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    timeZone: "UTC",
  });
}

describe("selectMeetingLookupByCode on a reusable link", () => {
  it("advertises the schedule the next join would claim", async () => {
    await scheduleStartingIn(5);
    await expect(selectMeetingLookupByCode(db, "abc-defg-hij", OWNER)).resolves.toMatchObject({
      exists: true,
      title: "Design review",
      joinPolicy: "approval_required",
    });
  });

  it("advertises the link itself while a schedule is still outside its early window", async () => {
    await scheduleStartingIn(3 * 60);
    await expect(selectMeetingLookupByCode(db, "abc-defg-hij", OWNER)).resolves.toMatchObject({
      exists: true,
      title: "Personal room",
      joinPolicy: "open",
    });
  });
});
