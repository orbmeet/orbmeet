import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@orbmeet/db";
import { eq } from "drizzle-orm";
import { meetingFollowUps, meetingLinks, meetingSummaries, meetings, transcripts, users } from "@orbmeet/db/schema";
import { createTestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";

const model = vi.hoisted(() => ({ answer: vi.fn() }));
vi.mock("@/platform/ai/gemini", () => ({ createGeminiTextAdapter: vi.fn() }));
vi.mock("@tanstack/ai", () => ({ chat: () => model.answer() }));

const { generateMeetingSummaryForMeeting } = await import("./generate-summary.server");

const env = { AI_API_KEY: "key", AI_MODEL: "model" } as unknown as Env;
const startedAt = new Date("2026-06-12T12:00:00.000Z");
const spokenAt = new Date(startedAt.getTime() + 30_000);

const summaryObject = {
  title: "Solving two-step equations",
  summary: "The class worked through two-step equations.",
  moments: [],
  followUps: [{ task: "Send the practice set", owner: "Host" }, { task: "Book the next session" }],
};

/**
 * An ended, untitled meeting whose transcript is settled, owed a Summary
 * under request 1. The transcript's insert trigger keeps the meeting's
 * transcript counters.
 */
async function seed(): Promise<Database> {
  const db = await createTestDb();
  await db.insert(users).values({
    id: "host", name: "Host", email: "host@example.com", normalizedEmail: "host@example.com",
    role: "user", createdAt: startedAt, updatedAt: startedAt,
  });
  await seedPersonalSpace(db, "host");
  await db.insert(meetingLinks).values({
    id: "room_1", code: "abc-defg-hij", spaceId: "host_space", spaceKind: "personal",
    allowGuests: true, createdAt: startedAt, updatedAt: startedAt,
  });
  await db.insert(meetings).values({
    id: "meeting_1", meetingLinkId: "room_1", startedByUserId: "host", spaceId: "host_space",
    spaceKind: "personal", title: null, status: "ended", billingPrincipalType: "user",
    billingPrincipalId: "host", billingPlan: "free", allowGuests: true, recordingEnabled: false,
    startedAt, endedAt: new Date(startedAt.getTime() + 600_000), updatedAt: startedAt,
    summaryStatus: "pending", summaryRequestSeq: 1,
  });
  await db.insert(transcripts).values({
    id: "tr_1", meetingId: "meeting_1", participantIdentity: "host", participantName: "Host",
    text: "Today we solve two-step equations. ".repeat(12), segmentId: "segment-1",
    startedAt: spokenAt, updatedAt: spokenAt,
  });
  return db;
}

const meetingTitle = async (db: Database) =>
  (await db.query.meetings.findFirst({ where: { id: "meeting_1" }, columns: { title: true } }))?.title;

describe("generateMeetingSummaryForMeeting", () => {
  beforeEach(() => {
    model.answer.mockReset().mockResolvedValue(summaryObject);
  });

  it("writes the Summary, its follow-ups and the meeting's name for the request owed one", async () => {
    const db = await seed();

    const result = await generateMeetingSummaryForMeeting(db, env, { meetingId: "meeting_1", seq: 1 });

    expect(result).toMatchObject({ generated: true, summary: { summary: summaryObject.summary, transcriptSegmentCount: 1 } });
    expect(result.summary?.transcriptLastUpdatedAt).toEqual(spokenAt);
    expect((await db.select().from(meetingFollowUps)).map((row) => row.text).sort())
      .toEqual(["Book the next session", "Send the practice set"]);
    expect(await meetingTitle(db)).toBe("Solving two-step equations");
  });

  it("writes nothing for a request a newer one superseded while the model ran", async () => {
    const db = await seed();
    model.answer.mockImplementation(async () => {
      await db.update(meetings).set({ summaryRequestSeq: 2 }).where(eq(meetings.id, "meeting_1"));
      return summaryObject;
    });

    const result = await generateMeetingSummaryForMeeting(db, env, { meetingId: "meeting_1", seq: 1 });

    expect(result).toMatchObject({ generated: false, error: "superseded" });
    await expect(db.select().from(meetingSummaries)).resolves.toEqual([]);
    await expect(db.select().from(meetingFollowUps)).resolves.toEqual([]);
    expect(await meetingTitle(db)).toBeNull();
  });

  it("adds each follow-up once when a newer request's job runs while an older one's model does", async () => {
    const db = await seed();
    model.answer.mockImplementationOnce(async () => {
      // A replayed delivery owes the Summary again, and its job runs to the
      // end while this one waits on the model.
      await db.update(meetings).set({ summaryRequestSeq: 2 }).where(eq(meetings.id, "meeting_1"));
      await expect(generateMeetingSummaryForMeeting(db, env, { meetingId: "meeting_1", seq: 2 }))
        .resolves.toMatchObject({ generated: true });
      return summaryObject;
    });

    await expect(generateMeetingSummaryForMeeting(db, env, { meetingId: "meeting_1", seq: 1 }))
      .resolves.toMatchObject({ generated: false, error: "superseded" });

    await expect(db.select().from(meetingFollowUps)).resolves.toHaveLength(2);
    await expect(db.select().from(meetingSummaries)).resolves.toHaveLength(1);
  });

  it("does not name the meeting from a transcript that changed while the model ran", async () => {
    const db = await seed();
    model.answer.mockImplementation(async () => {
      await db.update(meetings).set({ transcriptSegmentCount: 2 }).where(eq(meetings.id, "meeting_1"));
      return summaryObject;
    });

    const result = await generateMeetingSummaryForMeeting(db, env, { meetingId: "meeting_1", seq: 1 });

    expect(result).toMatchObject({ generated: false, error: "transcript_changing" });
    expect(await meetingTitle(db)).toBeNull();
  });
});
