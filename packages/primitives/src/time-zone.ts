// Plain time-zone helpers, free of any schema library so browser code can use
// them without pulling one in. `timeZoneSchema` in `fields.ts` builds on them.

export const MAX_TIME_ZONE_LENGTH = 100;

/** Whether the runtime recognises `value` as an IANA zone. */
export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

/**
 * Zones V8 still names as IANA no longer does. V8 (Chrome, Edge, Node,
 * Workers) takes its names from CLDR, which keeps an identifier once issued,
 * so India is `Asia/Calcutta` there and `Asia/Kolkata` in Firefox and Safari.
 * Each pair is one zone under two spellings, and V8 accepts both.
 *
 * Every link in tzdata's `backward` file whose name V8 lists and whose target
 * it does not, less `Indian/Cocos`: tzdata merged its rules into
 * Asia/Yangon's, but it is a different place, not a renamed one.
 */
const CURRENT_TIME_ZONE_NAMES: Readonly<Record<string, string>> = {
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Godthab": "America/Nuuk",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Louisville": "America/Kentucky/Louisville",
  "America/Mendoza": "America/Argentina/Mendoza",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Europe/Kiev": "Europe/Kyiv",
  "Pacific/Enderbury": "Pacific/Kanton",
};

/** `zone` under its current IANA name, whichever spelling the runtime reported. */
export function currentTimeZoneName(zone: string): string {
  return Object.hasOwn(CURRENT_TIME_ZONE_NAMES, zone) ? CURRENT_TIME_ZONE_NAMES[zone] : zone;
}

const WALL_CLOCK_FIELDS = ["year", "month", "day", "hour", "minute"] as const;

export type WallClock = Record<(typeof WALL_CLOCK_FIELDS)[number], number>;

/** Format `date` into its calendar/clock components in `timeZone`. */
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

/**
 * Resolve a local wall-clock time in `timeZone` to an ISO 8601 UTC string, or
 * `null` when that local time does not exist (such as during a DST
 * spring-forward gap or an impossible calendar date).
 *
 * Wall-clock times that occur twice (DST fall-back) resolve to whichever
 * occurrence the 3-iteration fixed-point solver converges on.
 */
export function resolveWallClockToIso(desired: WallClock, timeZone: string): string | null {
  const desiredUtc = toUtc(desired);
  let instant = new Date(desiredUtc);
  for (let attempt = 0; attempt < 3; attempt++) {
    const observed = formatInTimeZone(instant, timeZone);
    instant = new Date(instant.getTime() + desiredUtc - toUtc(observed));
  }
  const observed = formatInTimeZone(instant, timeZone);
  if (WALL_CLOCK_FIELDS.some((field) => desired[field] !== observed[field])) {
    return null;
  }
  return instant.toISOString();
}
