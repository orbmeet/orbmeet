/** Date, time and duration labels shared by every list of Meetings. */

export function formatMeetingDate(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const now = new Date();
  // The calendar day before today, not 24 hours ago: around a daylight-saving
  // change a day is 23 or 25 hours long.
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (date.toDateString() === now.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

export function formatMeetingTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatDurationSpan(
  start: string | null,
  end: string | null,
  units: { hour: string; minute: string },
): string {
  if (!start || !end) return "";
  const mins = Math.floor((Date.parse(end) - Date.parse(start)) / 60_000);
  if (mins < 1) return `< 1${units.minute}`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}${units.minute}`;
  // A whole number of hours reads as "1h" / "1 h", not "1h 0m".
  return m === 0 ? `${h}${units.hour}` : `${h}${units.hour} ${m}${units.minute}`;
}

export function formatMeetingDuration(start: string | null, end: string | null): string {
  return formatDurationSpan(start, end, { hour: "h", minute: "m" });
}

/** "1 person in it", "3 people in it": who is in a live meeting, beside its Live pill. */
export function peopleInMeeting(count: number): string {
  return `${count} ${count === 1 ? "person" : "people"} in it`;
}

/** The first word of a display name: "Atiq Rahman" is "Atiq". */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/**
 * "6:33–7:31 AM": when a meeting ran, as one range. The day period is said
 * once when both ends share it. A meeting that crosses midnight names only the
 * day it ended on, "11:03 PM–12:04 AM (Oct 18)": `formatRange` across two days
 * spelled out both full dates, "10/17/2026, 11:03 PM – 10/18/2026, 12:04 AM".
 */
export function formatTimeRange(start: string, end: string | null): string {
  if (!end) return formatMeetingTime(start);
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(endDate.getTime()) || endDate.getTime() <= startDate.getTime()) return formatMeetingTime(start);
  const format = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });
  if (startDate.toDateString() !== endDate.toDateString()) {
    const endDay = endDate.toLocaleDateString([], { month: "short", day: "numeric" });
    return `${format.format(startDate)}–${format.format(endDate)} (${endDay})`;
  }
  return format.formatRange(startDate, endDate).replace(/\s*[–-]\s*/u, "–");
}

/** "57 min", "1 h 16 min", "2 h": how long a meeting ran, spelled out for a list. */
export function formatMeetingLength(start: string | null, end: string | null): string {
  return formatDurationSpan(start, end, { hour: " h", minute: " min" });
}

/**
 * What a meeting is called in a list. Its own title, or the one Orb gave it
 * from its summary; failing both, who it was with — never the time it ran,
 * which every row already shows.
 */
export function meetingDisplayTitle(
  title: string | null | undefined,
  participantNames: readonly string[],
  viewerName?: string,
): string {
  const named = title?.trim();
  if (named) return named;
  const others = participantNames.filter((name) => name !== viewerName).map(firstName);
  if (others.length === 0) return "Call on your own";
  if (others.length === 1) return `Call with ${others[0]}`;
  if (others.length === 2) return `Call with ${others[0]} and ${others[1]}`;
  return `Call with ${others[0]} and ${others.length - 1} others`;
}
