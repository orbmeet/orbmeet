/**
 * The video layout is one lazy-loaded unit (see `ESSENTIAL_MEETING_UI` in
 * meeting-ui-modules.ts, which the layout and the meeting page both read),
 * so this barrel is the chunk boundary rather than a convenience re-export.
 */
export { useActiveVideoTracks, useActiveScreenShareTracks } from "./tracks";
export { CameraSwitchButton } from "./camera-switch-button";
export type { RegisterVoiceTile } from "./tiles";
export { VideoGrid, type VideoGridProps } from "./video-grid";
export { SpeakerStage, ScreenShareStage, type SpeakerStageProps } from "./speaker-stage";
export { RoomFaces } from "./room-faces";
