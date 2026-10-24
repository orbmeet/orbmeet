import type { CaptionTranscriptEntry } from "./board";

/** How long a caption stays on the stage after its speaker stops. */
export const CAPTION_LINGER_MS = 6_000;
/** Roughly two lines of a caption; older words scroll away. */
const CAPTION_MAX_CHARS = 160;

export interface LatestCaption {
  userId: string;
  userName: string;
  /** Words already settled. */
  settled: string;
  /** Words still being revised as the speaker talks. */
  saying: string;
  /** When the speaker last said anything. */
  updatedAt: number;
}

/**
 * What the folded Conversation shows: the newest speaker's current turn,
 * trimmed from the front to about two lines. Null when nobody has spoken
 * within `CAPTION_LINGER_MS`, so a caption never hangs on a quiet room.
 */
export function latestCaption(entries: readonly CaptionTranscriptEntry[], now: number): LatestCaption | null {
  const last = entries.at(-1);
  if (!last) return null;
  const turn: CaptionTranscriptEntry[] = [];
  for (let index = entries.length - 1; index >= 0 && entries[index].userId === last.userId; index--) {
    turn.unshift(entries[index]);
  }
  const updatedAt = Math.max(...turn.map((entry) => entry.updatedAt));
  if (now - updatedAt > CAPTION_LINGER_MS) return null;

  const settled = turn.filter((entry) => entry.isFinal).map((entry) => entry.text.trim()).filter(Boolean).join(" ");
  const saying = turn.filter((entry) => !entry.isFinal).map((entry) => entry.text.trim()).filter(Boolean).join(" ");
  if (!settled && !saying) return null;

  // Keep the newest words: drop whole words from the front of what is settled.
  let head = settled;
  const room = Math.max(0, CAPTION_MAX_CHARS - saying.length);
  if (head.length > room) {
    head = head.slice(head.length - room);
    const space = head.indexOf(" ");
    head = `…${space === -1 ? head : head.slice(space + 1)}`;
  }
  return { userId: last.userId, userName: last.userName, settled: head, saying, updatedAt };
}
