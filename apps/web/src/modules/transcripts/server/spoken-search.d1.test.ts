import { seedPersonalSpace } from "@/test/fixtures";
import { beforeEach, describe, expect, it } from "vitest";
import { meetings, meetingLinks, transcripts, users } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { selectMySpokenLines } from "./spoken-search.server";

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
});

const start = new Date("2026-10-15T00:33:00.000Z");

async function insertUser(id: string) {
  await db.insert(users).values({
    id,
    name: id,
    email: `${id}@example.com`,
    normalizedEmail: `${id}@example.com`,
    image: null,
    plan: "free",
    role: "user",
    createdAt: start,
    updatedAt: start,
  });
  await seedPersonalSpace(db, id, { spaceId: `${id}_space`, now: start });
}

async function insertMeeting(owner: string, id: string, status: "ended" | "open" = "ended") {
  await db.insert(meetingLinks).values({
    id: `link_${id}`,
    code: `ab${"xyzw"[Number(id.slice(-1))]}-defg-hij`,
    spaceId: `${owner}_space`,
    spaceKind: "personal" as const,
    allowGuests: true,
    createdAt: start,
    updatedAt: start,
  });
  await db.insert(meetings).values({
    id,
    meetingLinkId: `link_${id}`,
    spaceId: `${owner}_space`,
    spaceKind: "personal" as const,
    startedByUserId: owner,
    title: "Exponents",
    status,
    billingPrincipalType: "user" as const,
    billingPrincipalId: owner,
    billingPlan: "free",
    allowGuests: true,
    recordingEnabled: false,
    startedAt: start,
    endedAt: status === "ended" ? new Date(start.getTime() + 3_600_000) : null,
    updatedAt: start,
  });
}

async function say(meetingId: string, id: string, text: string, secondsIn: number) {
  const at = new Date(start.getTime() + secondsIn * 1000);
  await db.insert(transcripts).values({
    id,
    meetingId,
    participantIdentity: "speaker",
    participantName: "Orion Ray",
    text,
    segmentId: `segment_${id}`,
    startedAt: at,
    updatedAt: at,
  });
}

describe("selectMySpokenLines", () => {
  it("finds what was said in the viewer's meetings, with how far in it was said", async () => {
    await insertUser("atiq");
    await insertMeeting("atiq", "meeting_1");
    await say("meeting_1", "t1", "Divisibility by three: sum the digits", 372);
    await say("meeting_1", "t2", "When it’s a power of a power, you multiply the Exponents", 1325);

    const lines = await selectMySpokenLines(db, { id: "atiq" }, { search: "exponents", scope: "all", limit: 12 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ id: "t2", meetingId: "meeting_1", speaker: "Orion Ray", offsetMs: 1_325_000 });
  });

  it("never finds lines in someone else's meetings, or in a meeting still running", async () => {
    await insertUser("atiq");
    await insertUser("other");
    await insertMeeting("other", "meeting_2");
    await say("meeting_2", "t3", "exponents everywhere", 10);
    await insertMeeting("atiq", "meeting_3", "open");
    await say("meeting_3", "t4", "exponents, live", 10);

    expect(await selectMySpokenLines(db, { id: "atiq" }, { search: "exponents", scope: "all", limit: 12 })).toEqual([]);
  });
});
