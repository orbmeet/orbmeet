import { describe, expect, it } from "vitest";
import { meetingFollowUps, users } from "@orbmeet/db/schema";
import { seedMeeting } from "@/test/documents-test-support";
import { selectMeetingFollowUps, selectMyOpenFollowUps, setFollowUpDoneImpl } from "./follow-ups.server";
import { followUpStatements } from "./generate-summary.server";
import type { AuthFnContext } from "@/app/bootstrap/middleware";

const at = new Date("2026-07-19T01:00:00.000Z");

async function seedFollowUps() {
  const seeded = await seedMeeting("ended");
  await seeded.db.insert(meetingFollowUps).values([
    { id: "follow_up_1", meetingId: "meeting_1", position: 0, text: "Send the practice set", ownerName: "Host", createdAt: at },
    { id: "follow_up_2", meetingId: "meeting_1", position: 1, text: "Review Bayes’ rule", ownerName: null, createdAt: at },
  ]);
  return seeded;
}

const contextFor = (db: Awaited<ReturnType<typeof seedMeeting>>["db"], userId: string) =>
  ({ db, user: { id: userId } }) as unknown as AuthFnContext;

describe("follow-ups", () => {
  it("lists a meeting's follow-ups in order, and ticks one off for everyone", async () => {
    const { db } = await seedFollowUps();
    await setFollowUpDoneImpl({ data: { followUpId: "follow_up_1", done: true }, context: contextFor(db, "user_host") });

    expect(await selectMeetingFollowUps(db, "meeting_1")).toEqual([
      { id: "follow_up_1", text: "Send the practice set", ownerName: "Host", done: true },
      { id: "follow_up_2", text: "Review Bayes’ rule", ownerName: null, done: false },
    ]);
  });

  it("will not let someone who cannot open the meeting tick one off", async () => {
    const { db } = await seedFollowUps();
    await db.insert(users).values({ id: "user_stranger", name: "Stranger", email: "s@example.com", normalizedEmail: "s@example.com", createdAt: at, updatedAt: at });

    await expect(
      setFollowUpDoneImpl({ data: { followUpId: "follow_up_1", done: true }, context: contextFor(db, "user_stranger") }),
    ).rejects.toThrow(/not found/i);
  });

  it("gives Home the open ones from the viewer's recent meetings", async () => {
    const { db } = await seedFollowUps();
    await setFollowUpDoneImpl({ data: { followUpId: "follow_up_2", done: true }, context: contextFor(db, "user_host") });

    const open = await selectMyOpenFollowUps(db, { id: "user_host" }, 5, new Date("2026-07-20T00:00:00.000Z"));
    expect(open.map((followUp) => followUp.id)).toEqual(["follow_up_1"]);
    expect(await selectMyOpenFollowUps(db, { id: "user_host" }, 5, new Date("2026-09-30T00:00:00.000Z"))).toEqual([]);
  });

  it("keeps a ticked follow-up, under its id, when the Summary is written again in other words", async () => {
    const { db } = await seedFollowUps();
    await setFollowUpDoneImpl({ data: { followUpId: "follow_up_1", done: true }, context: contextFor(db, "user_host") });

    const [first, ...rest] = await followUpStatements(db, "meeting_1", [
      { task: "Send the practice set to everyone", owner: "Host" },
      { task: "Book the next session" },
    ]);
    await db.batch([first, ...rest]);

    const after = await selectMeetingFollowUps(db, "meeting_1");
    expect(after.map(({ text, done }) => ({ text, done }))).toEqual([
      { text: "Send the practice set to everyone", done: true },
      { text: "Book the next session", done: false },
    ]);
    expect(after[0].id).toBe("follow_up_1");
    // An open page still holding the old id can tick it back on and off.
    await expect(
      setFollowUpDoneImpl({ data: { followUpId: "follow_up_1", done: false }, context: contextFor(db, "user_host") }),
    ).resolves.toEqual({ id: "follow_up_1", done: false });
  });

  it("keeps one ticked off while the Summary was being written, though the new list drops it", async () => {
    const { db } = await seedFollowUps();
    // The statements are planned while "Review Bayes' rule" is still open…
    const [first, ...rest] = await followUpStatements(db, "meeting_1", [{ task: "Send the practice set", owner: "Host" }]);
    // …and someone ticks it off before they run.
    await setFollowUpDoneImpl({ data: { followUpId: "follow_up_2", done: true }, context: contextFor(db, "user_host") });
    await db.batch([first, ...rest]);

    const after = await selectMeetingFollowUps(db, "meeting_1");
    expect(after.find((followUp) => followUp.id === "follow_up_2")).toMatchObject({ done: true });
  });
});
