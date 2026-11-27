/**
 * Server implementations behind the RPC declarations in this directory.
 * Split from the sibling RPC file so the declaration file carries no
 * DB/Drizzle imports and stays safe to include in client route graphs.
 */

import type { Database } from "@orbmeet/db";
import { meetingConnections, meetingFollowUps, meetingSummaries, meetings } from "@orbmeet/db/schema";
import { and, countDistinct, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { generateId } from "@/lib/ids";
import { generateGeminiJson } from "@/platform/ai/gemini";
import { logError } from "@/lib/logger";
import { boardOutlineForMeeting } from "./board-outline.server";
import { nameUntitledMeetingStatements } from "./meeting-name.server";
import { planFollowUps } from "./follow-up-plan";
import {
  buildChunkPrompt,
  buildReducePrompt,
  buildSingleChunkPrompt,
  MAX_FOLLOW_UPS,
  summarySchema,
  toMoments,
  type SummaryObject,
} from "./summary-prompts";
import {
  buildTranscriptChunks,
  getTranscriptSnapshot,
  MIN_TRANSCRIPT_CHARS,
  summaryMatchesTranscriptSnapshot,
  waitForTranscriptSettlement,
} from "./transcript-chunks";

const SUMMARY_PROVIDER_TIMEOUT_MS = 90_000;

async function countMeetingParticipants(db: Database, meetingId: string): Promise<number> {
  const [row] = await db
    .select({ value: countDistinct(meetingConnections.admissionId) })
    .from(meetingConnections)
    .where(
      and(eq(meetingConnections.meetingId, meetingId), isNotNull(meetingConnections.connectedAt)),
    );
  return row?.value ?? 0;
}

/** The AI configuration the summary generators require, or null when the
 * optional AI_API_KEY is unset — callers surface `ai_not_configured`. */
function aiConfig(env: Env): {
  apiKey: string;
  model: string;
  fallback: string | undefined;
} | null {
  if (!env.AI_API_KEY || !env.AI_MODEL) return null;
  return {
    apiKey: env.AI_API_KEY,
    model: env.AI_MODEL,
    fallback: env.AI_MODEL_FALLBACK,
  };
}

async function generateSummaryObject(
  ai: { apiKey: string; model: string; fallback: string | undefined },
  prompt: string,
): Promise<SummaryObject | null> {
  const modelIds = [ai.model, ai.fallback].filter((id): id is string => Boolean(id));
  for (const modelId of modelIds) {
    try {
      return await generateGeminiJson({
        apiKey: ai.apiKey,
        model: modelId,
        prompt,
        schema: summarySchema,
        timeoutMs: SUMMARY_PROVIDER_TIMEOUT_MS,
      });
    } catch (err) {
      logError("[generateMeetingSummary] Model failed", { model: modelId }, err);
    }
  }
  return null;
}

/**
 * Generate AI meeting notes for an ended meeting using Gemini.
 *
 * Only the meeting's summary job calls this (./summary-jobs.ts); its request
 * numbering is what keeps a superseded generation from being kept. Idempotent
 * for an unchanged transcript: a summary is regenerated only when later
 * transcript segments make its stored snapshot stale.
 *
 * Returns one of:
 *  - `{ summary, generated: true|false }`
 *  - `{ summary: null, generated: false, error: "ai_not_configured"
 *      | "no_transcript" | "meeting_not_ended" | "llm_failed"
 *      | "transcript_too_large" | "transcript_changing" | "superseded" }`
 */
export async function generateMeetingSummaryForMeeting(
  db: Database,
  env: Env,
  request: SummaryRequest,
) {
  const { meetingId } = request;
  const ai = aiConfig(env);
  if (!ai) {
    return { summary: null, generated: false, error: "ai_not_configured" as const };
  }

  const meeting = await db.query.meetings.findFirst({
    where: { id: meetingId },
  });
  if (!meeting || meeting.status !== "ended") {
    return { summary: null, generated: false, error: "meeting_not_ended" as const };
  }

  const existing = await db.query.meetingSummaries.findFirst({
    where: { meetingId: meetingId },
  });
  const initialSnapshot = await getTranscriptSnapshot(db, meetingId);
  if (existing && summaryMatchesTranscriptSnapshot(existing, initialSnapshot)) {
    return { summary: existing, generated: false };
  }

  // The durable summary task owns the post-end transcript grace window. Once it
  // invokes this generator, an empty snapshot needs no settlement polling.
  if (initialSnapshot.segmentCount === 0) {
    return { summary: null, generated: false, error: "no_transcript" as const };
  }

  const settledSnapshot = await waitForTranscriptSettlement(db, meetingId, initialSnapshot);
  const transcript = await buildTranscriptChunks(db, meetingId, meeting.startedAt ?? null);
  if (transcript.tooLarge) {
    return { summary: null, generated: false, error: "transcript_too_large" as const };
  }
  if (transcript.totalChars < MIN_TRANSCRIPT_CHARS || transcript.chunks.length === 0) {
    return { summary: null, generated: false, error: "no_transcript" as const };
  }
  if (
    transcript.segmentCount !== settledSnapshot.segmentCount ||
    (transcript.lastUpdatedAt?.getTime() ?? null) !==
      (settledSnapshot.lastUpdatedAt?.getTime() ?? null)
  ) {
    return { summary: null, generated: false, error: "transcript_changing" as const };
  }

  const durationSeconds =
    meeting.endedAt && meeting.startedAt
      ? Math.round((meeting.endedAt.getTime() - meeting.startedAt.getTime()) / 1000)
      : null;
  const durationLabel = durationSeconds
    ? durationSeconds >= 3600
      ? `${Math.floor(durationSeconds / 3600)}h ${Math.floor((durationSeconds % 3600) / 60)}m`
      : durationSeconds >= 60
        ? `${Math.floor(durationSeconds / 60)}m`
        : `${durationSeconds}s`
    : null;
  const participantList = transcript.participantNames.join(", ");
  const boardOutline = await boardOutlineForMeeting(db, env, meetingId);

  const meetingContext = [
    meeting.title ? `Meeting: "${meeting.title}"` : null,
    durationLabel ? `Duration: ${durationLabel}` : null,
    participantList ? `Participants: ${participantList}` : null,
    // What was worked through on the board, not only what was said about it.
    boardOutline ? `The board, page by page:\n${boardOutline}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  let object: SummaryObject | null;
  if (transcript.chunks.length === 1) {
    object = await generateSummaryObject(
      ai,
      buildSingleChunkPrompt({
        transcriptText: transcript.chunks[0],
        meetingContext,
      }),
    );
  } else {
    const chunkSummaries: SummaryObject[] = [];
    for (let i = 0; i < transcript.chunks.length; i++) {
      const chunkObject = await generateSummaryObject(
        ai,
        buildChunkPrompt({
          chunk: transcript.chunks[i],
          chunkIndex: i,
          chunkCount: transcript.chunks.length,
          meetingContext,
        }),
      );
      if (!chunkObject) return { summary: null, generated: false, error: "llm_failed" as const };
      chunkSummaries.push(chunkObject);
    }
    object = await generateSummaryObject(
      ai,
      buildReducePrompt({ chunkSummaries, meetingContext }),
    );
  }
  if (!object) return { summary: null, generated: false, error: "llm_failed" as const };

  const finalSnapshot = await getTranscriptSnapshot(db, meetingId);
  if (
    !summaryMatchesTranscriptSnapshot(
      {
        transcriptSegmentCount: transcript.segmentCount,
        transcriptLastUpdatedAt: transcript.lastUpdatedAt,
      },
      finalSnapshot,
    )
  ) {
    return { summary: null, generated: false, error: "transcript_changing" as const };
  }

  const participantCount = await countMeetingParticipants(db, meetingId);
  const moments = toMoments(object.moments, durationSeconds);
  const owed = summaryStillOwed(request);
  const followUpChanges = await followUpStatements(db, meetingId, object.followUps ?? [], owed);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const nowDate = new Date(nowSeconds * 1000);
  const lastUpdatedSeconds = transcript.lastUpdatedAt ? Math.floor(transcript.lastUpdatedAt.getTime() / 1000) : null;
  const namingChanges = !meeting.title && object.title
    ? nameUntitledMeetingStatements(db, {
        meetingId,
        startedAt: meeting.startedAt,
        proposed: object.title,
        applies: owed,
        now: nowDate,
      })
    : [];
  const [[inserted]] = await db.batch([
    db
      .insert(meetingSummaries)
      .select(
        db
          .select({
            id: sql`${generateId("MEETING_SUMMARY")}`.as("id"),
            meetingId: sql`${meetingId}`.as("meeting_id"),
            summary: sql`${object.summary}`.as("summary"),
            moments: sql`${JSON.stringify(moments)}`.as("moments"),
            durationSeconds: sql`${durationSeconds}`.as("duration_seconds"),
            participantCount: sql`${participantCount}`.as("participant_count"),
            transcribedParticipantCount: sql`${transcript.participantNames.length}`.as("transcribed_participant_count"),
            transcriptSegmentCount: sql`${transcript.segmentCount}`.as("transcript_segment_count"),
            transcriptLastUpdatedAt: sql`${lastUpdatedSeconds}`.as("transcript_last_updated_at"),
            createdAt: sql`${nowSeconds}`.as("created_at"),
          })
          .from(sql`(select 1)`)
          .where(owed),
      )
      .onConflictDoUpdate({
        target: meetingSummaries.meetingId,
        set: {
          summary: object.summary,
          moments,
          durationSeconds,
          participantCount,
          transcribedParticipantCount: transcript.participantNames.length,
          transcriptSegmentCount: transcript.segmentCount,
          transcriptLastUpdatedAt: transcript.lastUpdatedAt,
          createdAt: nowDate,
        },
      })
      .returning(),
    ...followUpChanges,
    ...namingChanges,
  ]);
  if (!inserted) return { summary: null, generated: false, error: "superseded" as const };

  return {
    summary: inserted,
    generated: true,
  };
}

/** Which Summary request a generation answers: the meeting, and the request's number. */
export interface SummaryRequest {
  meetingId: string;
  seq: number;
}

/** True while `request` is the one the meeting is owed a Summary for. */
function summaryStillOwed(request: SummaryRequest): SQL {
  return sql`exists (
    select 1 from ${meetings}
    where ${meetings.id} = ${request.meetingId}
      and ${meetings.summaryRequestSeq} = ${request.seq}
      and ${meetings.summaryStatus} = 'pending'
  )`;
}

/**
 * The statements that bring the Meeting's follow-ups in line with a new
 * Summary's (see `planFollowUps`), to run in the Summary's own batch.
 */
export async function followUpStatements(
  db: Database,
  meetingId: string,
  followUps: NonNullable<SummaryObject["followUps"]>,
  /** Every change applies only while this holds, checked as it is written. */
  applies: SQL,
) {
  const previous = await db
    .select({ id: meetingFollowUps.id, text: meetingFollowUps.text, doneAt: meetingFollowUps.doneAt })
    .from(meetingFollowUps)
    .where(eq(meetingFollowUps.meetingId, meetingId));
  const drafts = followUps
    .map((followUp) => ({ text: followUp.task.trim().slice(0, 300), ownerName: followUp.owner?.trim().slice(0, 200) || null }))
    .filter((followUp) => followUp.text.length > 0)
    .slice(0, MAX_FOLLOW_UPS);
  const plan = planFollowUps(
    previous.map((row) => ({ id: row.id, text: row.text, done: row.doneAt !== null })),
    drafts,
  );
  const nowSeconds = Math.floor(Date.now() / 1000);
  return [
    ...(plan.remove.length > 0
      ? [db.delete(meetingFollowUps).where(and(inArray(meetingFollowUps.id, plan.remove), isNull(meetingFollowUps.doneAt), applies))]
      : []),
    ...plan.keep.map((row) =>
      db
        .update(meetingFollowUps)
        .set(row.rewritten ? { text: row.text, ownerName: row.ownerName, position: row.position } : { position: row.position })
        .where(and(eq(meetingFollowUps.id, row.id), applies)),
    ),
    ...plan.add.map((row) =>
      db.insert(meetingFollowUps).select(
        db
          .select({
            id: sql`${generateId("MEETING_FOLLOW_UP")}`.as("id"),
            meetingId: sql`${meetingId}`.as("meeting_id"),
            position: sql`${row.position}`.as("position"),
            text: sql`${row.text}`.as("text"),
            ownerName: sql`${row.ownerName}`.as("owner_name"),
            doneAt: sql`null`.as("done_at"),
            doneByUserId: sql`null`.as("done_by_user_id"),
            createdAt: sql`${nowSeconds}`.as("created_at"),
          })
          .from(sql`(select 1)`)
          .where(applies),
      ),
    ),
  ];
}
