/**
 * The caption board: every caption segment the room has seen, in the order
 * it started.
 *
 * Pure reducer — the hook layer owns the clock. A segment is one utterance,
 * or one part of a long one, and its id is unique for the meeting, so a
 * segment can only ever be changed by its own updates. Each update carries
 * the whole text so far with a revision; the highest revision wins and a
 * final is the last word. The agent finalizes every segment it opens; a
 * segment that goes quiet without a final (its final was dropped, or its
 * speaker's connection ended) is closed here after a while, as it stood.
 */

export interface CaptionTranscriptEntry {
  /** The segment id: stable for the life of an utterance, so an update is not a remount. */
  id: string;
  userId: string;
  userName: string;
  text: string;
  isFinal: boolean;
  /** When the room first heard this segment: its place in the meeting's timeline. */
  startedAt: number;
  updatedAt: number;
}

export interface CaptionUpdate {
  segmentId: string;
  revision: number;
  userId: string;
  userName: string;
  /** The segment's whole text so far. A final with no text withdraws the segment. */
  text: string;
  isFinal: boolean;
  receivedAt: number;
}

interface SegmentRecord {
  revision: number;
  isFinal: boolean;
}

export interface CaptionBoardState {
  transcript: readonly CaptionTranscriptEntry[];
  /** What has been seen of each segment still in the transcript, or recently withdrawn. */
  segments: ReadonlyMap<string, SegmentRecord>;
}

export type CaptionBoardEvent =
  | { type: "caption"; update: CaptionUpdate }
  | { type: "expire"; now: number }
  | { type: "speaker-left"; userId: string }
  | { type: "clear" };

/**
 * How long an open segment may go without an update before the board closes
 * it itself. Well past the agent's own bound on an unanswered Finalize, so a
 * live utterance is never closed under its speaker.
 */
export const OPEN_SEGMENT_SILENCE_MS = 8_000;

/**
 * How far back the caption box can be scrolled. A cap, not a policy about
 * what is worth keeping: a long meeting would otherwise grow this without
 * bound in a tab that is already holding video.
 */
export const MAX_TRANSCRIPT_ENTRIES = 200;

export function emptyCaptionBoard(): CaptionBoardState {
  return { transcript: [], segments: new Map() };
}

export function reduceCaptionBoard(state: CaptionBoardState, event: CaptionBoardEvent): CaptionBoardState {
  switch (event.type) {
    case "caption":
      return applyUpdate(state, event.update);

    case "expire": {
      let changed = false;
      const transcript = state.transcript.map((entry) => {
        if (entry.isFinal || entry.updatedAt + OPEN_SEGMENT_SILENCE_MS > event.now) return entry;
        changed = true;
        return { ...entry, isFinal: true };
      });
      if (!changed) return state;
      return { transcript, segments: closeSegments(state.segments, transcript) };
    }

    case "speaker-left": {
      // Their words stay in the scrollback. Someone leaving does not un-say
      // what the room already heard; it only means nothing more is coming.
      let changed = false;
      const transcript = state.transcript.map((entry) => {
        if (entry.isFinal || entry.userId !== event.userId) return entry;
        changed = true;
        return { ...entry, isFinal: true };
      });
      if (!changed) return state;
      return { transcript, segments: closeSegments(state.segments, transcript) };
    }

    case "clear":
      // The one event that drops the scrollback: the viewer left the room.
      return state.transcript.length === 0 && state.segments.size === 0 ? state : emptyCaptionBoard();
  }
}

function applyUpdate(state: CaptionBoardState, update: CaptionUpdate): CaptionBoardState {
  const seen = state.segments.get(update.segmentId);
  if (seen && (seen.isFinal || update.revision <= seen.revision)) return state;

  const segments = new Map(state.segments).set(update.segmentId, {
    revision: update.revision,
    isFinal: update.isFinal,
  });
  const next = (transcript: readonly CaptionTranscriptEntry[]): CaptionBoardState => ({
    transcript,
    segments: boundSegments(segments, transcript),
  });
  const index = state.transcript.findIndex((entry) => entry.id === update.segmentId);

  if (!update.text) {
    // Withdrawn, or an interim with nothing in it yet.
    if (!update.isFinal || index === -1) return next(state.transcript);
    return next(state.transcript.filter((_, i) => i !== index));
  }

  const entry: CaptionTranscriptEntry = {
    id: update.segmentId,
    userId: update.userId,
    userName: update.userName,
    text: update.text,
    isFinal: update.isFinal,
    startedAt: index === -1 ? update.receivedAt : state.transcript[index].startedAt,
    updatedAt: update.receivedAt,
  };
  if (index !== -1) return next(state.transcript.map((current, i) => (i === index ? entry : current)));
  const appended = [...state.transcript, entry];
  return next(appended.length > MAX_TRANSCRIPT_ENTRIES
    ? appended.slice(appended.length - MAX_TRANSCRIPT_ENTRIES)
    : appended);
}

/** Record segments the board closed itself, so a late update cannot reopen them. */
function closeSegments(
  segments: ReadonlyMap<string, SegmentRecord>,
  transcript: readonly CaptionTranscriptEntry[],
): ReadonlyMap<string, SegmentRecord> {
  const next = new Map(segments);
  for (const entry of transcript) {
    const seen = next.get(entry.id);
    if (entry.isFinal && seen && !seen.isFinal) next.set(entry.id, { ...seen, isFinal: true });
  }
  return next;
}

/**
 * Keep the segment records bounded: every segment still in the scrollback,
 * plus the most recently seen of the rest (withdrawn segments, and interims
 * that never carried text). Segment ids never repeat, so a forgotten record
 * can only be matched by a very late duplicate of an update already shown.
 */
function boundSegments(
  segments: ReadonlyMap<string, SegmentRecord>,
  transcript: readonly CaptionTranscriptEntry[],
): ReadonlyMap<string, SegmentRecord> {
  const limit = MAX_TRANSCRIPT_ENTRIES * 2;
  if (segments.size <= limit) return segments;
  const shown = new Set(transcript.map((entry) => entry.id));
  const others = [...segments.keys()].filter((id) => !shown.has(id));
  const keepOthers = new Set(others.slice(Math.max(0, others.length - (limit - shown.size))));
  const next = new Map<string, SegmentRecord>();
  for (const [id, record] of segments) {
    if (shown.has(id) || keepOthers.has(id)) next.set(id, record);
  }
  return next;
}

/** When the oldest open segment should be closed for silence, or null when none is open. */
export function nextCaptionExpiry(state: CaptionBoardState): number | null {
  let earliest: number | null = null;
  for (const entry of state.transcript) {
    if (entry.isFinal) continue;
    const expiresAt = entry.updatedAt + OPEN_SEGMENT_SILENCE_MS;
    if (earliest === null || expiresAt < earliest) earliest = expiresAt;
  }
  return earliest;
}
