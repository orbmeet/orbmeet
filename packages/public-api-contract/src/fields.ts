import * as v from "valibot";

import { fitsD1ContainsPattern } from "./search-pattern.ts";
import { MAX_TIME_ZONE_LENGTH, isValidTimeZone } from "./time-zone.ts";

export { MAX_TIME_ZONE_LENGTH, isValidTimeZone };

// Field-level rules shared by the public API and the web app's own forms and
// server functions. Each rule lives here once, so a value cannot validate in
// one place and fail in another.
//
// The helpers are marked side-effect free, as Valibot's own functions are, so
// a schema no client code reads is tree-shaken out of the browser bundle.

/**
 * Longest identifier a client may send back. Minted ids top out at 48
 * characters (the longest prefix plus 26); participant identities and
 * principal keys are built from those ids.
 */
export const MAX_ID_LENGTH = 128;

/** A non-empty identifier: a row id, token, or code minted by the system. */
export const idSchema = v.pipe(v.string(), v.nonEmpty(), v.maxLength(MAX_ID_LENGTH));

/** Trimmed free text of 1..`max` characters. */
/* @__NO_SIDE_EFFECTS__ */
export function trimmedText(max: number, requiredMessage?: string) {
  return v.pipe(v.string(), v.trim(), v.nonEmpty(requiredMessage), v.maxLength(max));
}

/** A whole number in `[min, max]`. Also rules out `Infinity` and unsafe integers. */
/* @__NO_SIDE_EFFECTS__ */
export function integerSchema(min: number, max: number = Number.MAX_SAFE_INTEGER) {
  return v.pipe(v.number(), v.safeInteger(), v.minValue(min), v.maxValue(max));
}

/** A finite number; `v.number()` alone admits `Infinity`. */
export const finiteNumberSchema = v.pipe(v.number(), v.finite());

/** Page size for a list endpoint: 1..`max`, `fallback` when omitted. */
/* @__NO_SIDE_EFFECTS__ */
export function pageLimitSchema(fallback: number, max = 100) {
  return v.optional(integerSchema(1, max), fallback);
}

// Also accepts apostrophes and plus-addressing in the local part.
const EMAIL_REGEX =
  /^(?!\.)(?!.*\.\.)[A-Za-z0-9_'+\-.]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;

const MAX_EMAIL_LENGTH = 320;

export const emailSchema = v.pipe(
  v.string(),
  v.regex(EMAIL_REGEX, "Invalid email address"),
  v.maxLength(MAX_EMAIL_LENGTH),
);

/**
 * An IANA zone the runtime recognises. Asking the runtime builds an
 * `Intl.DateTimeFormat`, which costs about a hundred times the rest of a
 * typical parse, and requests name the same few zones over and over, so the
 * result is cached per input.
 */
export const timeZoneSchema = v.cache(
  v.pipe(
    v.string(),
    v.trim(),
    v.nonEmpty(),
    v.maxLength(MAX_TIME_ZONE_LENGTH),
    v.check(isValidTimeZone, "Invalid IANA time zone"),
  ),
  { maxSize: 256 },
);

/**
 * A zone a client volunteers as a hint, such as for naming a board after the
 * day its people are having. Bounded, not validated: a zone the runtime does
 * not know must not fail the request, so callers narrow it with
 * `coerceSuggestedTimeZone` instead.
 */
export const timeZoneHintSchema = v.pipe(v.string(), v.trim(), v.maxLength(MAX_TIME_ZONE_LENGTH));

/**
 * A meeting title reaches recipients as an email `Subject`, so it must not carry
 * line breaks or other control characters. Collapsing them here keeps the stored
 * title and the header consistent; `sanitizeSubject` in the mailer is the
 * matching backstop for titles that predate this rule.
 */
export const meetingTitleSchema = v.pipe(
  v.string(),
  v.transform((value) => value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()),
  v.maxLength(200),
);

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `value` is a `YYYY-MM-DD` day that exists on the calendar. */
export function isCalendarDate(value: string): boolean {
  const match = CALENDAR_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export const calendarDateSchema = v.pipe(
  v.string(),
  v.regex(CALENDAR_DATE, "Date must use YYYY-MM-DD"),
  v.check(isCalendarDate, "Invalid calendar date"),
);

/**
 * Free text matched with a D1 `LIKE` pattern, which D1 caps at 50 bytes after
 * UTF-8 encoding and wildcard escaping.
 */
export const searchTextSchema = v.pipe(
  v.string(),
  v.trim(),
  v.nonEmpty(),
  v.maxLength(200),
  v.check(fitsD1ContainsPattern, "Search text is too long after UTF-8 and wildcard escaping"),
);
