import { MEETING_CODE_GROUPS, MEETING_CODE_SOURCE } from "@/modules/meetings/contract/constants";

// Cumulative slice boundaries derived from the group sizes (e.g. [3,4,3] → [0,3,7,10]).
const BOUNDARIES = MEETING_CODE_GROUPS.reduce<number[]>((acc, size) => {
  acc.push((acc[acc.length - 1] ?? 0) + size);
  return acc;
}, []);

function insertDashes(letters: string): string {
  // Slice each group; stop at the first empty group (no trailing dashes).
  const parts: string[] = [];
  for (let i = 0; i < MEETING_CODE_GROUPS.length; i++) {
    const start = BOUNDARIES[i - 1] ?? 0;
    const part = letters.slice(start, BOUNDARIES[i]);
    if (!part) break;
    parts.push(part);
  }
  return parts.join("-");
}

export function formatCode(raw: string): string {
  // Hyphens are presentation only. Rebuild them from the canonical group sizes
  // so pasted or hand-typed separators cannot leave an otherwise valid code in
  // a shape the server rejects.
  const letters = raw
    .toLowerCase()
    .replace(/[^a-z]/g, "")
    .slice(0, BOUNDARIES[BOUNDARIES.length - 1]);
  return insertDashes(letters);
}

/** A whole code standing on its own in longer text: a link's path, an invite. */
const CODE_IN_TEXT = new RegExp(`(?:^|[^a-z])(${MEETING_CODE_SOURCE})(?![a-z])`);

/** Something pasted from an address bar or an invite, not typed letters. */
const LINK_LIKE = /[/:.]/;

/** The meeting code inside pasted text — a link or an invite — or null. */
export function findMeetingCode(text: string): string | null {
  return CODE_IN_TEXT.exec(text.toLowerCase())?.[1] ?? null;
}

/**
 * What a code field holds after an edit. A pasted link gives up the code in
 * it; typed letters are shaped into a code. A link with no code in it is left
 * as it is, so the field's check refuses it, rather than its letters being
 * read as someone else's code ("https://…" would become "htt-psor-…").
 */
export function readCodeInput(raw: string): string {
  const found = findMeetingCode(raw);
  if (found) return found;
  return LINK_LIKE.test(raw) ? raw.trim() : formatCode(raw);
}
