import * as React from "react";
import { useCommittedRef } from "@orbmeet/ui/react";
import type { AssistantEntry } from "@orbmeet/whiteboard-core/assistant";

/**
 * How recent a question must be to open the Conversation. The room's history
 * arrives in one snapshot when someone joins or the board opens, and the
 * questions in it were asked before they were here to see them.
 */
const LIVE_QUESTION_MS = 60_000;

/**
 * The room's questions to Orb, asked by someone else, that `seen` does not
 * hold and that were asked within the last minute of `now`.
 */
export function newRoomQuestions(
  entries: readonly AssistantEntry[],
  seen: ReadonlySet<string>,
  currentUserId: string | null,
  now: number,
): AssistantEntry[] {
  return entries.filter(
    (entry) =>
      entry.kind === "prompt" &&
      (!entry.audience || entry.audience.kind === "room") &&
      entry.authorId !== currentUserId &&
      !seen.has(entry.id) &&
      now - entry.at <= LIVE_QUESTION_MS,
  );
}

/**
 * Someone asks Orb in the room, and the Conversation opens for everyone on
 * the room's thread, so the answer is read where it is given rather than
 * found later. The asker's is already open. Anyone with the Conversation
 * already showing keeps the thread they are reading.
 */
export function useOpenOnRoomQuestion({
  entries,
  currentUserId,
  enabled,
  open,
}: {
  /** Orb's entries this viewer can see; undefined where Orb has no part in the room. */
  entries: readonly AssistantEntry[] | undefined;
  currentUserId: string | null;
  /** False for a recording, which has no panels to open. */
  enabled: boolean;
  /** Shows the room's thread in the Conversation, opening it if it is closed. */
  open: () => void;
}): void {
  const seenRef = React.useRef<Set<string>>(new Set());
  const openRef = useCommittedRef(open);

  React.useEffect(() => {
    if (!entries) return;
    const fresh = newRoomQuestions(entries, seenRef.current, currentUserId, Date.now());
    for (const entry of entries) seenRef.current.add(entry.id);
    if (enabled && fresh.length > 0) openRef.current();
  }, [currentUserId, enabled, entries, openRef]);
}
