import { describe, expect, it } from "vitest";
import type { Database } from "@orbmeet/db";
import { eq } from "drizzle-orm";
import { meetings, meetingLinks, transcripts, users } from "@orbmeet/db/schema";
import { createTestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";
import {
  buildTranscriptChunks,
  getTranscriptSnapshot,
  summaryMatchesTranscriptSnapshot,
  waitForTranscriptSettlement,
} from "@/modules/transcripts/server/generate-summary.server";

async function seedMeeting(db: Database, baseTime: Date) {
  await db.insert(users).values({
    id: "host",
    name: "Host",
    email: "host@example.com",
    normalizedEmail: "host@example.com",
    image: null,
    plan: "free",
    role: "user",
    createdAt: baseTime,
    updatedAt: baseTime,
  });
  await seedPersonalSpace(db, "host");
  await db.insert(meetingLinks).values({
    id: "room_1",
    code: "abc-defg-hij",
    spaceId: "host_space",
    spaceKind: "personal" as const,
    title: "Meeting",
    allowGuests: true,
    createdAt: baseTime,
    updatedAt: baseTime,
  });
  await seedPersonalSpace(db, "host");
  await db.insert(meetings).values({
    id: "meeting_1",
    meetingLinkId: "room_1",
    startedByUserId: "host",
    spaceId: `${"host"}_space`,
    spaceKind: "personal" as const,
    title: "Meeting",
    status: "ended",
    billingPrincipalType: "user" as const,
    billingPrincipalId: "host",
    billingPlan: "free",
    allowGuests: true,
    recordingEnabled: false,
    startedAt: baseTime,
    endedAt: new Date(baseTime.getTime() + 60_000),
    updatedAt: baseTime,
  });
}

describe("transcript summary snapshots", () => {
  it("reads the meeting's denormalized transcript counters", async () => {
    const db = await createTestDb();
    const now = new Date("2026-06-12T12:00:00.000Z");
    await seedMeeting(db, now);
    const lastIngestedAt = new Date(now.getTime() + 2_000);
    await db
      .update(meetings)
      .set({ transcriptSegmentCount: 2, transcriptLastIngestedAt: lastIngestedAt })
      .where(eq(meetings.id, "meeting_1"));

    const snapshot = await getTranscriptSnapshot(db, "meeting_1");
    expect(snapshot).toEqual({
      segmentCount: 2,
      lastUpdatedAt: lastIngestedAt,
    });
    expect(
      summaryMatchesTranscriptSnapshot(
        {
          transcriptSegmentCount: 2,
          transcriptLastUpdatedAt: lastIngestedAt,
        },
        snapshot,
      ),
    ).toBe(true);
  });

  it("reports an empty snapshot for a meeting without transcripts", async () => {
    const db = await createTestDb();
    const now = new Date("2026-06-12T12:00:00.000Z");
    await seedMeeting(db, now);

    expect(await getTranscriptSnapshot(db, "meeting_1")).toEqual({
      segmentCount: 0,
      lastUpdatedAt: null,
    });
  });
});

describe("Transcript Summary preparation", () => {
  it("keeps participants with the same display name distinct", async () => {
    const db = await createTestDb();
    const now = new Date("2026-06-12T12:00:00.000Z");
    await seedMeeting(db, now);
    await db.insert(transcripts).values([
      {
        id: "tr_1",
        meetingId: "meeting_1",
        participantIdentity: "alex-one",
        participantName: "Alex",
        text: "I will prepare the launch notes.",
        segmentId: "segment-1",
        startedAt: now,
        updatedAt: now,
      },
      {
        id: "tr_2",
        meetingId: "meeting_1",
        participantIdentity: "alex-two",
        participantName: "Alex",
        text: "I will review them tomorrow.",
        segmentId: "segment-2",
        startedAt: new Date(now.getTime() + 1_000),
        updatedAt: new Date(now.getTime() + 1_000),
      },
    ]);

    const prepared = await buildTranscriptChunks(db, "meeting_1", now);

    expect(prepared.participantNames).toEqual(["Alex (1)", "Alex (2)"]);
    expect(prepared.chunks.join("\n")).toContain("[00:00 Alex (1)]");
    expect(prepared.chunks.join("\n")).toContain("[00:01 Alex (2)]");
  });
});

describe("waitForTranscriptSettlement", () => {
  it("returns immediately without polling when the transcript is already quiet", async () => {
    const db = await createTestDb();
    const baseTime = new Date(Date.now() - 60_000);
    await seedMeeting(db, baseTime);
    // Newest ingest is well past the quiet threshold, so settlement is satisfied
    // and the poll loop must be skipped entirely.
    const quietAt = new Date(Date.now() - 30_000);
    await db
      .update(meetings)
      .set({ transcriptSegmentCount: 1, transcriptLastIngestedAt: quietAt })
      .where(eq(meetings.id, "meeting_1"));

    const startedAt = Date.now();
    const settled = await waitForTranscriptSettlement(db, "meeting_1");
    const elapsed = Date.now() - startedAt;

    // The poll loop sleeps for at least one 500ms interval; the fast path does
    // not. A small elapsed time proves the loop was bypassed.
    expect(elapsed).toBeLessThan(250);
    expect(settled.segmentCount).toBe(1);
    expect(settled.lastUpdatedAt).not.toBeNull();
  });

  it("returns the provided initial snapshot without re-reading when already quiet", async () => {
    const db = await createTestDb();
    const baseTime = new Date(Date.now() - 60_000);
    await seedMeeting(db, baseTime);
    const quietAt = new Date(Date.now() - 30_000);
    await db
      .update(meetings)
      .set({ transcriptSegmentCount: 1, transcriptLastIngestedAt: quietAt })
      .where(eq(meetings.id, "meeting_1"));

    const initialSnapshot = await getTranscriptSnapshot(db, "meeting_1");
    const settled = await waitForTranscriptSettlement(db, "meeting_1", initialSnapshot);

    expect(settled).toBe(initialSnapshot);
  });
});
