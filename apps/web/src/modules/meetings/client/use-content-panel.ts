import * as React from "react";
import type { MeetingUIState } from "./use-meeting-ui";
import type { MeetingSideColumnTab } from "./room-layout";

// v3: a wide screen opens the Conversation beside the board, under the faces.
// A "closed" chosen when it opened nothing was not a choice about that, so it
// is not carried over.
const CONTENT_PANEL_STORAGE_KEY = "orbmeet.meeting.contentPanel.v3";

/**
 * Whether this device opens a panel beside the board, remembered per device:
 * someone who keeps the board wide on an iPad and the faces beside it on a
 * desktop monitor should not have to re-choose every meeting. Open unless
 * someone closed it.
 *
 * Storage can throw on access (privacy mode, disabled site storage), so it is
 * read and written behind a non-throwing boundary, like the display name.
 */
function loadContentPanelOpen(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(CONTENT_PANEL_STORAGE_KEY) !== "closed";
  } catch {
    return true;
  }
}

function saveContentPanelOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CONTENT_PANEL_STORAGE_KEY, open ? "open" : "closed");
  } catch {
    // A layout preference must never get in the way of the meeting.
  }
}

/**
 * Opens the panel that belongs with the board or a shared screen when one
 * takes the stage — the Conversation beside a wide board, People under an
 * upright one — and closes it again when the content goes, each only if the
 * room opened it.
 *
 * What someone does with the panel while content is up is remembered: closing
 * it means the next board opens wide, opening one means it opens beside them.
 */
export function useContentPanel({
  contentOnStage,
  contentPanel,
  ui,
}: {
  contentOnStage: boolean;
  /** The panel `selectContentPanel` chose, or null to leave it closed. */
  contentPanel: MeetingSideColumnTab | null;
  ui: Pick<MeetingUIState, "panel" | "openPanel" | "closePanel">;
}) {
  const { panel, openPanel, closePanel } = ui;
  const contentWasOnStage = React.useRef(false);
  const openedForContent = React.useRef<MeetingSideColumnTab | null>(null);
  // The panel the room itself last switched to (null: closed), until the
  // change lands, so it is not mistaken for a choice worth remembering.
  const roomChange = React.useRef<MeetingSideColumnTab | null | undefined>(undefined);

  React.useEffect(() => {
    const arrived = contentOnStage && !contentWasOnStage.current;
    const left = !contentOnStage && contentWasOnStage.current;
    contentWasOnStage.current = contentOnStage;
    if (arrived && panel === null && contentPanel && loadContentPanelOpen()) {
      openedForContent.current = contentPanel;
      openPanel(contentPanel);
    } else if (left) {
      if (openedForContent.current !== null && panel === openedForContent.current) closePanel();
      openedForContent.current = null;
    } else if (
      contentOnStage &&
      openedForContent.current !== null &&
      panel === openedForContent.current &&
      contentPanel !== openedForContent.current
    ) {
      // The room's choice changed while its own pick is up (the layout
      // decided differently): the pick follows it. A panel someone picked
      // themselves is theirs, and stays.
      openedForContent.current = contentPanel;
      roomChange.current = contentPanel;
      if (contentPanel) openPanel(contentPanel);
      else closePanel();
    }
  }, [contentOnStage, contentPanel, panel, openPanel, closePanel]);

  // A choice made while content is up is the one to repeat next time.
  const previousPanel = React.useRef(panel);
  React.useEffect(() => {
    const before = previousPanel.current;
    previousPanel.current = panel;
    if (!contentOnStage || before === panel) return;
    if (roomChange.current !== undefined && roomChange.current === panel) {
      roomChange.current = undefined;
      return;
    }
    if (panel === null) saveContentPanelOpen(false);
    else if (panel === "people" || panel === "timeline") {
      if (panel !== openedForContent.current) openedForContent.current = null;
      saveContentPanelOpen(true);
    }
  }, [contentOnStage, panel]);
}
