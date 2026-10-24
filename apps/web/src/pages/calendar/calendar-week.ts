/**
 * The arithmetic behind the Calendar's grid, kept apart from rendering so it
 * can be tested on its own: which days a week has, and where an event sits in
 * a day — including side by side with the events it overlaps.
 */

/** Monday of the week that contains `day`, at local midnight. */
export function startOfWeek(day: Date): Date {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const sinceMonday = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - sinceMonday);
  return start;
}

export function addDays(day: Date, days: number): Date {
  const next = new Date(day);
  next.setDate(next.getDate() + days);
  return next;
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "2026-10-15" for a local date, as the route carries it. */
export function toDateParam(day: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

export function fromDateParam(value: string | undefined, fallback: Date): Date {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : fallback;
}

export interface Timed {
  start: Date;
  end: Date;
}

export interface Placed<T> {
  item: T;
  /** Minutes from the day's midnight to where the block starts and ends, clipped to the day. */
  fromMinute: number;
  toMinute: number;
  /** Which of `lanes` side-by-side columns it takes. */
  lane: number;
  lanes: number;
}

/**
 * The events of one day, placed: clipped to the day, and given a lane so that
 * events which overlap sit side by side rather than on top of one another.
 * Each run of overlapping events shares one lane count, the most that are ever
 * on at once within it.
 */
export function placeDay<T extends Timed>(items: readonly T[], day: Date, minMinutes = 20): Placed<T>[] {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const dayEnd = dayStart + 24 * 60 * 60_000;
  const clipped = items
    .filter((item) => item.start.getTime() < dayEnd && item.end.getTime() > dayStart)
    .map((item) => {
      const fromMinute = Math.max(0, (item.start.getTime() - dayStart) / 60_000);
      const toMinute = Math.min(24 * 60, Math.max(fromMinute + minMinutes, (item.end.getTime() - dayStart) / 60_000));
      return { item, fromMinute, toMinute, lane: 0, lanes: 1 };
    })
    .sort((a, b) => a.fromMinute - b.fromMinute || b.toMinute - a.toMinute);

  let cluster: Placed<T>[] = [];
  let clusterEnd = -1;
  const laneEnds: number[] = [];
  const closeCluster = () => {
    const lanes = Math.max(1, laneEnds.length);
    for (const placed of cluster) placed.lanes = lanes;
    cluster = [];
    laneEnds.length = 0;
  };
  for (const placed of clipped) {
    if (placed.fromMinute >= clusterEnd) closeCluster();
    let lane = laneEnds.findIndex((end) => end <= placed.fromMinute);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = placed.toMinute;
    placed.lane = lane;
    cluster.push(placed);
    clusterEnd = Math.max(clusterEnd, placed.toMinute);
  }
  closeCluster();
  return clipped;
}

/**
 * The hour the grid opens scrolled to: `preferred`, unless an event on one of
 * `days` runs across that line. Then its start hour, so it is read whole
 * rather than cut by the header. Events wholly before `preferred` stay above
 * the fold, as in any calendar.
 */
export function openingHour(items: readonly Timed[], days: readonly Date[], preferred: number): number {
  let hour = preferred;
  for (const day of days) {
    const line = new Date(day.getFullYear(), day.getMonth(), day.getDate(), preferred).getTime();
    const midnight = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
    for (const item of items) {
      const start = item.start.getTime();
      if (start < line && start >= midnight && item.end.getTime() > line) {
        hour = Math.min(hour, item.start.getHours());
      }
    }
  }
  return hour;
}
