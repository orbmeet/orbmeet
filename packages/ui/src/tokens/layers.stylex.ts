/**
 * Z-index scale. Every stacking decision in the app is one of these names.
 *
 * Two independent runs of numbers, and the split is the point.
 */
import * as stylex from "@stylexjs/stylex";

/**
 * The application stack. These order chrome against the whole document.
 */
export const zIndex = stylex.defineConsts({
  /** Meeting side panels (chat, participants, captions). */
  meetingPanel: "100",
  /** Desktop top control bar. */
  meetingBar: "110",
  /** Floating video pip. */
  meetingPip: "125",
  /** Caption overlay. */
  meetingCaption: "130",
  /**
   * Phone dock. Deliberately below `modal`: a bottom sheet must cover the
   * dock, not fight it. The old always-on-top pill sat above every sheet and
   * had to be manually unmounted whenever one opened — that hack is what made
   * the chat input unreachable. Ordering solves it instead.
   */
  meetingDock: "140",
  /** Dialogs, drawers, backdrops. */
  modal: "300",
  /** Notifications, above modals. */
  toast: "400",
  /** Dropdowns and selects, which must float above a dialog that opened them. */
  popover: "1200",
  /** Above popovers: a tooltip can describe a control inside one. */
  tooltip: "1300",
});

/**
 * The whiteboard surface stack.
 *
 * Its own run of numbers, not a slice of the scale above: everything here is
 * absolutely positioned inside the whiteboard container, so these order chrome
 * *against each other* within that stacking context and never against a dialog
 * or a toast. Kept below `zIndex.popover` so a Base UI popover anchored to a
 * toolbar button still floats over the panel that opened it.
 */
export const boardZIndex = stylex.defineConsts({
  /** Show sources labels: on the canvas, beneath every piece of chrome. */
  sources: "190",
  /** Toolbar strip, pen-mode chip. */
  chrome: "200",
  /** Page rail column. */
  rail: "210",
  /** Floating launcher buttons on the canvas. */
  action: "220",
  /** Full-surface state overlays (preparing). */
  overlay: "240",
  /** Quiet status strip (edit-access syncing). */
  status: "245",
  /** Action bars anchored to a selection. */
  selection: "250",
  /** Notices that must clear the status strip. */
  notice: "260",
  /** Docked panels, import progress chips. */
  panel: "300",
  /** In-surface modal and its backdrop. */
  modal: "500",
  /** Drag-and-drop target overlay. */
  dropzone: "1000",
});
