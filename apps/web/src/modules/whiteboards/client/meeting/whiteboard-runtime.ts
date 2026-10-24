import {
  loadMeetingWhiteboardPicker,
  preloadMeetingWhiteboardModule,
} from "@/modules/whiteboards/client/meeting/preload-whiteboard";

export { useMeetingWhiteboard } from "@/modules/whiteboards/client/meeting/use-meeting-whiteboard";

/** Every part of the meeting's board that loads apart from the meeting. */
export async function preloadWhiteboard() {
  await Promise.all([preloadMeetingWhiteboardModule(), loadMeetingWhiteboardPicker()]);
}
