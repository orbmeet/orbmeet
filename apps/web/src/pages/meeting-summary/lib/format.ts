/** Formats durations shown on an ended Meeting. */
export function formatDuration(seconds: number | null): string {
  if (seconds == null) return "--";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  // A whole number of hours reads as "1h", not "1h 0m".
  if (h > 0) return m === 0 ? `${h}h` : `${h}h ${m}m`;
  if (m > 0) return `${m} min`;
  return "< 1 min";
}

export function formatTimeAgo(date: Date | null, now: number): string {
  if (!date) return "";
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return date.toLocaleDateString();
}
