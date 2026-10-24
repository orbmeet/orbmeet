/**
 * Server implementation behind `previous-session.functions.ts`. Split from the RPC file
 * so the declaration file carries no DB/Drizzle imports and stays safe to
 * include in client route graphs.
 */

import type { Database } from "@orbmeet/db";
import { meetingLinks, meetingSummaries, meetings } from "@orbmeet/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { RequestFnContext } from "@/app/bootstrap/middleware";
import { meetingHistoryAccessPredicate } from "@/modules/meetings/server/access/resource-access";
import type { PreviousSession } from "@/modules/meetings/contract/previous-session";

/** Long enough for two or three sentences; the session page has the rest. */
const PREVIOUS_SESSION_EXCERPT_CHARS = 280;

/**
 * The opening of a summary, cut at a sentence when one ends in range and at a
 * word otherwise — never mid-word, and marked when it was cut.
 */
export function summaryExcerpt(summary: string, limit = PREVIOUS_SESSION_EXCERPT_CHARS): string {
  const text = summary.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  const window = text.slice(0, limit);
  const sentenceEnd = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
  if (sentenceEnd >= limit * 0.5) return window.slice(0, sentenceEnd + 1);
  const wordEnd = window.lastIndexOf(" ");
  return `${window.slice(0, wordEnd > 0 ? wordEnd : limit).replace(/[,;:]$/, "")}…`;
}

/**
 * The last session held on this link, for someone about to walk back in.
 *
 * The doorway shows it so that a meeting never starts from nothing when one
 * came before it. It answers only for a viewer who may read that session's
 * history — the same predicate every ended-meeting resource uses — so a guest,
 * or a former Space member, sees no trace of what was said before they came.
 */
export async function selectPreviousSession(
  db: Database,
  code: string,
  viewerUserId: string | null | undefined,
): Promise<PreviousSession | null> {
  if (!viewerUserId) return null;
  const row = await db
    .select({
      meetingId: meetings.id,
      title: meetings.title,
      endedAt: meetings.endedAt,
      summary: meetingSummaries.summary,
      durationSeconds: meetingSummaries.durationSeconds,
      participantCount: meetingSummaries.participantCount,
    })
    .from(meetingLinks)
    .innerJoin(meetings, eq(meetings.meetingLinkId, meetingLinks.id))
    .leftJoin(meetingSummaries, eq(meetingSummaries.meetingId, meetings.id))
    .where(
      and(
        eq(meetingLinks.code, code),
        isNull(meetingLinks.archivedAt),
        eq(meetings.status, "ended"),
        meetingHistoryAccessPredicate(db, viewerUserId),
      ),
    )
    .orderBy(desc(meetings.endedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!row?.endedAt) return null;
  return {
    meetingId: row.meetingId,
    title: row.title,
    endedAt: row.endedAt.toISOString(),
    durationSeconds: row.durationSeconds ?? null,
    participantCount: row.participantCount ?? null,
    excerpt: row.summary ? summaryExcerpt(row.summary) : null,
  };
}

export async function getPreviousSessionForRequest(code: string, { db, user }: RequestFnContext) {
  return selectPreviousSession(db, code, user?.id);
}
