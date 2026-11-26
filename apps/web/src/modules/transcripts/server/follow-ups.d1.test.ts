import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { meetingFollowUps } from "@orbmeet/db/schema";
import { seedMeeting } from "@/test/documents-test-support";
import { selectMeetingFollowUps } from "./follow-ups.server";
import { followUpStatements } from "./generate-summary.server";

const at = new Date("2026-07-19T01:00:00.000Z");

async function seedFollowUps() {
  const seeded = await seedMeeting("ended");
  await seeded.db.insert(meetingFollowUps).values([
    { id: "follow_up_1", meetingId: "meeting_1", position: 0, text: "Send the practice set", ownerName: "Host", createdAt: at },
    { id: "follow_up_2", meetingId: "meeting_1", position: 1, text: "Review Bayes’ rule", ownerName: null, createdAt: at },
  ]);
  return seeded;
}

async function markDone(
  db: Awaited<ReturnType<typeof seedMeeting>>["db"],
  followUpId: string,
) {
  await db
    .update(meetingFollowUps)
    .set({ doneAt: at, doneByUserId: "user_host" })
    .where(eq(meetingFollowUps.id, followUpId));
}

describe("follow-ups", () => {
  it("lists a meeting's follow-ups in order with their done state", async () => {
    const { db } = await seedFollowUps();
    await markDone(db, "follow_up_1");

    expect(await selectMeetingFollowUps(db, "meeting_1")).toEqual([
      { id: "follow_up_1", text: "Send the practice set", ownerName: "Host", done: true },
      { id: "follow_up_2", text: "Review Bayes’ rule", ownerName: null, done: false },
    ]);
  });

  it("keeps a ticked follow-up, under its id, when the Summary is written again in other words", async () => {
    const { db } = await seedFollowUps();
    await markDone(db, "follow_up_1");

    const [first, ...rest] = await followUpStatements(db, "meeting_1", [
      { task: "Send the practice set to everyone", owner: "Host" },
      { task: "Book the next session" },
    ], applies);
    await db.batch([first, ...rest]);

    const after = await selectMeetingFollowUps(db, "meeting_1");
    expect(after.map(({ text, done }) => ({ text, done }))).toEqual([
      { text: "Send the practice set to everyone", done: true },
      { text: "Book the next session", done: false },
    ]);
    expect(after[0].id).toBe("follow_up_1");
  });

  it("keeps one ticked off while the Summary was being written, though the new list drops it", async () => {
    const { db } = await seedFollowUps();
    // The statements are planned while "Review Bayes' rule" is still open…
    const [first, ...rest] = await followUpStatements(db, "meeting_1", [{ task: "Send the practice set", owner: "Host" }], applies);
    // …and someone ticks it off before they run.
    await markDone(db, "follow_up_2");
    await db.batch([first, ...rest]);

    const after = await selectMeetingFollowUps(db, "meeting_1");
    expect(after.find((followUp) => followUp.id === "follow_up_2")).toMatchObject({ done: true });
  });

  it("changes nothing once the request it was written for no longer applies", async () => {
    const { db } = await seedFollowUps();
    const before = await selectMeetingFollowUps(db, "meeting_1");

    const [first, ...rest] = await followUpStatements(db, "meeting_1", [
      { task: "Send the practice set to everyone", owner: "Host" },
      { task: "Something new entirely" },
    ], sql`0 = 1`);
    await db.batch([first, ...rest]);

    expect(await selectMeetingFollowUps(db, "meeting_1")).toEqual(before);
  });
});

const applies = sql`1 = 1`;
