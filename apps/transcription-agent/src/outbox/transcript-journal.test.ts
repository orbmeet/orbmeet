import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TRANSCRIPT_SEGMENT_TEXT_LENGTH } from "@orbmeet/caption-protocol/transcript-ingest";
import { TranscriptJournal, TranscriptPersistenceError } from "./transcript-journal.js";

const dirs: string[] = [];
function path() {
  const dir = mkdtempSync(join(tmpdir(), "transcript-journal-"));
  dirs.push(dir);
  return join(dir, "journal.db");
}
const segment = { segmentId: "seg-1", startedAt: 1_000, language: "en-US", text: "A durable sentence" };
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("TranscriptJournal", () => {
  it("keeps an appended segment across a process restart until it is acknowledged", () => {
    const file = path();
    const writer = new TranscriptJournal(file);
    writer.append("m1", "p1", segment);
    writer.close();

    const reader = new TranscriptJournal(file);
    const [row] = reader.pending();
    expect(row.payload).toEqual({ meetingId: "m1", participantIdentity: "p1", segments: [segment] });
    reader.acknowledge([row.id]);
    expect(reader.status().pending).toBe(0);
    reader.close();
  });

  it("records a segment once however often it is appended, across handles sharing the file", () => {
    const file = path();
    const first = new TranscriptJournal(file);
    const second = new TranscriptJournal(file);
    first.append("m1", "p1", segment);
    second.append("m1", "p1", segment);
    second.append("m1", "p2", segment);
    expect(first.status().pending).toBe(2);
    first.close();
    second.close();
  });

  it("truncates an over-long final instead of refusing it", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const journal = new TranscriptJournal(path());
    journal.append("m1", "p1", { ...segment, text: "x".repeat(MAX_TRANSCRIPT_SEGMENT_TEXT_LENGTH + 10) });
    expect(journal.pending()[0].payload.segments[0].text).toHaveLength(MAX_TRANSCRIPT_SEGMENT_TEXT_LENGTH);
    journal.close();
  });

  it("refuses a segment it cannot record, loudly", () => {
    const journal = new TranscriptJournal(path());
    expect(() => journal.append("m1", "p1", { ...segment, text: "  " })).toThrow(TranscriptPersistenceError);
    journal.close();
  });

  it("holds deferred rows out of delivery until their time", () => {
    const journal = new TranscriptJournal(path());
    journal.append("m1", "p1", segment);
    journal.append("m1", "p1", { ...segment, segmentId: "seg-2" });
    const [first] = journal.pending(100, 0);
    journal.defer([first.id], 5_000);
    expect(journal.pending(100, 4_999).map((row) => row.payload.segments[0].segmentId)).toEqual(["seg-2"]);
    expect(journal.pending(100, 5_000)).toHaveLength(2);
    journal.close();
  });

  it("sets rejected rows aside, and forgets them after the retention window", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const file = path();
    const journal = new TranscriptJournal(file);
    journal.append("m1", "p1", segment);
    journal.reject([journal.pending()[0].id], "transcript ingest returned 400");
    expect(journal.status().pending).toBe(0);

    const inspect = new DatabaseSync(file);
    const count = () => inspect.prepare("SELECT count(*) AS count FROM rejected_segments").get();
    expect(count()).toEqual({ count: 1 });
    journal.pruneRejected(60_000, Date.now() + 120_000);
    expect(count()).toEqual({ count: 0 });
    inspect.close();
    journal.close();
  });

  it("keeps every rejection, even when a drained queue reuses a segment's id", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const file = path();
    const journal = new TranscriptJournal(file);
    journal.append("m1", "p1", segment);
    const [first] = journal.pending();
    journal.reject([first.id], "transcript ingest returned 400");
    journal.append("m1", "p1", { ...segment, segmentId: "seg-2" });
    const [second] = journal.pending();
    expect(second.id).toBe(first.id);
    journal.reject([second.id], "transcript ingest returned 400");

    const inspect = new DatabaseSync(file);
    const kept = inspect.prepare("SELECT payload FROM rejected_segments ORDER BY id").all()
      .map((row) => JSON.parse(String(row.payload)).segments[0].segmentId);
    expect(kept).toEqual(["seg-1", "seg-2"]);
    inspect.close();
    journal.close();
  });

  it("sets an unreadable row aside instead of blocking every row behind it", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const file = path();
    const journal = new TranscriptJournal(file);
    const raw = new DatabaseSync(file);
    raw.prepare(`INSERT INTO segments (meeting_id, participant_identity, segment_id, payload, created_at)
      VALUES ('m1', 'p1', 'seg-0', '{"not":"a payload"}', 0)`).run();
    raw.close();
    journal.append("m1", "p1", segment);

    expect(journal.pending().map((row) => row.payload.segments[0].segmentId)).toEqual(["seg-1"]);
    expect(journal.status().pending).toBe(1);
    journal.close();
  });

  it("opens a journal written before rows could be deferred", () => {
    const file = path();
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE segments (
      id INTEGER PRIMARY KEY, meeting_id TEXT NOT NULL, participant_identity TEXT NOT NULL,
      segment_id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE (meeting_id, participant_identity, segment_id))`);
    old.prepare(`INSERT INTO segments (meeting_id, participant_identity, segment_id, payload, created_at)
      VALUES ('m1', 'p1', 'seg-1', ?, 0)`).run(JSON.stringify({ meetingId: "m1", participantIdentity: "p1", segments: [segment] }));
    old.close();

    const journal = new TranscriptJournal(file);
    expect(journal.pending()).toHaveLength(1);
    journal.close();
  });
});
