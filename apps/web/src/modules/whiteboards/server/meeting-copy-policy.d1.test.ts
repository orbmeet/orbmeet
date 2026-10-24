import { describe, expect, it } from "vitest";
import { users } from "@orbmeet/db/schema";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { seedMeeting } from "@/test/documents-test-support";
import { seedMeetingWhiteboard } from "@/test/fixtures";
import type { TestDb } from "@/test/db";
import { setMeetingWhiteboardCopyPolicyImpl } from "./api.server";

// The copy policy guards copies of a past meeting's capture. Managing a past
// meeting is its Space's owner and admins' — there is no host once it ends.

function contextFor(db: TestDb, userId: string) {
  return { db, env: {} as Env, user: { id: userId } } as unknown as AuthFnContext;
}

async function seedPastBoard(status: "open" | "ended" = "ended") {
  const { db, now } = await seedMeeting(status);
  await seedMeetingWhiteboard(db, { meetingId: "meeting_1", spaceId: "user_host_space", focused: false, now });
  await db.insert(users).values({
    id: "user_visitor",
    name: "Visitor",
    email: "visitor@example.com",
    normalizedEmail: "visitor@example.com",
    createdAt: now,
    updatedAt: now,
  });
  return db;
}

const data = { meetingId: "meeting_1", whiteboardId: "whiteboard_meeting_1", allowParticipantCopy: true };

describe("a past meeting's copy policy", () => {
  it("is set by the Space's owner once the meeting has ended", async () => {
    const db = await seedPastBoard();
    await expect(setMeetingWhiteboardCopyPolicyImpl({ data, context: contextFor(db, "user_host") }))
      .resolves.toEqual({ allowParticipantCopy: true });
    const row = await db.query.meetingWhiteboards.findFirst({ where: { meetingId: "meeting_1" } });
    expect(row?.allowParticipantCopy).toBe(true);
  });

  it("is refused to anyone who does not manage the Space", async () => {
    const db = await seedPastBoard();
    await expect(setMeetingWhiteboardCopyPolicyImpl({ data, context: contextFor(db, "user_visitor") }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("waits for the meeting to end", async () => {
    const db = await seedPastBoard("open");
    await expect(setMeetingWhiteboardCopyPolicyImpl({ data, context: contextFor(db, "user_host") }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
