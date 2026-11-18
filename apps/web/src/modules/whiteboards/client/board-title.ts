/**
 * The name a board goes by in a list.
 *
 * A board made for a meeting is named after it when the meeting has a title,
 * and otherwise after the day it was made — "Whiteboard · Oct 15, 2026" — so a
 * week of untitled sessions reads as a column of identical rows. Until the
 * board is renamed, the meeting it was last used in names it better than its
 * date does: that is what people remember it by.
 */
const DATED_DEFAULT = /^Whiteboard · /;

/** Boards named before dates were spelled out: "Whiteboard · 2026-10-12". */
const ISO_DAY = /^(Whiteboard · )(\d{4})-(\d{2})-(\d{2})(?=$|\s)/;

export function boardDisplayTitle(board: { title: string; lastUsedIn?: string | null }): string {
  const lastUsedIn = board.lastUsedIn?.trim();
  if (DATED_DEFAULT.test(board.title) && lastUsedIn) return lastUsedIn;
  // The same day the way every newer board says it, "Oct 12, 2026", rather
  // than a second date format beside it in the same list.
  return board.title.replace(ISO_DAY, (_match, prefix: string, year: string, month: string, day: string) => {
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    if (Number.isNaN(date.getTime())) return _match;
    return `${prefix}${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
  });
}
