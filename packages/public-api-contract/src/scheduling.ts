import { SCHEDULABLE_JOIN_POLICIES } from "@orbmeet/domain-model";
import * as v from "valibot";

import {
  emailSchema,
  idSchema,
  integerSchema,
  isCalendarDate,
  meetingTitleSchema,
  searchTextSchema,
  timeZoneSchema,
  trimmedText,
} from "./fields.ts";

const TIME = String.raw`(?:[01]\d|2[0-3]):[0-5]\d`;
const SECONDS = String.raw`:[0-5]\d(?:\.\d+)?`;
const OFFSET = String.raw`(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)`;
/** RFC 3339: a time that names its zone carries seconds. */
const EXPLICIT_INSTANT = new RegExp(String.raw`^(\d{4}-\d{2}-\d{2})T${TIME}${SECONDS}${OFFSET}$`);
/** v1 accepted zone-less date-times and read them as UTC. */
const LOCAL_DATE_TIME = new RegExp(String.raw`^(\d{4}-\d{2}-\d{2})T${TIME}(?:${SECONDS})?$`);

function isRfc1123(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toUTCString() === value;
}

/**
 * The instant a schedule starts at, as an ISO string, or `null`.
 *
 * Explicit instants pass through unchanged. The v1 forms stay accepted: a
 * zone-less date-time is read as UTC, a bare date as UTC midnight, and an RFC
 * 1123 date is re-expressed in ISO. Every form must name a real calendar day,
 * so `Date.parse` never gets to roll an impossible date into the next month.
 */
function normalizeScheduleInstant(value: string): string | null {
  const explicit = EXPLICIT_INSTANT.exec(value);
  if (explicit) return isCalendarDate(explicit[1]) ? value : null;
  const local = LOCAL_DATE_TIME.exec(value);
  if (local) return isCalendarDate(local[1]) ? `${value}Z` : null;
  if (isCalendarDate(value)) return `${value}T00:00:00.000Z`;
  if (isRfc1123(value)) return new Date(value).toISOString();
  return null;
}

const scheduleInstantSchema = v.pipe(
  v.string(),
  v.maxLength(64),
  v.rawTransform(({ dataset, addIssue, NEVER }) => {
    const instant = normalizeScheduleInstant(dataset.value);
    if (instant !== null) return instant;
    addIssue({ message: "Invalid date and time" });
    return NEVER;
  }),
);

export const meetingScheduleAttendeeInputSchema = v.object({
  email: emailSchema,
  displayName: v.optional(trimmedText(100)),
});

const durationMinutesSchema = integerSchema(15, 24 * 60);
const reminderMinutesSchema = v.nullish(integerSchema(5, 7 * 24 * 60));
const revisionSchema = integerSchema(1);

const meetingScheduleEntries = {
  title: v.optional(meetingTitleSchema),
  startsAt: scheduleInstantSchema,
  durationMinutes: durationMinutesSchema,
  timeZone: timeZoneSchema,
  spaceId: v.optional(idSchema),
  attendees: v.optional(v.pipe(v.array(meetingScheduleAttendeeInputSchema), v.maxLength(10)), () => []),
  joinPolicy: v.optional(v.picklist(SCHEDULABLE_JOIN_POLICIES), "open"),
  reminderMinutesBefore: reminderMinutesSchema,
};

export const createMeetingScheduleSchema = v.strictObject(meetingScheduleEntries);

/**
 * The automation surface adds contacts and Spaces named by id or by name. A
 * Space schedule invites the Space's members, so it takes no other targets.
 */
export const createAutomationMeetingScheduleSchema = v.pipe(
  v.strictObject({
    ...meetingScheduleEntries,
    contactIds: v.optional(v.pipe(v.array(idSchema), v.maxLength(10)), () => []),
    contactNames: v.optional(v.pipe(v.array(searchTextSchema), v.maxLength(10)), () => []),
    spaceName: v.optional(searchTextSchema),
  }),
  v.forward(
    v.partialCheck(
      [["spaceId"], ["spaceName"]],
      (input) => !(input.spaceId && input.spaceName),
      "Provide either spaceId or spaceName, not both",
    ),
    ["spaceName"],
  ),
  v.forward(
    v.partialCheck(
      [["attendees"], ["contactIds"], ["contactNames"]],
      (input) => input.attendees.length + input.contactIds.length + input.contactNames.length <= 10,
      "A schedule can have at most 10 attendee targets",
    ),
    ["attendees"],
  ),
  v.forward(
    v.partialCheck(
      [["spaceId"], ["spaceName"], ["attendees"], ["contactIds"], ["contactNames"]],
      (input) => !(input.spaceId || input.spaceName)
        || (input.attendees.length === 0 && input.contactIds.length === 0 && input.contactNames.length === 0),
      "Space schedules invite Space members and cannot include attendee or contact targets",
    ),
    ["attendees"],
  ),
);

export const rescheduleMeetingSchema = v.object({
  scheduleId: idSchema,
  expectedRevision: revisionSchema,
  startsAt: scheduleInstantSchema,
  durationMinutes: durationMinutesSchema,
  timeZone: timeZoneSchema,
  reminderMinutesBefore: reminderMinutesSchema,
});

export const cancelMeetingScheduleSchema = v.object({
  scheduleId: idSchema,
  expectedRevision: revisionSchema,
  reason: v.optional(trimmedText(500)),
});

export const getMeetingScheduleSchema = v.object({
  scheduleId: idSchema,
});
