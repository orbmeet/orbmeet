let meetingWhiteboardModulePromise: Promise<typeof import("@/modules/whiteboards/client/meeting/connected-whiteboard")> | null = null;

export function preloadMeetingWhiteboardModule() {
  if (!meetingWhiteboardModulePromise) {
    meetingWhiteboardModulePromise = import("@/modules/whiteboards/client/meeting/connected-whiteboard").catch((err) => {
      meetingWhiteboardModulePromise = null;
      throw err;
    });
  }

  return meetingWhiteboardModulePromise;
}

/** The picker for presenting another board: lazy in the meeting, and preloaded with it. */
export function loadMeetingWhiteboardPicker() {
  return import("@/modules/whiteboards/client/meeting/meeting-whiteboard-picker");
}
