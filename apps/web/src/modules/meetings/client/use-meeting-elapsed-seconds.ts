import { useEffect, useState } from "react";
import { getMeetingElapsedSeconds, type MeetingClockSync } from "@/modules/meetings/client/meeting-clock";

/* oxlint-disable react/purity -- reading the wall clock is this hook's purpose. */
export function useMeetingElapsedSeconds(clock: MeetingClockSync): number {
  "use no memo";
  const [elapsed, setElapsed] = useState(() => getMeetingElapsedSeconds(clock, Date.now()));

  useEffect(() => {
    const update = () => setElapsed(getMeetingElapsedSeconds(clock, Date.now()));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [clock]);

  return elapsed;
}
/* oxlint-enable react/purity */
