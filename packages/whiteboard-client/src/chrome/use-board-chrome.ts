import { useCallback, useMemo, useState } from "react";
import type { WhiteboardChromeConfig } from "./whiteboard-chrome";
import { useWhiteboardResponsive } from "./use-whiteboard-responsive";

const PAGE_RAIL_STORAGE_KEY = "orbmeet.whiteboard.pageRail";

function readPageRailOpen(): boolean {
  try {
    return localStorage.getItem(PAGE_RAIL_STORAGE_KEY) === "open";
  } catch {
    return false;
  }
}

function writePageRailOpen(open: boolean) {
  try {
    localStorage.setItem(PAGE_RAIL_STORAGE_KEY, open ? "open" : "closed");
  } catch {
    // Private mode or blocked storage: the rail still toggles for this board.
  }
}

interface BoardChromeOptions {
  /** The host's chrome: the board's mode and the insets it lays out around. */
  chrome: WhiteboardChromeConfig;
  /** A surface that only shows the board never has tools. */
  readOnlySurface: boolean;
  /**
   * Whether this participant has the tools, or is about to: an editor whose
   * writable connection is still landing, and a host. It used to be held for
   * every reader too, so the page would not move if the host handed them the
   * pen — and every reader paid for that with a page pushed off-centre on a
   * tablet and an empty band over it on a phone, for a moment most of them
   * never reach. The page re-fits once, when the tools arrive, right after the
   * reader asked for them.
   */
  hasTools: boolean;
}

/** The board's chrome as laid out now: what the controls, toolbar and camera all read. */
export function useBoardChrome({ chrome, readOnlySurface, hasTools }: BoardChromeOptions) {
  // The page rail is the reader's to open and close on a regular board (the
  // page control in the top band toggles it), and it is remembered, because
  // someone who keeps their pages in view wants them there on the next board.
  const [pageRailOpen, setPageRailOpen] = useState(readPageRailOpen);
  const togglePageRail = useCallback(() => {
    setPageRailOpen((open) => {
      writePageRailOpen(!open);
      return !open;
    });
  }, []);
  // Held on its side, or a window too short for the top band: one reading of
  // the window, which the controls, the toolbar and the camera all lay out by.
  const { sideways } = useWhiteboardResponsive();
  const [controlsHeightPx, setControlsHeightPx] = useState<number | null>(null);
  const canvasChrome = useMemo(
    () => ({
      ...chrome,
      sideways,
      ...(controlsHeightPx === null ? {} : { controlsHeightPx }),
      toolbarVisible: !readOnlySurface && hasTools,
      pageRailVisible: chrome.mode === "regular" && pageRailOpen,
    }),
    [chrome, controlsHeightPx, hasTools, pageRailOpen, readOnlySurface, sideways],
  );
  return { canvasChrome, togglePageRail, setControlsHeightPx };
}
