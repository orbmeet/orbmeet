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
});
