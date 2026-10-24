/**
 * Choosing the whiteboard's chrome.
 *
 * The board used to pick its chrome from its measured width, because its
 * tools were a horizontal strip that needed ~780px: a board narrowed by a
 * side panel fell back to the phone kit, and the page rail was dropped first
 * to make room. The tools are a vertical palette now, so width no longer
 * decides anything — a tablet in portrait with the timeline open has the same
 * tools as a desktop. What decides is the device: a phone keeps the compact,
 * thumb-sized kit; everything else gets the palette.
 *
 * A tablet held upright used to get the phone's kit too — tools across the
 * top, pages along the bottom — to give a 16:9 page the sixth of its width a
 * palette costs. But that is a board written on with a pencil, and the
 * bottom of it is where the writing hand rests: a palm turned pages. Upright
 * or on its side, a tablet keeps the bottom of the board empty, its tools
 * down the edge the writing hand does not cover and everything else at the
 * top.
 *
 * The page rail is not decided here: on a regular board it is the reader's
 * own choice, made with the page control in the board's top band, and the
 * board component that owns that control owns the choice.
 */

import type { WhiteboardChromeConfig } from "./whiteboard-chrome";

export interface WhiteboardChromeFitInput {
  /** The meeting is on a phone, in either orientation. */
  isPhone: boolean;
  /** A phone held upright inside a meeting: the annotate-only board. */
  isPhonePortrait: boolean;
  /** Whether the editor is writable; a reader gets no tools at all. */
  toolbarVisible?: boolean;
}

export function resolveWhiteboardChrome({
  isPhone,
  isPhonePortrait,
  toolbarVisible = true,
}: WhiteboardChromeFitInput): WhiteboardChromeConfig {
  if (isPhone || isPhonePortrait) {
    return {
      mode: "compact",
      toolbarVisible,
      isMeetingPhonePortrait: isPhonePortrait,
      pageRailVisible: false,
      // The board itself reads its window for this (see SyncedWhiteboard).
      sideways: false,
    };
  }
  return {
    mode: "regular",
    toolbarVisible,
    isMeetingPhonePortrait: false,
    pageRailVisible: false,
    sideways: false,
  };
}
