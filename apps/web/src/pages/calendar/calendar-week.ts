/** The date arithmetic behind the Calendar, kept apart from rendering so it can be tested on its own. */

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

/**
 * Whether an event from `start` to `end` is on `day` (a local midnight): it
 * starts that day, or it began earlier and is still going when the day begins.
 * A meeting that runs past midnight is on both days; one that ends exactly at
 * midnight is not on the next.
 */
export function occursOnDay(start: Date, end: Date, day: Date): boolean {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const dayEnd = addDays(dayStart, 1);
  return start >= dayStart ? start < dayEnd : end > dayStart;
}

/** "2026-10-15" for a local date, as the route carries it. */
export function toDateParam(day: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

export function fromDateParam(value: string | undefined, fallback: Date): Date {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!match) return fallback;
  const [year, month, date] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const day = new Date(year, month, date);
  // `Date` rolls an impossible date over (Feb 31 becomes Mar 3), which would
  // show a different day from the one the URL names.
  return day.getFullYear() === year && day.getMonth() === month && day.getDate() === date ? day : fallback;
}
