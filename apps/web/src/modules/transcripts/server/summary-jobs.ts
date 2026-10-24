import "@tanstack/react-start/server-only";

import type { Database } from "@orbmeet/db";
import { MEETING_SUMMARY_SKIP_REASONS } from "@orbmeet/domain-model";
import { meetingSummaries, meetings } from "@orbmeet/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { withD1Retry } from "@/platform/database/db-utils";
import { logError } from "@/lib/logger";
import { startJob, type JobStep, type JobStepConfig } from "@/platform/jobs/jobs";
import { DISCONNECTED_TRANSCRIPT_GRACE_MS } from "@/modules/meetings/contract/constants";
import { isSummaryGenerationConfigured } from "@/modules/meetings/server/history/summary-generation-policy";
import { generateMeetingSummaryForMeeting } from "./generate-summary.server";

/** Late segments tend to arrive in bursts; let one settle before summarizing it. */
const TRANSCRIPT_QUIET_MS = 5_000;

type SkipReason = (typeof MEETING_SUMMARY_SKIP_REASONS)[number];

/** Outcomes that settle the Summary without one: there is nothing a retry could change. */
function isSkipReason(error: string): error is SkipReason {
  return (MEETING_SUMMARY_SKIP_REASONS as readonly string[]).includes(error);
}

/** A generation is retried for about a day before the Summary is recorded as failed. */
const GENERATE_STEP: JobStepConfig = {
  retries: { limit: 10, delay: 30_000, backoff: "exponential" },
  timeout: 10 * 60_000,
};

/**
 * Summarize a meeting's transcript for request `seq`.
 *
 * Every request numbers itself (see `requestMeetingSummary`) and has a job of
 * its own, so a job only has to ask whether its request is still the latest:
 * a newer one — later transcript text, a replayed delivery — supersedes it,
 * and this job steps aside without writing anything.
 */
export async function summarizeMeeting(
  step: JobStep,
  db: Database,
  env: Env,
  // Jobs started before requests were numbered carry no `seq`.
  input: { meetingId: string; seq?: number; requestedAt: number },
): Promise<void> {
  const { seq } = input;
  if (seq === undefined) {
    // Hand an unnumbered job's Summary to a numbered request, so it is owed
    // by a job that can tell whether it is current.
    await step.do("number the summary request", async () => {
      const meeting = await db.query.meetings.findFirst({
        where: { id: input.meetingId, status: "ended" },
        columns: { summaryStatus: true },
      });
      if (meeting?.summaryStatus === "pending") await requestMeetingSummary(db, env, input.meetingId);
      return null;
    });
    return;
  }
  const request = { meetingId: input.meetingId, seq };

  await step.sleepUntil("let the transcript settle", input.requestedAt + TRANSCRIPT_QUIET_MS);
  const revision = await step.do("check the request is current", () => owedRevision(db, request));
  if (revision === null) return;

  // A transcript with no segments has nothing to summarize.
  let skipReason: SkipReason | null = revision > 0 ? null : "no_transcript";
  if (revision > 0) {
    let outcome: { kind: "generated" } | { kind: "skipped"; reason: SkipReason } | { kind: "superseded" };
    try {
      outcome = await step.do("generate summary", GENERATE_STEP, async () => {
        // Checked on every attempt, not once before them: a step that succeeded
        // is never run again, so only a check inside the retried step stops a
        // superseded request, or one already settled, from spending a model
        // run per retry.
        if ((await owedRevision(db, request)) === null) return { kind: "superseded" as const };
        const result = await generateMeetingSummaryForMeeting(db, env, input.meetingId);
        if (result.summary || result.error === undefined) return { kind: "generated" as const };
        if (isSkipReason(result.error)) return { kind: "skipped" as const, reason: result.error };
        // The meeting is no longer ended: whatever owes it a Summary now is newer.
        if (result.error === "meeting_not_ended") return { kind: "superseded" as const };
        // A model failure or a transcript still changing is retried.
        throw new Error(result.error);
      });
    } catch (error) {
      logError("[summary] Summary generation failed; recording it as failed", {
        meetingId: input.meetingId,
        seq,
      }, error);
      await step.do("record summary failure", () => settleSummary(db, request, "failed", null));
      return;
    }
    if (outcome.kind === "superseded") return;
    if (outcome.kind === "skipped") skipReason = outcome.reason;
  }
  await step.do("record summary", () => settleSummary(db, request, "settled", skipReason));
}

/**
 * Owe an ended meeting's Summary once the transcription agent has had time to
 * flush what it heard last.
 */
export async function summarizeEndedMeeting(step: JobStep, db: Database, env: Env, meetingId: string): Promise<void> {
  const endedAt = await step.do("read meeting end", async () => {
    const meeting = await db.query.meetings.findFirst({
      where: { id: meetingId, status: "ended" },
      columns: { endedAt: true },
    });
    return meeting?.endedAt?.getTime() ?? null;
  });
  if (endedAt === null) return;
  await step.sleepUntil("let the transcript flush", endedAt + DISCONNECTED_TRANSCRIPT_GRACE_MS);
  await step.do("owe the summary", async () => {
    await requestMeetingSummary(db, env, meetingId);
    return null;
  });
}

/**
 * Owe a Summary for the transcript as it stands now. Called when the meeting
 * ends and when transcript text lands after its Summary was settled.
 *
 * Marking the Summary owed and numbering the request are one statement, and
 * the number names the job, so the job started here is new work however many
 * jobs came before it. If starting it fails, this throws and the caller's
 * retry numbers a fresh request.
 */
export async function requestMeetingSummary(db: Database, env: Env, meetingId: string): Promise<void> {
  if (!isSummaryGenerationConfigured(env)) return;
  // Retrying the update may number a request twice. Only the last number
  // gets a job, and it supersedes the other.
  const [meeting] = await withD1Retry(
    () => db
      .update(meetings)
      .set({
        summaryStatus: "pending",
        summarySkipReason: null,
        summaryRequestSeq: sql`${meetings.summaryRequestSeq} + 1`,
      })
      .where(and(eq(meetings.id, meetingId), eq(meetings.status, "ended")))
      .returning({ seq: meetings.summaryRequestSeq }),
    { idempotent: true },
  );
  if (!meeting) return;
  await startJob(env, { kind: "summarizeMeeting", meetingId, seq: meeting.seq, requestedAt: Date.now() });
}

/**
 * Whether the Summary is missing transcript segments that are already
 * committed: the state a replayed transcript delivery has to repair, when the
 * request that wrote its rows failed before it could start the Summary's job.
 * A Summary already `pending` counts too — its job may be the one that never
 * started.
 */
export async function summaryMissesCommittedTranscript(db: Database, meetingId: string): Promise<boolean> {
  const [row] = await db
    .select({
      committedSegments: meetings.transcriptSegmentCount,
      summarizedSegments: sql<number>`coalesce(${meetingSummaries.transcriptSegmentCount}, 0)`,
    })
    .from(meetings)
    .leftJoin(meetingSummaries, eq(meetingSummaries.meetingId, meetings.id))
    .where(eq(meetings.id, meetingId))
    .limit(1);
  return Boolean(row && row.committedSegments > row.summarizedSegments);
}

/** The transcript's segment count, while request `seq` is the one owed a Summary; otherwise null. */
async function owedRevision(db: Database, request: { meetingId: string; seq: number }): Promise<number | null> {
  const meeting = await db.query.meetings.findFirst({
    where: { id: request.meetingId, status: "ended" },
    columns: { transcriptSegmentCount: true, summaryStatus: true, summaryRequestSeq: true },
  });
  return meeting?.summaryRequestSeq === request.seq && meeting.summaryStatus === "pending"
    ? meeting.transcriptSegmentCount
    : null;
}

/** Settle only the request this job owns; a newer request keeps the Summary pending. */
async function settleSummary(
  db: Database,
  request: { meetingId: string; seq: number },
  status: "settled" | "failed",
  skipReason: SkipReason | null,
): Promise<null> {
  await db
    .update(meetings)
    .set({ summaryStatus: status, summarySkipReason: skipReason })
    .where(and(
      eq(meetings.id, request.meetingId),
      eq(meetings.summaryRequestSeq, request.seq),
      eq(meetings.summaryStatus, "pending"),
    ));
  return null;
}
