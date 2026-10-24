import { describe, expect, it } from "vitest";
import { meetingLinks, meetings, meetingWhiteboards, users, whiteboards } from "@orbmeet/db/schema";
import { createTestDb } from "@/test/db";
import { seedMeetingWhiteboard, seedPersonalSpace } from "@/test/fixtures";
import { boundedStatements } from "@/platform/database/db-batching";
import {
  whiteboardUsageColumns,
  selectPresentableWhiteboardsPage,
  selectSpaceWhiteboardsPage,
} from "@/modules/whiteboards/server/api.server";

describe("Whiteboard API queries", () => {
  it("decodes the latest presentation timestamp before serializing it", async () => {
    const db = await createTestDb();
    const now = new Date("2026-07-02T12:34:56.000Z");

    await db.insert(users).values({
      id: "user_1",
      name: "User One",
      email: "user@example.com",
      normalizedEmail: "user@example.com",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(meetingLinks).values({
      id: "link_1",
      code: "abc-defg-hij",
      spaceId: await seedPersonalSpace(db, "user_1", { now }),
      spaceKind: "personal",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(meetings).values({
      id: "meeting_1",
      meetingLinkId: "link_1",
      spaceId: "user_1_space",
      spaceKind: "personal",
      status: "ended",
      billingPrincipalType: "user",
      billingPrincipalId: "user_1",
      billingPlan: "free",
      startedAt: now,
      endedAt: now,
      updatedAt: now,
    });
    await seedMeetingWhiteboard(db, {
      meetingId: "meeting_1",
      spaceId: "user_1_space",
      now,
    });

    const [usage] = await db.select().from(meetingWhiteboards);
    const [row] = await db
      .select({ id: whiteboards.id, lastUsedAt: whiteboardUsageColumns.lastUsedAt })
      .from(whiteboards);

    expect(usage?.whiteboardId).toBe(row?.id);
    expect(usage?.lastPresentedAt).toEqual(now);
    expect(row?.lastUsedAt).toBeInstanceOf(Date);
    expect(row?.lastUsedAt?.toISOString()).toBe(now.toISOString());
  });

  it("keyset-paginates every active Space Whiteboard without gaps", async () => {
    const db = await createTestDb();
    const now = new Date("2026-07-02T12:34:56.000Z");
    await db.insert(users).values({
      id: "user_1",
      name: "User One",
      email: "user@example.com",
      normalizedEmail: "user@example.com",
      createdAt: now,
      updatedAt: now,
    });
    const spaceId = await seedPersonalSpace(db, "user_1", { now });
    const boards = Array.from({ length: 121 }, (_, index) => ({
      id: `board_${String(index).padStart(3, "0")}`,
      syncRoomId: `room_${String(index).padStart(3, "0")}`,
      spaceId,
      title: `Board ${index}`,
      status: "active" as const,
      createdByUserId: "user_1",
      createdAt: new Date(now.getTime() + index * 1000),
      updatedAt: new Date(now.getTime() + index * 1000),
    }));
    for (const insert of boundedStatements(boards, (chunk) => db.insert(whiteboards).values(chunk))) {
      await insert;
    }

    const ids: string[] = [];
    let cursor: { updatedAt: number; id: string } | undefined;
    do {
      const page = await selectSpaceWhiteboardsPage(db, { spaceId, cursor, limit: 50 });
      ids.push(...page.whiteboards.map((board) => board.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(ids).toHaveLength(121);
    expect(new Set(ids).size).toBe(121);
    expect(ids[0]).toBe("board_120");
    expect(ids.at(-1)).toBe("board_000");
  });

  it("searches all presentable Whiteboards before applying pagination", async () => {
    const db = await createTestDb();
    const now = new Date("2026-07-02T12:34:56.000Z");
    await db.insert(users).values({
      id: "user_1",
      name: "User One",
      email: "user@example.com",
      normalizedEmail: "user@example.com",
      createdAt: now,
      updatedAt: now,
    });
    const spaceId = await seedPersonalSpace(db, "user_1", { now });
    const boards = Array.from({ length: 61 }, (_, index) => ({
      id: `search_board_${String(index).padStart(3, "0")}`,
      syncRoomId: `search_room_${String(index).padStart(3, "0")}`,
      spaceId,
      title: index === 0 ? "Needle 100% Plan" : `Ordinary Board ${index}`,
      status: "active" as const,
      createdByUserId: "user_1",
      createdAt: new Date(now.getTime() + index * 1000),
      updatedAt: new Date(now.getTime() + index * 1000),
    }));
    for (const insert of boundedStatements(boards, (chunk) => db.insert(whiteboards).values(chunk))) {
      await insert;
    }

    const firstPage = await selectPresentableWhiteboardsPage(db, {
      userId: "user_1",
      meetingSpaceId: spaceId,
      limit: 50,
    });
    expect(firstPage.whiteboards.map((board) => board.whiteboardId)).not.toContain(
      "search_board_000",
    );

    const result = await selectPresentableWhiteboardsPage(db, {
      userId: "user_1",
      meetingSpaceId: spaceId,
      search: "nEeDlE",
      limit: 10,
    });
    expect(result.whiteboards.map((board) => board.whiteboardId)).toEqual(["search_board_000"]);

    const literalWildcard = await selectPresentableWhiteboardsPage(db, {
      userId: "user_1",
      meetingSpaceId: spaceId,
      search: "%",
      limit: 10,
    });
    expect(literalWildcard.whiteboards.map((board) => board.whiteboardId)).toEqual([
      "search_board_000",
    ]);
  });
});
