import { describe, expect, it } from "vitest";
import { meetings, meetingWhiteboards, whiteboards } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";

import { seedMeeting } from "@/test/documents-test-support";
import { nameUntitledMeeting } from "./meeting-name.server";

describe("nameUntitledMeeting", () => {
  it("names a meeting that has no title", async () => {
    const { db } = await seedMeeting("ended");
    await db.update(meetings).set({ title: null }).where(eq(meetings.id, "meeting_1"));

    await nameUntitledMeeting(db, "meeting_1", "“Solving two-step equations.”");

    const row = await db.query.meetings.findFirst({ where: { id: "meeting_1" }, columns: { title: true } });
    expect(row?.title).toBe("Solving two-step equations");
  });

  it("never replaces a title someone chose", async () => {
    const { db } = await seedMeeting("ended");

    await nameUntitledMeeting(db, "meeting_1", "Something else");

    const row = await db.query.meetings.findFirst({ where: { id: "meeting_1" }, columns: { title: true } });
    expect(row?.title).toBe("Product review");
  });

  it("names the meeting's boards that still go by their date, and only those", async () => {
    const { db } = await seedMeeting("ended");
    await db.update(meetings).set({ title: null }).where(eq(meetings.id, "meeting_1"));
    const now = new Date("2026-07-19T00:00:00.000Z");
    for (const [id, title] of [["board_dated", "Whiteboard · Jul 19, 2026"], ["board_named", "Fractions practice"]] as const) {
      await db.insert(whiteboards).values({ id, syncRoomId: `room_${id}`, spaceId: "user_host_space", title, createdAt: now, updatedAt: now });
      await db.insert(meetingWhiteboards).values({
        id: `usage_${id}`,
        meetingId: "meeting_1",
        spaceId: "user_host_space",
        whiteboardId: id,
        attachedAt: now,
      });
    }

    // One put away already is left as it was archived.
    await db.insert(whiteboards).values({
      id: "board_archived",
      syncRoomId: "room_board_archived",
      spaceId: "user_host_space",
      title: "Whiteboard · Jul 18, 2026",
      status: "archived",
      archivedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(meetingWhiteboards).values({
      id: "usage_board_archived",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      whiteboardId: "board_archived",
      attachedAt: now,
    });

    await nameUntitledMeeting(db, "meeting_1", "Solving two-step equations");

    const boards = await db.query.whiteboards.findMany({ columns: { id: true, title: true, updatedAt: true } });
    expect(Object.fromEntries(boards.map((board) => [board.id, board.title]))).toEqual({
      board_dated: "Solving two-step equations",
      board_named: "Fractions practice",
      board_archived: "Whiteboard · Jul 18, 2026",
    });
    // A rename is a change like any other: lists sorted by it see it.
    expect(boards.find((board) => board.id === "board_dated")?.updatedAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it("leaves a board someone named, and an older board the meeting opened", async () => {
    const { db } = await seedMeeting("ended");
    await db.update(meetings).set({ title: null }).where(eq(meetings.id, "meeting_1"));
    const started = new Date("2026-07-19T00:00:00.000Z");
    const earlier = new Date("2026-07-18T09:00:00.000Z");
    const boards = [
      // Made in this meeting by someone east of UTC, where it was already the 20th.
      { id: "board_east", title: "Whiteboard · Jul 20, 2026", createdAt: started },
      // Made in this meeting, and named by hand in the generated style.
      { id: "board_chapter", title: "Whiteboard · Chapter 4 plan", createdAt: started },
      // Made for yesterday's untitled meeting, opened again in this one.
      { id: "board_yesterday", title: "Whiteboard · Jul 18, 2026", createdAt: earlier },
    ];
    for (const board of boards) {
      await db.insert(whiteboards).values({
        ...board,
        syncRoomId: `room_${board.id}`,
        spaceId: "user_host_space",
        updatedAt: board.createdAt,
      });
      await db.insert(meetingWhiteboards).values({
        id: `usage_${board.id}`,
        meetingId: "meeting_1",
        spaceId: "user_host_space",
        whiteboardId: board.id,
        attachedAt: started,
      });
    }

    await nameUntitledMeeting(db, "meeting_1", "Solving two-step equations");

    const rows = await db.query.whiteboards.findMany({ columns: { id: true, title: true } });
    expect(Object.fromEntries(rows.map((board) => [board.id, board.title]))).toEqual({
      board_east: "Solving two-step equations",
      board_chapter: "Whiteboard · Chapter 4 plan",
      board_yesterday: "Whiteboard · Jul 18, 2026",
    });
  });
});
