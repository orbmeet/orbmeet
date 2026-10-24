import type { Database } from "@orbmeet/db";
import { transcripts } from "@orbmeet/db/schema";
import { and, asc, eq, gt, or } from "drizzle-orm";

import { DEFAULT_TRANSCRIPT_PAGE_SIZE, MAX_TRANSCRIPT_PAGE_SIZE } from "../contract/page";

export type TranscriptListRow = {
  id: string;
  participantIdentity: string;
  participantName: string;
  text: string;
  language: string | null;
  startedAt: Date;
  updatedAt: Date;
};

export type TranscriptCursor = {
  startedAt: number;
  id: string;
};

export type TranscriptPage = {
  transcripts: TranscriptListRow[];
  nextCursor: TranscriptCursor | null;
};

export async function listTranscriptRowsPage(
  db: Database,
  meetingId: string,
  options: {
    cursor?: TranscriptCursor | null;
    limit?: number;
  } = {},
): Promise<TranscriptPage> {
  const limit = Math.max(
    1,
    Math.min(options.limit ?? DEFAULT_TRANSCRIPT_PAGE_SIZE, MAX_TRANSCRIPT_PAGE_SIZE),
  );
  const cursor = options.cursor
    ? { startedAt: new Date(options.cursor.startedAt), id: options.cursor.id }
    : null;

  const batch: TranscriptListRow[] = await db
    .select({
      id: transcripts.id,
      participantIdentity: transcripts.participantIdentity,
      participantName: transcripts.participantName,
      text: transcripts.text,
      language: transcripts.language,
      startedAt: transcripts.startedAt,
      updatedAt: transcripts.updatedAt,
    })
    .from(transcripts)
    .where(
      and(
        eq(transcripts.meetingId, meetingId),
        cursor
          ? or(
              gt(transcripts.startedAt, cursor.startedAt),
              and(eq(transcripts.startedAt, cursor.startedAt), gt(transcripts.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(asc(transcripts.startedAt), asc(transcripts.id))
    .limit(limit + 1)
    .all();

  const transcriptsPage = batch.slice(0, limit);
  const last = transcriptsPage[transcriptsPage.length - 1];
  return {
    transcripts: transcriptsPage,
    nextCursor:
      batch.length > limit && last
        ? { startedAt: last.startedAt.getTime(), id: last.id }
        : null,
  };
}
