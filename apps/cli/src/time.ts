import {
  currentTimeZoneName,
  formatInTimeZone,
  isValidTimeZone,
  resolveWallClockToIso,
  type WallClock,
} from "@orbmeet/primitives/time-zone";

export { formatInTimeZone };

const OFFSET_OR_UTC = /Z$|[+-]\d{2}:?\d{2}$/;
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):?(\d{2}))$/i;
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/;
const AT_FORMAT_ERROR = "--at must be an ISO instant or YYYY-MM-DD HH:mm with --timezone";

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
  const iso = resolveWallClockToIso(desired, timeZone);
  if (iso === null) {
    throw new Error("The requested local time does not exist in that time zone");
  }
  return iso;
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

/**
 * The machine's IANA zone, or null when the runtime cannot name it. Node
 * cannot when TZ is empty (`TZ=`, which POSIX reads as UTC, comes back as
 * `Etc/Unknown`) or is a path or a POSIX rule (`TZ=:/etc/localtime`,
 * `TZ=UTC0`), while `Date` still keeps the machine's clock. A nameless clock
 * that never leaves UTC is UTC; for any other, answering UTC would move every
 * time by the machine's offset.
 */
export function localTimeZone(): string | null {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (zone && isValidTimeZone(zone)) return currentTimeZoneName(zone);
  const year = new Date().getFullYear();
  const alwaysUtc = [0, 6].every((month) => new Date(year, month, 1).getTimezoneOffset() === 0);
  return alwaysUtc ? "UTC" : null;
}

/** The machine's IANA zone, or an error that says how to give one instead. */
export function requireLocalTimeZone(): string {
  const zone = localTimeZone();
  if (zone) return zone;
  throw new Error(
    `This machine's time zone has no IANA name (TZ=${JSON.stringify(process.env.TZ ?? "")}). `
      + "Pass --timezone, set ORBMEET_TIMEZONE, or set TZ to a zone such as Asia/Dhaka.",
  );
}

export function assertTimeZone(value: string, source: string): string {
  if (!isValidTimeZone(value)) {
    throw new Error(`${source} is not a valid IANA time zone: ${value}`);
  }
  return value;
}
