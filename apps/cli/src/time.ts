const OFFSET_OR_UTC = /Z$|[+-]\d{2}:?\d{2}$/;
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):?(\d{2}))$/i;
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/;
const AT_FORMAT_ERROR = "--at must be an ISO instant or YYYY-MM-DD HH:mm with --timezone";

const WALL_CLOCK_FIELDS = ["year", "month", "day", "hour", "minute"] as const;

export type WallClock = Record<(typeof WALL_CLOCK_FIELDS)[number], number>;

export function formatInTimeZone(date: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
  };
}

function toUtc(wallClock: WallClock): number {
  return Date.UTC(
    wallClock.year,
    wallClock.month - 1,
    wallClock.day,
    wallClock.hour,
    wallClock.minute,
  );
}

function isRealInstant([year, month, day, hour, minute, second, offsetHours, offsetMinutes]: number[]): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    hour < 24 &&
    minute < 60 &&
    second < 60 &&
    offsetHours < 24 &&
    offsetMinutes < 60
  );
}

// Wall-clock times that occur twice (DST fall-back) resolve to whichever
// occurrence the fixed-point iteration converges on; times that never occur
// (spring-forward) are rejected.
export function wallClockToIso(value: string, timeZone: string): string {
  if (OFFSET_OR_UTC.test(value)) {
    // `new Date` rolls an impossible date over (2027-02-29 becomes March 1),
    // so the calendar fields are checked before it sees them.
    const fields = ISO_INSTANT.exec(value);
    if (!fields || !isRealInstant(fields.slice(1).map((field) => Number(field ?? 0)))) {
      throw new Error(AT_FORMAT_ERROR);
    }
    const instant = new Date(value);
    if (Number.isNaN(instant.getTime())) throw new Error(AT_FORMAT_ERROR);
    return instant.toISOString();
  }
  const match = WALL_CLOCK.exec(value);
  if (!match) throw new Error(AT_FORMAT_ERROR);
  const desired: WallClock = {
    year: +match[1],
    month: +match[2],
    day: +match[3],
    hour: +match[4],
    minute: +match[5],
  };
  const desiredUtc = toUtc(desired);
  let instant = new Date(desiredUtc);
  for (let attempt = 0; attempt < 3; attempt++) {
    const observed = formatInTimeZone(instant, timeZone);
    instant = new Date(instant.getTime() + desiredUtc - toUtc(observed));
  }
  const observed = formatInTimeZone(instant, timeZone);
  if (WALL_CLOCK_FIELDS.some((field) => desired[field] !== observed[field])) {
    throw new Error("The requested local time does not exist in that time zone");
  }
  return instant.toISOString();
}

export function parseDurationMinutes(value: string | undefined, fallback: number): number {
  const minutes = Number(value === undefined ? fallback : value);
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 24 * 60) {
    throw new Error("--duration must be a whole number of minutes between 15 and 1440");
  }
  return minutes;
}

export function minutesBetween(startsAt: string, endsAt: string): number {
  return Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60_000);
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function assertTimeZone(value: string, source: string): string {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return value;
  } catch {
    throw new Error(`${source} is not a valid IANA time zone: ${value}`);
  }
}
