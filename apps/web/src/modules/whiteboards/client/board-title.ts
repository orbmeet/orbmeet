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

export function boardDisplayTitle(board: { title: string; lastUsedIn?: string | null }): string {
  const lastUsedIn = board.lastUsedIn?.trim();
  return DATED_DEFAULT.test(board.title) && lastUsedIn ? lastUsedIn : board.title;
}
