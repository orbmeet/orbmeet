import type { Database } from "@orbmeet/db";
import { meetings, transcripts } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { listTranscriptRowsPage, type TranscriptCursor, type TranscriptListRow } from "./query";

// Skip the LLM call when there is not enough substantive speech; otherwise
// short greetings tend to produce generic notes.
export const MIN_TRANSCRIPT_CHARS = 250;
const TRANSCRIPT_CHUNK_MAX_CHARS = 24_000;
const TRANSCRIPT_CHUNK_MAX_COUNT = 12;
const TRANSCRIPT_CHUNK_FETCH_SIZE = 500;
const TRANSCRIPT_TOTAL_MAX_CHARS = TRANSCRIPT_CHUNK_MAX_CHARS * TRANSCRIPT_CHUNK_MAX_COUNT;
const TRANSCRIPT_SETTLE_QUIET_MS = 3_000;
const TRANSCRIPT_SETTLE_MAX_MS = 10_000;
const TRANSCRIPT_SETTLE_POLL_MS = 500;

interface ResolvedTranscriptRow {
  speakerLabel: string;
  text: string;
  startedAt: Date;
}

export interface TranscriptChunkBuild {
  chunks: string[];
  participantNames: string[];
  segmentCount: number;
  lastUpdatedAt: Date | null;
  totalChars: number;
  tooLarge: boolean;
}

export interface TranscriptSnapshot {
  segmentCount: number;
  lastUpdatedAt: Date | null;
}

/**
 * Reads the meeting's denormalized transcript counters (one row) instead of
 * aggregating the transcripts table, whose cost grows with meeting length and
 * is paid on every summary poll and settlement tick. Ingest keeps the counters
 * in step, so equality against the values captured at generation time is the
 * same freshness signal the aggregate provided.
 */
export async function getTranscriptSnapshot(
  db: Database,
  meetingId: string,
): Promise<TranscriptSnapshot> {
  const [row] = await db
    .select({
      segmentCount: meetings.transcriptSegmentCount,
      lastUpdatedAt: meetings.transcriptLastIngestedAt,
    })
    .from(meetings)
    .where(eq(meetings.id, meetingId));

  return {
    segmentCount: row?.segmentCount ?? 0,
    lastUpdatedAt: row?.lastUpdatedAt ?? null,
  };
}

export function summaryMatchesTranscriptSnapshot(
  summary: {
    transcriptSegmentCount: number;
    transcriptLastUpdatedAt: Date | null;
  },
  snapshot: TranscriptSnapshot,
): boolean {
  return (
    summary.transcriptSegmentCount === snapshot.segmentCount &&
    (summary.transcriptLastUpdatedAt?.getTime() ?? null) ===
      (snapshot.lastUpdatedAt?.getTime() ?? null)
  );
}

export async function waitForTranscriptSettlement(
  db: Database,
  meetingId: string,
  initialSnapshot?: TranscriptSnapshot,
): Promise<TranscriptSnapshot> {
  const startedAt = Date.now();
  let previous = initialSnapshot ?? (await getTranscriptSnapshot(db, meetingId));

  // Fast path: when the newest transcript write is already older than the quiet
  // threshold, the transcript has demonstrably settled and polling would only
  // re-read an unchanging snapshot.
  if (
    previous.lastUpdatedAt &&
    startedAt - previous.lastUpdatedAt.getTime() >= TRANSCRIPT_SETTLE_QUIET_MS
  ) {
    return previous;
  }

  let lastChangedAt = startedAt;
  while (
    Date.now() - lastChangedAt < TRANSCRIPT_SETTLE_QUIET_MS &&
    Date.now() - startedAt < TRANSCRIPT_SETTLE_MAX_MS
  ) {
    await new Promise((resolve) => setTimeout(resolve, TRANSCRIPT_SETTLE_POLL_MS));
    const current = await getTranscriptSnapshot(db, meetingId);
    if (
      current.segmentCount !== previous.segmentCount ||
      (current.lastUpdatedAt?.getTime() ?? null) !== (previous.lastUpdatedAt?.getTime() ?? null)
    ) {
      previous = current;
      lastChangedAt = Date.now();
    }
  }

  return previous;
}

function formatTranscriptLine(row: ResolvedTranscriptRow, origin: Date): string {
  const elapsedSec = Math.max(0, Math.floor((row.startedAt.getTime() - origin.getTime()) / 1000));
  const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
  const ss = String(elapsedSec % 60).padStart(2, "0");
  return `[${mm}:${ss} ${row.speakerLabel}]: ${row.text.trim()}`;
}

/**
 * The speaker each transcription identity belongs to. A LiveKit identity is
 * one connection's, new on every reload, rejoin or node move; the admission is
 * the person for the whole meeting.
 */
async function speakersByIdentity(db: Database, meetingId: string): Promise<Map<string, string>> {
  const rows = await db
    .selectDistinct({ identity: transcripts.participantIdentity, admissionId: transcripts.admissionId })
    .from(transcripts)
    .where(eq(transcripts.meetingId, meetingId));
  return new Map(rows.map((row) => [row.identity, row.admissionId ?? row.identity]));
}

/**
 * Each speaker's label, one per speaker and no two alike: their name, numbered
 * only where two different people share one.
 */
function buildSpeakerLabels(participants: ReadonlyMap<string, string>): Map<string, string> {
  const speakersByName = new Map<string, string[]>();
  for (const [speaker, name] of participants) {
    const speakers = speakersByName.get(name) ?? [];
    speakers.push(speaker);
    speakersByName.set(name, speakers);
  }

  const taken = new Set(speakersByName.keys());
  const labels = new Map<string, string>();
  for (const [name, speakers] of speakersByName) {
    if (speakers.length === 1) {
      labels.set(speakers[0], name);
      continue;
    }
    let number = 0;
    for (const speaker of speakers) {
      let label: string;
      do label = `${name} (${++number})`; while (taken.has(label));
      taken.add(label);
      labels.set(speaker, label);
    }
  }
  return labels;
}

export async function buildTranscriptChunks(
  db: Database,
  meetingId: string,
  meetingStartedAt: Date | null,
): Promise<TranscriptChunkBuild> {
  const rows: TranscriptListRow[] = [];
  const speakers = await speakersByIdentity(db, meetingId);
  const speakerOf = (row: TranscriptListRow) => speakers.get(row.participantIdentity) ?? row.participantIdentity;
  /** Each speaker's name, as their latest line gives it. */
  const participants = new Map<string, string>();
  let cursor: TranscriptCursor | null = null;
  let segmentCount = 0;
  let lastUpdatedAt: Date | null = null;
  let estimatedChars = 0;

  while (true) {
    const page = await listTranscriptRowsPage(db, meetingId, {
      cursor,
      limit: TRANSCRIPT_CHUNK_FETCH_SIZE,
    });
    if (page.transcripts.length === 0) break;

    for (const row of page.transcripts) {
      const text = row.text.trim();
      if (!text) continue;
      rows.push(row);
      segmentCount += 1;
      if (!lastUpdatedAt || row.updatedAt > lastUpdatedAt) lastUpdatedAt = row.updatedAt;
      participants.set(speakerOf(row), row.participantName);
      estimatedChars += text.length + row.participantName.length + 16;
      if (estimatedChars > TRANSCRIPT_TOTAL_MAX_CHARS) {
        return {
          chunks: [],
          participantNames: [],
          segmentCount,
          lastUpdatedAt,
          totalChars: estimatedChars,
          tooLarge: true,
        };
      }
    }

    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  const speakerLabels = buildSpeakerLabels(participants);
  const participantNames = [...participants.keys()].map((speaker) => speakerLabels.get(speaker)!);
  const chunks: string[] = [];
  let current = "";
  let origin = meetingStartedAt;
  let totalChars = 0;

  for (const row of rows) {
    origin ??= row.startedAt;
    const line = formatTranscriptLine(
      {
        speakerLabel: speakerLabels.get(speakerOf(row))!,
        text: row.text,
        startedAt: row.startedAt,
      },
      origin,
    );
    if (current && current.length + line.length + 1 > TRANSCRIPT_CHUNK_MAX_CHARS) {
      chunks.push(current);
      current = "";
    }
    if (chunks.length >= TRANSCRIPT_CHUNK_MAX_COUNT) {
      return {
        chunks: [],
        participantNames,
        segmentCount,
        lastUpdatedAt,
        totalChars,
        tooLarge: true,
      };
    }
    current = current ? `${current}\n${line}` : line;
    totalChars += line.length;
  }
  if (current) chunks.push(current);

  return {
    chunks,
    participantNames,
    segmentCount,
    lastUpdatedAt,
    totalChars,
    tooLarge: false,
  };
}
