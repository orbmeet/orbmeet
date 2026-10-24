import { beforeEach, describe, expect, it, vi } from "vitest";
import { meetingLinks, meetings, users } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";
import { immediateJobStep } from "@/test/jobs";

const generate = vi.hoisted(() => ({
  result: vi.fn(async (): Promise<{ summary: unknown; error?: string }> => ({ summary: { id: "s" } })),
}));
vi.mock("@/modules/transcripts/server/generate-summary.server", () => ({
  generateMeetingSummaryForMeeting: generate.result,
}));
const jobs = vi.hoisted(() => ({ started: [] as unknown[] }));
vi.mock("@/platform/jobs/jobs", async (original) => ({
  ...(await original<object>()),
  startJob: async (_env: unknown, job: unknown) => {
    jobs.started.push(job);
  },
}));

const { requestMeetingSummary, summarizeMeeting } = await import("./summary-jobs");

const configured = { AI_API_KEY: "key", AI_MODEL: "model" } as unknown as Env;
const T0 = new Date("2026-07-01T10:00:00.000Z");
let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
  generate.result.mockClear();
  jobs.started.length = 0;
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
    startedAt: T0, endedAt: new Date(T0.getTime() + 60_000), updatedAt: new Date(T0.getTime() + 60_000),
    transcriptSegmentCount: 3, summaryStatus: "pending", summaryRequestSeq: 3,
  });
});

const meeting = () => db.query.meetings.findFirst({
  where: { id: "meeting_1" },
  columns: { summaryStatus: true, summarySkipReason: true },
});
const request = (seq: number) => ({ meetingId: "meeting_1", seq, requestedAt: 0 });

describe("summarizeMeeting", () => {
  it("summarizes for the current request and settles the Summary", async () => {
    await summarizeMeeting(immediateJobStep(), db, configured, request(3));
    expect(generate.result).toHaveBeenCalledOnce();
    await expect(meeting()).resolves.toEqual({ summaryStatus: "settled", summarySkipReason: null });
  });

  it("steps aside for a newer request, leaving the Summary owed to it", async () => {
    await summarizeMeeting(immediateJobStep(), db, configured, request(2));
    expect(generate.result).not.toHaveBeenCalled();
    await expect(meeting()).resolves.toEqual({ summaryStatus: "pending", summarySkipReason: null });
  });

  it("settles without a model run when there is nothing to summarize", async () => {
    await db.update(meetings).set({ transcriptSegmentCount: 0 }).where(eq(meetings.id, "meeting_1"));
    await summarizeMeeting(immediateJobStep(), db, configured, request(3));
    expect(generate.result).not.toHaveBeenCalled();
    await expect(meeting()).resolves.toEqual({ summaryStatus: "settled", summarySkipReason: "no_transcript" });
  });

  it("retries a failed generation, then records the Summary as failed", async () => {
    generate.result.mockResolvedValue({ summary: null, error: "llm_failed" });
    await summarizeMeeting(immediateJobStep(), db, configured, request(3));
    expect(generate.result.mock.calls.length).toBeGreaterThan(1);
    await expect(meeting()).resolves.toEqual({ summaryStatus: "failed", summarySkipReason: null });
    generate.result.mockResolvedValue({ summary: { id: "s" } });
  });

  it("stops retrying once a newer request supersedes it, spending no further model runs", async () => {
    generate.result.mockImplementation(async () => {
      // A late segment lands while this request's generation is failing.
      await db.update(meetings).set({ transcriptSegmentCount: 4, summaryRequestSeq: 4 }).where(eq(meetings.id, "meeting_1"));
      return { summary: null, error: "llm_failed" };
    });
    await summarizeMeeting(immediateJobStep(), db, configured, request(3));
    expect(generate.result).toHaveBeenCalledOnce();
    // The newer request's job owns the Summary.
    await expect(meeting()).resolves.toEqual({ summaryStatus: "pending", summarySkipReason: null });
    generate.result.mockReset();
    generate.result.mockResolvedValue({ summary: { id: "s" } });
  });

  it("stands down when the Summary was already settled", async () => {
    await db.update(meetings).set({ summaryStatus: "settled" }).where(eq(meetings.id, "meeting_1"));
    await summarizeMeeting(immediateJobStep(), db, configured, request(3));
    expect(generate.result).not.toHaveBeenCalled();
    await expect(meeting()).resolves.toEqual({ summaryStatus: "settled", summarySkipReason: null });
  });

  it("settles a known final outcome with its reason rather than retrying it", async () => {
    generate.result.mockResolvedValueOnce({ summary: null, error: "transcript_too_large" });
    await summarizeMeeting(immediateJobStep(), db, configured, request(3));
    expect(generate.result).toHaveBeenCalledOnce();
    await expect(meeting()).resolves.toEqual({ summaryStatus: "settled", summarySkipReason: "transcript_too_large" });
  });
});

describe("requestMeetingSummary", () => {
  it("owes a Summary under a new request number, with a job of its own", async () => {
    await db.update(meetings)
      .set({ summaryStatus: "settled", summarySkipReason: "no_transcript" })
      .where(eq(meetings.id, "meeting_1"));
    await requestMeetingSummary(db, configured, "meeting_1");
    await expect(meeting()).resolves.toEqual({ summaryStatus: "pending", summarySkipReason: null });
    expect(jobs.started).toEqual([expect.objectContaining({ kind: "summarizeMeeting", meetingId: "meeting_1", seq: 4 })]);
  });

  it("starts runnable work every time, even for a transcript it was asked about before", async () => {
    // Job ids derived from the transcript once let a second request for the
    // same transcript reopen the Summary under a job that had already ended.
    await requestMeetingSummary(db, configured, "meeting_1");
    await summarizeMeeting(immediateJobStep(), db, configured, request(4));
    await expect(meeting()).resolves.toEqual({ summaryStatus: "settled", summarySkipReason: null });

    await requestMeetingSummary(db, configured, "meeting_1");
    await expect(meeting()).resolves.toEqual({ summaryStatus: "pending", summarySkipReason: null });
    const [first, second] = jobs.started as Array<{ seq: number }>;
    expect(second.seq).toBeGreaterThan(first.seq);
    await summarizeMeeting(immediateJobStep(), db, configured, request(second.seq));
    await expect(meeting()).resolves.toEqual({ summaryStatus: "settled", summarySkipReason: null });
  });

  it("hands a job started before requests were numbered to a numbered request", async () => {
    await summarizeMeeting(immediateJobStep(), db, configured, { meetingId: "meeting_1", requestedAt: 0 });
    expect(generate.result).not.toHaveBeenCalled();
    expect(jobs.started).toEqual([expect.objectContaining({ kind: "summarizeMeeting", seq: 4 })]);
  });

  it("owes nothing when summaries are not configured, or for a meeting still open", async () => {
    await requestMeetingSummary(db, {} as Env, "meeting_1");
    await db.update(meetings).set({ status: "open", endedAt: null }).where(eq(meetings.id, "meeting_1"));
    await requestMeetingSummary(db, configured, "meeting_1");
    expect(jobs.started).toEqual([]);
  });
});
