import { LiveMeetingLayout } from "@/modules/meetings/client/components/live-meeting-layout";
import {
  useLiveMeeting,
  type LiveMeetingProps,
} from "@/modules/meetings/client/use-live-meeting";
import { useMeetingWhiteboard } from "@/modules/whiteboards/client/meeting/whiteboard-runtime";

/**
 * Live Meeting composition. The Meeting is the core; the Whiteboard joins it
 * as an optional extension surface whose availability is decided at runtime
 * (the join result names the node holding the board), not at build time.
 */
export function LiveMeeting(props: LiveMeetingProps) {
  const meeting = useLiveMeeting(props);
  const whiteboard = useMeetingWhiteboard({
    code: props.code,
    joinResult: props.joinResult,
    meeting,
    isAuthenticated: props.isAuthenticated,
  });

  return (
    <LiveMeetingLayout meeting={meeting} extensions={whiteboard.extensions} />
  );
}
