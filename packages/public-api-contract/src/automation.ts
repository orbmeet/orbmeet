import { PERSONAL_ACCESS_TOKEN_SCOPES } from "@orbmeet/domain-model";
import * as v from "valibot";

import {
  calendarDateSchema,
  idSchema,
  integerSchema,
  pageLimitSchema,
  searchTextSchema,
  timeZoneSchema,
  trimmedText,
} from "./fields.ts";

export const personalAccessTokenScopeSchema = v.picklist(PERSONAL_ACCESS_TOKEN_SCOPES);

export const createPersonalAccessTokenSchema = v.object({
  name: trimmedText(100),
  scopes: v.optional(
    v.pipe(
      v.array(personalAccessTokenScopeSchema),
      v.nonEmpty(),
      v.maxLength(PERSONAL_ACCESS_TOKEN_SCOPES.length),
    ),
    () => [...PERSONAL_ACCESS_TOKEN_SCOPES],
  ),
  expiresInDays: v.optional(integerSchema(1, 365)),
});

export const revokePersonalAccessTokenSchema = v.object({
  tokenId: idSchema,
});

export const searchAutomationTargetsSchema = v.object({
  query: searchTextSchema,
  limit: pageLimitSchema(10, 20),
});

export const automationScheduleSelectorSchema = v.pipe(
  v.object({
    date: v.optional(calendarDateSchema),
    timeZone: timeZoneSchema,
    title: v.optional(searchTextSchema),
    space: v.optional(searchTextSchema),
    participant: v.optional(searchTextSchema),
  }),
  v.partialCheck(
    [["date"], ["title"], ["space"], ["participant"]],
    (selector) => Boolean(selector.date || selector.title || selector.space || selector.participant),
    "Provide at least one schedule selector",
  ),
);

export const automationMeetingContentSchema = v.picklist([
  "summary",
  "transcript",
  "recordings",
  "whiteboard_pdf",
]);

/**
 * Find one Meeting either by its id or by human selectors in a time zone.
 * Transcript cursors only continue a lookup that already resolved to an id.
 */
export const automationMeetingLookupSchema = v.pipe(
  v.object({
    meetingId: v.optional(idSchema),
    date: v.optional(calendarDateSchema),
    timeZone: v.optional(timeZoneSchema),
    title: v.optional(searchTextSchema),
    space: v.optional(searchTextSchema),
    participant: v.optional(searchTextSchema),
    include: v.optional(v.pipe(v.array(automationMeetingContentSchema), v.maxLength(4)), () => []),
    transcriptCursor: v.optional(v.object({
      startedAt: integerSchema(1),
      id: idSchema,
    })),
    transcriptLimit: pageLimitSchema(500, 500),
  }),
  v.forward(
    v.partialCheck(
      [["meetingId"], ["timeZone"]],
      (lookup) => Boolean(lookup.meetingId || lookup.timeZone),
      "A time zone is required for Meeting selectors",
    ),
    ["timeZone"],
  ),
  v.partialCheck(
    [["meetingId"], ["date"], ["title"], ["space"], ["participant"]],
    (lookup) => Boolean(lookup.meetingId || lookup.date || lookup.title || lookup.space || lookup.participant),
    "Provide at least one Meeting selector",
  ),
  v.forward(
    v.partialCheck(
      [["meetingId"], ["transcriptCursor"]],
      (lookup) => Boolean(lookup.meetingId || !lookup.transcriptCursor),
      "Transcript cursors require an internal Meeting reference",
    ),
    ["transcriptCursor"],
  ),
);

export type AutomationScheduleSelector = v.InferOutput<typeof automationScheduleSelectorSchema>;
export type AutomationMeetingLookup = v.InferOutput<typeof automationMeetingLookupSchema>;
export type AutomationMeetingContent = v.InferOutput<typeof automationMeetingContentSchema>;
