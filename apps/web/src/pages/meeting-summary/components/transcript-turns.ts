/** A pause longer than this starts a new turn, even from the same speaker. */
const TURN_GAP_MS = 2 * 60_000;

interface Line {
  id: string;
  participantIdentity: string;
  participantName: string;
  text: string;
  startedAt: Date | string;
}

export interface TranscriptTurn {
  key: string;
  participantName: string;
  startedAt: Date;
  text: string;
}

/**
 * Consecutive lines from one person, close together, as one turn: one name,
 * one time, one paragraph. The transcript was a name and a time over every
 * fragment the recogniser cut — "Incogni 9:56 · Yes." eight times in a row —
 * which is how a machine hears speech, not how anyone reads it.
 */
export function groupTranscriptTurns(lines: readonly Line[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let last: { identity: string; at: number } | null = null;
  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    const at = new Date(line.startedAt).getTime();
    const current = turns.at(-1);
    if (current && last && last.identity === line.participantIdentity && at - last.at <= TURN_GAP_MS) {
      current.text = `${current.text} ${text}`;
    } else {
      turns.push({ key: line.id, participantName: line.participantName, startedAt: new Date(at), text });
    }
    last = { identity: line.participantIdentity, at };
  }
  return turns;
}
