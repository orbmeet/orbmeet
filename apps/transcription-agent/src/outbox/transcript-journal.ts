import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as v from "valibot";
import {
  MAX_TRANSCRIPT_SEGMENT_TEXT_LENGTH,
  transcriptIngestSchema,
  type TranscriptIngest,
  type TranscriptSegment,
} from "@orbmeet/caption-protocol/transcript-ingest";
import { truncateCodeUnits } from "@orbmeet/primitives";
import { logError, logWarn } from "../log.js";

export type PersistedSegment = TranscriptSegment;
export type TranscriptPayload = TranscriptIngest;

export class TranscriptPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TranscriptPersistenceError";
  }
}

/**
 * Fit one segment to the ingest contract. A Deepgram final has no length
 * limit of its own; truncating keeps most of the speech where rejecting it
 * would lose all of it.
 */
function boundPersistedSegment(segment: PersistedSegment): PersistedSegment {
  const text = segment.text.trim();
  if (text.length <= MAX_TRANSCRIPT_SEGMENT_TEXT_LENGTH) {
    return text === segment.text ? segment : { ...segment, text };
  }
  logWarn("Truncating an over-long transcript segment to the persisted ceiling", {
    segmentId: segment.segmentId,
    length: text.length,
    ceiling: MAX_TRANSCRIPT_SEGMENT_TEXT_LENGTH,
  });
  return { ...segment, text: truncateCodeUnits(text, MAX_TRANSCRIPT_SEGMENT_TEXT_LENGTH) };
}

export interface JournalRow {
  id: number;
  createdAt: number;
  payload: TranscriptPayload;
}

/**
 * The transcript's only copy on this host, from the moment Deepgram commits
 * a final until the app has committed it.
 *
 * Publisher job processes append; the parent process ships and deletes. A row
 * is deleted only once the app acknowledged it, so every row is always held
 * by exactly one durable store. Rows the app refuses as invalid are set aside
 * in `rejected_segments`, kept for inspection for a bounded time.
 */
export class TranscriptJournal {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS segments (
        id INTEGER PRIMARY KEY,
        meeting_id TEXT NOT NULL,
        participant_identity TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (meeting_id, participant_identity, segment_id)
      );
      CREATE TABLE IF NOT EXISTS rejected_segments (
        id INTEGER PRIMARY KEY,
        payload TEXT NOT NULL,
        error TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        rejected_at INTEGER NOT NULL
      );
    `);
    const columns = this.db.prepare("PRAGMA table_info(segments)").all().map((column) => String(column.name));
    if (!columns.includes("next_attempt_at")) {
      try {
        this.db.exec("ALTER TABLE segments ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0");
      } catch (error) {
        // Another process sharing the file added it first.
        if (!(error instanceof Error && error.message.includes("duplicate column"))) throw error;
      }
    }
  }

  /** Durably record one final. Returns once SQLite has committed it. */
  append(meetingId: string, participantIdentity: string, segment: PersistedSegment): void {
    try {
      const payload = v.parse(transcriptIngestSchema, {
        meetingId,
        participantIdentity,
        segments: [boundPersistedSegment(segment)],
      });
      this.db.prepare(`INSERT INTO segments
        (meeting_id, participant_identity, segment_id, payload, created_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(
        meetingId, participantIdentity, segment.segmentId, JSON.stringify(payload), Date.now(),
      );
    } catch (cause) {
      throw new TranscriptPersistenceError("Could not journal transcript segment", { cause });
    }
  }

  /**
   * The oldest rows to deliver. A row that no longer reads as a payload is
   * set aside with the reason rather than blocking every row behind it.
   */
  pending(limit = 100, now = Date.now()): JournalRow[] {
    const rows = this.db.prepare(
      "SELECT id, payload, created_at FROM segments WHERE next_attempt_at <= ? ORDER BY id LIMIT ?",
    ).all(now, limit);
    const readable: JournalRow[] = [];
    for (const row of rows) {
      const id = Number(row.id);
      const createdAt = Number(row.created_at);
      try {
        readable.push({ id, createdAt, payload: v.parse(transcriptIngestSchema, JSON.parse(String(row.payload))) });
      } catch (error) {
        this.reject([id], error instanceof Error ? error.message : String(error));
      }
    }
    return readable;
  }

  /** The app has committed these rows. */
  acknowledge(ids: readonly number[]): void {
    this.transaction(() => {
      const remove = this.db.prepare("DELETE FROM segments WHERE id = ?");
      for (const id of ids) remove.run(id);
    });
  }

  /** Leave these rows out of delivery until `until`, so rows behind them are not held up. */
  defer(ids: readonly number[], until: number): void {
    this.transaction(() => {
      const update = this.db.prepare("UPDATE segments SET next_attempt_at = ? WHERE id = ?");
      for (const id of ids) update.run(until, id);
    });
  }

  /** The app will never accept these rows. Keep them aside for inspection. */
  reject(ids: readonly number[], reason: string): void {
    const rejectedAt = Date.now();
    this.transaction(() => {
      const read = this.db.prepare("SELECT payload, created_at FROM segments WHERE id = ?");
      // Kept under an id of its own: a segment's id is reused once the queue
      // drains, and would otherwise replace an earlier rejection's only copy.
      const keep = this.db.prepare(`INSERT INTO rejected_segments (payload, error, created_at, rejected_at)
        VALUES (?, ?, ?, ?)`);
      const remove = this.db.prepare("DELETE FROM segments WHERE id = ?");
      for (const id of ids) {
        const row = read.get(id);
        if (!row) continue;
        keep.run(String(row.payload), reason.slice(0, 1_000), Number(row.created_at), rejectedAt);
        remove.run(id);
      }
    });
    logError("Transcript journal set aside segments the app refused", { ids, reason });
  }

  /** Forget rejected rows older than `maxAgeMs`: they hold participants' speech. */
  pruneRejected(maxAgeMs: number, now = Date.now()): void {
    this.db.prepare("DELETE FROM rejected_segments WHERE rejected_at < ?").run(now - maxAgeMs);
  }

  status(): { pending: number; oldestAt: number | null } {
    const row = this.db.prepare("SELECT count(*) AS count, min(created_at) AS oldest FROM segments").get()!;
    return { pending: Number(row.count), oldestAt: row.oldest === null ? null : Number(row.oldest) };
  }

  close(): void {
    this.db.close();
  }

  private transaction(run: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
