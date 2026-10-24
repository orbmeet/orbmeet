type WhiteboardChromeMode = "compact" | "regular";

export interface WhiteboardChromeConfig {
  mode: WhiteboardChromeMode;
  toolbarVisible: boolean;
  /**
   * A phone held upright inside a meeting: the narrowest board we ship, and
   * the only one that gets the annotate-only toolbar.
   *
   * This was `hasBottomMeetingPill`, a name describing furniture the flag no
   * longer has anything to do with — it was reserving vertical space for the
   * meeting dock that the stage rect already reserved. With that removed, what
   * it actually selects is a toolbar variant, so it now says so.
   */
  isMeetingPhonePortrait: boolean;
  /**
   * Whether the left-hand page rail is mounted. The canvas container is offset
   * by its band, so the layout — not the camera — has to know about it.
   */
  pageRailVisible: boolean;
  /**
   * The board is held on its side, or its window is too short for a band
   * across the top (under 500px tall, wider than tall): its page and zoom
   * controls stand in one capsule in the bottom corner. Read from the window,
   * the same thing the toolbar and controls lay themselves out by.
   */
  sideways: boolean;
  /**
   * The page controls' rendered height, measured by them: the upright dock
   * (pager and any status pills over it), or a regular board's top band (one
   * row, or two when they wrap). Absent until measured, and when held sideways.
   */
  controlsHeightPx?: number;
}

/**
 * Where a board's page and zoom controls stand. The controls are laid out by
 * it, and the camera keeps the page clear of exactly that, so the two cannot
 * disagree about what covers the board.
 *
 * - `corner`: a regular board's band across the top.
 * - `dock`: a compact board held upright, the pager along the bottom.
 * - `side`: a board held on its side, one capsule in the bottom corner.
 */
export type WhiteboardControlsPlacement = "corner" | "dock" | "side";

export function controlsPlacement(chrome: Pick<WhiteboardChromeConfig, "mode" | "sideways">): WhiteboardControlsPlacement {
  if (chrome.sideways) return "side";
  return chrome.mode === "compact" ? "dock" : "corner";
}

export const DEFAULT_WHITEBOARD_CHROME: WhiteboardChromeConfig = {
  mode: "regular",
  toolbarVisible: true,
  isMeetingPhonePortrait: false,
  pageRailVisible: false,
  sideways: false,
};
