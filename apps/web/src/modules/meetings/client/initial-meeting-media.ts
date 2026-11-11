import * as React from "react";

/** How the join's own microphone/camera publish ended, per device. */
export interface InitialMeetingMediaResult {
  audioError: unknown | null;
  videoError: unknown | null;
}

/**
 * The join's initial publish, as `MeetingConnection` started it.
 *
 * The meeting view mounts on RTC connect while that publish is usually still
 * waiting on `getUserMedia`, so what the participant looks like at mount says
 * nothing about how it went. Consumers wait on this instead of sampling.
 * Null where no initial publish was started.
 */
export const InitialMeetingMediaContext = React.createContext<Promise<InitialMeetingMediaResult> | null>(null);
