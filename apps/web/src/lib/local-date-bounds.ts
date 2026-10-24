const SEARCH_PADDING_MS = 2 * 24 * 60 * 60 * 1_000;
const MAX_CACHED_DATE_FORMATTERS = 128;
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  // resolvedOptions() canonicalizes aliases/casing before they can become cache
  // keys. The LRU bound protects the isolate even across many valid zones.
  const candidate = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const canonicalTimeZone = candidate.resolvedOptions().timeZone;
  const cached = dateFormatters.get(canonicalTimeZone);
  if (cached) return cached;
  dateFormatters.set(canonicalTimeZone, candidate);
  if (dateFormatters.size > MAX_CACHED_DATE_FORMATTERS) {
    const oldest = dateFormatters.keys().next().value;
    if (oldest !== undefined) dateFormatters.delete(oldest);
  }
  return candidate;
}

export function localDateInTimeZone(instant: Date | string, timeZone: string): string {
  const parts = dateFormatter(timeZone)
    .formatToParts(typeof instant === "string" ? new Date(instant) : instant);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

function nextCalendarDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return [
    String(next.getUTCFullYear()).padStart(4, "0"),
    String(next.getUTCMonth() + 1).padStart(2, "0"),
    String(next.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * Finds the first UTC millisecond whose local calendar date is at least the
 * requested date. Local dates are monotonic across ordinary offset and DST
 * changes, so a bounded binary search handles fractional offsets, repeated
 * hours, and skipped dates without trying to guess the zone's UTC offset.
 */
function firstInstantOnOrAfterLocalDate(date: string, timeZone: string): Date {
  const midnightUtc = Date.parse(`${date}T00:00:00.000Z`);
  let low = midnightUtc - SEARCH_PADDING_MS;
  let high = midnightUtc + SEARCH_PADDING_MS;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (localDateInTimeZone(new Date(middle), timeZone) < date) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return new Date(low);
}

/** Exact UTC half-open interval occupied by one IANA-zone calendar date. */
export function utcBoundsForLocalDate(
  date: string,
  timeZone: string,
): { earliest: Date; latest: Date } {
  return {
    earliest: firstInstantOnOrAfterLocalDate(date, timeZone),
    latest: firstInstantOnOrAfterLocalDate(nextCalendarDate(date), timeZone),
  };
}
