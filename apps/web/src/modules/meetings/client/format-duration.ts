/**
 * Elapsed clock for the live Meeting — `M:SS`, or `H:MM:SS` past the hour.
 *
 * Every clock in the room (the identity band, the phone header, the recording
 * pill, the shared countdown) writes durations this one way.
 */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const safe = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
