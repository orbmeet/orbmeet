/**
 * The parts of the live meeting that load apart from the meeting route, so
 * the pre-join screen renders before them. `LiveMeetingLayout` renders each
 * lazily from these loaders, and the meeting page preloads every one while
 * the participant is still at the door.
 *
 * Every part must be here. A deploy replaces the app's chunks, and a chunk a
 * tab first asks for mid-meeting may no longer exist; the meeting page cannot
 * reload to recover without dropping the participant out of the call.
 */
export const ESSENTIAL_MEETING_UI = {
  controlDock: () => import("./meeting-control-dock"),
  identity: () => import("./meeting-identity"),
  videoLayout: () => import("./video-layout"),
  phoneDock: () => import("./phone-dock"),
} as const;

/** Parts a participant reaches after joining: panels, dialogs and overlays. */
export const SECONDARY_MEETING_UI = {
  captionLanguagePicker: () => import("./caption-language-picker"),
  commandPalette: () => import("./meeting-command-palette"),
  endMeetingDialog: () => import("./end-meeting-dialog"),
  liveCaption: () => import("./live-caption"),
  participantsPanel: () => import("./participants-panel"),
  sideColumn: () => import("./meeting-side-column"),
  timeline: () => import("./meeting-timeline"),
} as const;

/** Load every part in `modules`, resolving once all have loaded. */
export function preloadMeetingUi(modules: Record<string, () => Promise<unknown>>): Promise<void> {
  return Promise.all(Object.values(modules).map((load) => load())).then(() => undefined);
}
