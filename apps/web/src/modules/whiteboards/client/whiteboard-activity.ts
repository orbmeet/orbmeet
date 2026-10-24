import { formatDayLabel } from "@/modules/meetings/client/components/meeting-date-groups";

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "today", "yesterday", or "Oct 9" — the year only when it is not this one. */
export function formatActivityDay(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return formatDayLabel(date, now);
}

/**
 * One line of provenance for a Whiteboard in a list: "Last used in Calculus ·
 * Oct 9", "Last used today", or "Edited yesterday" for a board no meeting has
 * used. Every list says it the same way: they used to mix "Updated" and "Last
 * used" over numeric dates ("10/12/2026") beside ISO dates in the titles.
 */
export function describeWhiteboardActivity(
  whiteboard: { lastUsedAt: string | null; lastUsedIn: string | null; updatedAt: string },
  now = new Date(),
): string {
  if (!whiteboard.lastUsedAt) return `Edited ${formatActivityDay(whiteboard.updatedAt, now)}`;
  const when = formatActivityDay(whiteboard.lastUsedAt, now);
  return whiteboard.lastUsedIn ? `Last used in ${whiteboard.lastUsedIn} · ${when}` : `Last used ${when}`;
}
