import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { meetingLinks, meetings, users } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { listSpaceMeetingsImpl } from "./space-meeting-queries.server";

let db: TestDb;
let spaceId: string;
const base = new Date("2026-09-25T10:00:00.000Z");
const at = (minutes: number) => new Date(base.getTime() + minutes * 60_000);
let codes = 0;
const nextCode = () => `abc-defg-h${String.fromCharCode(97 + Math.floor(codes / 26))}${String.fromCharCode(97 + (codes++ % 26))}`;

async function insertMeeting(
  id: string,
  { startedAt, endedAt }: { startedAt: Date; endedAt: Date | null },
) {
  await db.insert(meetingLinks).values({
    id: `link_${id}`,
    code: nextCode(),
    reusePolicy: "one_time",
    spaceId,
    spaceKind: "personal",
    title: id,
    allowGuests: true,
    createdAt: startedAt,
    updatedAt: startedAt,
  });
  await db.insert(meetings).values({
    id,
    meetingLinkId: `link_${id}`,
    spaceId,
    spaceKind: "personal",
    startedByUserId: "owner",
    title: id,
    status: endedAt ? "ended" : "open",
    billingPrincipalType: "user",
    billingPrincipalId: "owner",
    billingPlan: "free",
    allowGuests: true,
    recordingEnabled: false,
    startedAt,
    endedAt,
    updatedAt: endedAt ?? startedAt,
  });
}

function list(cursor?: string) {
  return listSpaceMeetingsImpl({
    data: { spaceId, limit: 2, cursor },
    context: { user: { id: "owner" }, db } as unknown as AuthFnContext,
  });
}

const ids = (page: Awaited<ReturnType<typeof list>>) => page.meetings.map((meeting) => meeting.id);

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(users).values({
    id: "owner",
    name: "Owner",
    email: "owner@example.com",
    normalizedEmail: "owner@example.com",
    plan: "free",
    role: "user",
    createdAt: base,
    updatedAt: base,
  });
  spaceId = await seedPersonalSpace(db, "owner");
});

describe("listSpaceMeetingsImpl", () => {
  it("lists every open meeting first, then the ended ones by when they ended", async () => {
    await insertMeeting("m_open_old", { startedAt: at(0), endedAt: null });
    await insertMeeting("m_open_new", { startedAt: at(50), endedAt: null });
    // Started earlier but ended later: the end decides the order.
    await insertMeeting("m_ended_a", { startedAt: at(1), endedAt: at(40) });
    await insertMeeting("m_ended_b", { startedAt: at(10), endedAt: at(20) });
    await insertMeeting("m_ended_c", { startedAt: at(11), endedAt: at(12) });

    const first = await list();
    expect(ids(first)).toEqual(["m_open_new", "m_open_old", "m_ended_a", "m_ended_b"]);
    const second = await list(first.nextCursor);
    expect(ids(second)).toEqual(["m_ended_c"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("never serves a meeting twice when it ends between pages", async () => {
    await insertMeeting("m_live", { startedAt: at(0), endedAt: null });
    await insertMeeting("m_ended_a", { startedAt: at(1), endedAt: at(30) });
    await insertMeeting("m_ended_b", { startedAt: at(2), endedAt: at(20) });
    await insertMeeting("m_ended_c", { startedAt: at(3), endedAt: at(10) });

    const first = await list();
    expect(ids(first)).toEqual(["m_live", "m_ended_a", "m_ended_b"]);

    await db
      .update(meetings)
      .set({ status: "ended", endedAt: at(60), updatedAt: at(60) })
      .where(eq(meetings.id, "m_live"));

    const second = await list(first.nextCursor);
    expect(ids(second)).toEqual(["m_ended_c"]);
  });

  it("keeps paging after the meeting a page ended on is deleted", async () => {
    await insertMeeting("m_ended_a", { startedAt: at(1), endedAt: at(30) });
    await insertMeeting("m_ended_b", { startedAt: at(2), endedAt: at(20) });
    await insertMeeting("m_ended_c", { startedAt: at(3), endedAt: at(10) });

    const first = await list();
    expect(ids(first)).toEqual(["m_ended_a", "m_ended_b"]);
    await db.delete(meetings).where(eq(meetings.id, "m_ended_b"));

    expect(ids(await list(first.nextCursor))).toEqual(["m_ended_c"]);
  });

  it("refuses a cursor it did not issue", async () => {
    await expect(list("m_ended_a")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
