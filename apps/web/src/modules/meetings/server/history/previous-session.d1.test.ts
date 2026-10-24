import { beforeEach, describe, expect, it } from "vitest";
import { meetingLinks, meetingSummaries, meetings, users } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { seedSharedSpace } from "@/test/fixtures";
import { selectPreviousSession, summaryExcerpt } from "./previous-session.server";

let db: TestDb;

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

async function seedSpaceLink() {
  await insertUser("owner");
  await insertUser("member");
  await insertUser("outsider");
  await seedSharedSpace(db, {
    id: "space_algebra",
    ownerUserId: "owner",
    members: [
      { userId: "owner", role: "owner" },
      { userId: "member", role: "member" },
    ],
  });
  const now = new Date();
  await db.insert(meetingLinks).values({
    id: "link_algebra",
    code: "abc-defg-hij",
    reusePolicy: "reusable",
    spaceId: "space_algebra",
    spaceKind: "shared",
    title: null,
    allowGuests: false,
    joinPolicy: "open",
    createdAt: now,
    updatedAt: now,
  });
}

async function insertMeeting(id: string, status: "open" | "ended", endedAt: Date | null, title: string | null = null) {
  const startedAt = new Date((endedAt ?? new Date()).getTime() - 60 * 60 * 1000);
  await db.insert(meetings).values({
    id,
    meetingLinkId: "link_algebra",
    spaceId: "space_algebra",
    spaceKind: "shared",
    startedByUserId: "owner",
    status,
    title,
    billingPrincipalType: "user",
    billingPrincipalId: "owner",
    billingPlan: "free",
    allowGuests: false,
    recordingEnabled: false,
    startedAt,
    endedAt,
    updatedAt: endedAt ?? startedAt,
  });
}

async function insertSummary(meetingId: string, summary: string) {
  await db.insert(meetingSummaries).values({
    id: `summary_${meetingId}`,
    meetingId,
    summary,
    durationSeconds: 2880,
    participantCount: 4,
    transcriptSegmentCount: 10,
  });
}

describe("selectPreviousSession", () => {
  it("returns the most recently ended session on the link, with the opening of its summary", async () => {
    await seedSpaceLink();
    await insertMeeting("meeting_old", "ended", new Date("2026-09-18T19:00:00Z"));
    await insertMeeting("meeting_last", "ended", new Date("2026-09-25T19:00:00Z"), "Quadratics");
    await insertSummary("meeting_last", "We practised completing the square. Yousuf took problem set 3.");

    const previous = await selectPreviousSession(db, "abc-defg-hij", "member");
    expect(previous).toEqual({
      meetingId: "meeting_last",
      title: "Quadratics",
      endedAt: "2026-09-25T19:00:00.000Z",
      durationSeconds: 2880,
      participantCount: 4,
      excerpt: "We practised completing the square. Yousuf took problem set 3.",
    });
  });

  it("ignores the session that is running now", async () => {
    await seedSpaceLink();
    await insertMeeting("meeting_last", "ended", new Date("2026-09-25T19:00:00Z"));
    await insertMeeting("meeting_now", "open", null);
    expect((await selectPreviousSession(db, "abc-defg-hij", "member"))?.meetingId).toBe("meeting_last");
  });

  it("shows nothing to someone who may not read the link's history, or to a guest", async () => {
    await seedSpaceLink();
    await insertMeeting("meeting_last", "ended", new Date("2026-09-25T19:00:00Z"));
    await insertSummary("meeting_last", "Private notes.");
    expect(await selectPreviousSession(db, "abc-defg-hij", "outsider")).toBeNull();
    expect(await selectPreviousSession(db, "abc-defg-hij", null)).toBeNull();
  });

  it("still names the session when its summary has not been written", async () => {
    await seedSpaceLink();
    await insertMeeting("meeting_last", "ended", new Date("2026-09-25T19:00:00Z"));
    expect(await selectPreviousSession(db, "abc-defg-hij", "member")).toMatchObject({
      meetingId: "meeting_last",
      excerpt: null,
      durationSeconds: null,
    });
  });
});

describe("summaryExcerpt", () => {
  it("keeps a short summary whole", () => {
    expect(summaryExcerpt("Short and sweet.")).toBe("Short and sweet.");
  });

  it("cuts at a sentence when one ends in range", () => {
    const text = `${"First sentence is here. ".repeat(6)}And a tail that runs past the limit for sure.`;
    const excerpt = summaryExcerpt(text, 100);
    expect(excerpt.endsWith(".")).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(100);
  });

  it("otherwise cuts at a word and says so", () => {
    const excerpt = summaryExcerpt("word ".repeat(80), 50);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt).not.toMatch(/wor…$/);
  });
});
