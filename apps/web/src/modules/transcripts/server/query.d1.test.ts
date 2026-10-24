import { seedPersonalSpace } from "@/test/fixtures";
import { beforeEach, describe, expect, it } from "vitest";
import { meetings, meetingLinks, transcripts, users } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { listTranscriptRowsPage } from "./query";

let db: TestDb;
const getAppDb = () => db;

beforeEach(async () => {
  db = await createTestDb();
});

async function insertMeeting() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  await db.insert(users).values({
    id: "host",
    name: "Host",
    email: "host@example.com",
    normalizedEmail: "host@example.com",
    image: null,
    plan: "free",
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
  await seedPersonalSpace(db, "host");
  await db.insert(meetingLinks).values({
    id: "room_1",
    code: "abc-defg-hij",
    spaceId: "host_space",
spaceKind: "personal" as const,
    title: "Meeting",
    allowGuests: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(meetings).values({
    id: "meeting_1",
    meetingLinkId: "room_1",
    spaceId: "host_space",
    spaceKind: "personal" as const,
    startedByUserId: "host",
    title: "Meeting",
    status: "ended",
    billingPrincipalType: "user" as const,
    billingPrincipalId: "host",
    billingPlan: "free",
    allowGuests: true,
    recordingEnabled: false,
    startedAt: now,
    endedAt: now,
    updatedAt: now,
  });
}

async function insertTranscript(id: string, text: string, startedAt: Date) {
  await db.insert(transcripts).values({
    id,
    meetingId: "meeting_1",
    participantIdentity: "speaker",
    participantName: "Speaker",
    text,
    segmentId: `segment_${id}`,
    startedAt,
    updatedAt: startedAt,
  });
}

describe("listTranscriptRowsPage", () => {
  it("returns stable cursor pages ordered by timestamp and id", async () => {
    await insertMeeting();
    const start = new Date("2026-01-01T00:00:00.000Z");
    await insertTranscript("tr_2", "second", start);
    await insertTranscript("tr_1", "first", start);
    await insertTranscript("tr_3", "third", new Date(start.getTime() + 1_000));

    const firstPage = await listTranscriptRowsPage(getAppDb(), "meeting_1", { limit: 2 });
    expect(firstPage.transcripts.map((row) => row.id)).toEqual(["tr_1", "tr_2"]);
    expect(firstPage.nextCursor).toEqual({
      startedAt: start.getTime(),
      id: "tr_2",
    });

    const secondPage = await listTranscriptRowsPage(getAppDb(), "meeting_1", {
      limit: 2,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.transcripts.map((row) => row.id)).toEqual(["tr_3"]);
    expect(secondPage.nextCursor).toBeNull();
  });
});
