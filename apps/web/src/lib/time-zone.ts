import { MAX_TIME_ZONE_LENGTH, isValidTimeZone } from "@orbmeet/public-api-contract/time-zone";

// IANA time zones. The validator itself (`timeZoneSchema`) is shared with the
// public API in `@orbmeet/public-api-contract/fields`; these are the app-side
// helpers around it.

/**
 * The zone this device is in.
 *
 * A *suggestion*, never a durable default: `users.time_zone` is null until the
 * user chooses one, and the schema is explicit that clients must not persist or
 * silently change it on their behalf. Callers may use this to label something
 * they are rendering or creating right now; they may not write it to the user.
 */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Narrow an untrusted zone from a request body to one that is safe to format
 * with, or `null`.
 *
 * Separate from `timeZoneSchema` because the callers differ in what a bad value
 * means. Saving a profile should *fail* on a zone the runtime cannot read — the
 * user typed it and needs to know. Naming a whiteboard should not: the zone
 * there is a hint the client volunteered, and refusing to create the board over
 * it would be absurd.
 */
export function coerceSuggestedTimeZone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_TIME_ZONE_LENGTH) return null;
  return isValidTimeZone(trimmed) ? trimmed : null;
}

/**
 * The ISO calendar day (`YYYY-MM-DD`) at `instant` as `timeZone` experienced it,
 * falling back to UTC for a missing or unusable zone.
 */
export function formatCalendarDay(
  instant: Date,
  timeZone: string | null,
): string {
  if (!timeZone) return instant.toISOString().slice(0, 10);
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instant);
  } catch {
    // A zone the runtime does not recognise must not break the caller; the UTC
    // day is wrong by at most one day, and a failed write is wrong always.
    return instant.toISOString().slice(0, 10);
  }
}

/**
 * The same calendar day as `formatCalendarDay`, written the way the app shows
 * dates — "Oct 12, 2026" — for names people read rather than sort.
 */
export function formatCalendarDayLabel(instant: Date, timeZone: string | null): string {
  const options: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: timeZone ?? "UTC" }).format(instant);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(instant);
  }
}
