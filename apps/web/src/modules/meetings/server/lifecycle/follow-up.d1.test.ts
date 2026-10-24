import { beforeEach, describe, expect, it, vi } from "vitest";
import { meetingLinks, meetings, users } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { DISCONNECTED_TRANSCRIPT_GRACE_MS } from "@/modules/meetings/contract/constants";
import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";
import { immediateJobStep } from "@/test/jobs";

const jobs = vi.hoisted(() => ({ started: [] as unknown[], failKind: null as string | null }));
vi.mock("@/platform/jobs/jobs", async (original) => ({
  ...(await original<object>()),
  startJob: async (_env: unknown, job: { kind: string }) => {
    jobs.started.push(job);
    if (job.kind === jobs.failKind) throw new Error("Workflows unavailable");
  },
}));

const { startMeetingFollowUp, startMeetingWhiteboardCapture } = await import("./follow-up.server");
const { summarizeEndedMeeting } = await import("@/modules/transcripts/server/summary-jobs");

const T0 = new Date("2026-07-01T10:00:00.000Z");
const ENDED_AT = new Date(T0.getTime() + 30 * 60_000);
const configured = { AI_API_KEY: "key", AI_MODEL: "model" } as unknown as Env;
let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
  jobs.started.length = 0;
  jobs.failKind = null;
  await db.insert(users).values({
    id: "host", name: "Host", email: "host@example.com", normalizedEmail: "host@example.com",
    plan: "free", role: "user", createdAt: T0, updatedAt: T0,
  });
  await seedPersonalSpace(db, "host", { now: T0 });
  await db.insert(meetingLinks).values({
    id: "link_1", code: "abc-defg-hij", spaceId: "host_space", spaceKind: "personal",
    allowGuests: true, createdAt: T0, updatedAt: T0,
  });
  await db.insert(meetings).values({
    id: "meeting_1", meetingLinkId: "link_1", spaceId: "host_space", spaceKind: "personal",
    startedByUserId: "host", status: "ended", billingPrincipalType: "user", billingPrincipalId: "host",
    billingPlan: "free", allowGuests: true, recordingEnabled: false, joinPolicy: "open",
    startedAt: T0, endedAt: ENDED_AT, updatedAt: ENDED_AT, summaryStatus: "pending",
  });
});

describe("startMeetingFollowUp", () => {
  it("starts contacts and the Summary as independent jobs", async () => {
    await startMeetingFollowUp(configured, "meeting_1");
    expect(jobs.started).toEqual([
      { kind: "indexMeetingContacts", meetingId: "meeting_1" },
      { kind: "summarizeEndedMeeting", meetingId: "meeting_1" },
    ]);
  });

  it("still starts the other when one cannot start, and fails so the room retries", async () => {
    jobs.failKind = "indexMeetingContacts";
    await expect(startMeetingFollowUp(configured, "meeting_1")).rejects.toThrow("Workflows unavailable");
    expect(jobs.started.map((job) => (job as { kind: string }).kind)).toEqual([
      "indexMeetingContacts",
      "summarizeEndedMeeting",
    ]);
  });

  it("starts the Whiteboard capture as a job of its own, which the room starts once its pins landed", async () => {
    await startMeetingWhiteboardCapture(configured, "meeting_1");
    expect(jobs.started).toEqual([{ kind: "captureMeetingWhiteboards", meetingId: "meeting_1", attempt: 0 }]);
  });
});

describe("summarizeEndedMeeting", () => {
  it("owes the Summary once the transcript has flushed", async () => {
    const step = immediateJobStep();
    await summarizeEndedMeeting(step, db, configured, "meeting_1");

    expect(step.names).toEqual(["read meeting end", "owe the summary"]);
    expect(step.sleeps).toEqual([
      { name: "let the transcript flush", at: ENDED_AT.getTime() + DISCONNECTED_TRANSCRIPT_GRACE_MS },
    ]);
    expect(jobs.started).toEqual([expect.objectContaining({ kind: "summarizeMeeting", meetingId: "meeting_1", seq: 1 })]);
  });

  it("does nothing for a meeting that has not ended", async () => {
    await db.update(meetings).set({ status: "open", endedAt: null }).where(eq(meetings.id, "meeting_1"));
    const step = immediateJobStep();
    await summarizeEndedMeeting(step, db, configured, "meeting_1");
    expect(step.names).toEqual(["read meeting end"]);
  });
});
