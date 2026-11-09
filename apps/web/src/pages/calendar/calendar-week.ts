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

/** "2026-10-15" for a local date, as the route carries it. */
export function toDateParam(day: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

export function fromDateParam(value: string | undefined, fallback: Date): Date {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : fallback;
}
