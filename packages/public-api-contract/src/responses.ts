import * as v from "valibot";

import { integerSchema } from "./fields.ts";

const nullableString = v.nullable(v.string());
const integer = v.pipe(v.number(), v.safeInteger());
const count = integerSchema(0);
const revision = integerSchema(1);

export const publicApiErrorSchema = v.looseObject({
  error: v.looseObject({
    code: v.string(),
    message: v.string(),
    details: v.optional(v.unknown()),
  }),
});

export const publicApiMeResponseSchema = v.looseObject({
  data: v.looseObject({
    user: v.looseObject({
      name: v.string(),
      email: v.string(),
      plan: v.string(),
      timeZone: nullableString,
    }),
    scopes: v.array(v.string()),
    serverTime: v.string(),
  }),
});

const publicApiContactCandidateSchema = v.looseObject({
  type: v.literal("contact"),
  name: v.string(),
  // Contacts can exist without an email address; the field is then absent.
  email: v.optional(v.string()),
  meetingCount: count,
  lastMetAt: nullableString,
});

const publicApiSpaceCandidateSchema = v.looseObject({
  type: v.literal("space"),
  name: v.string(),
  memberCount: count,
});

export const publicApiTargetsResponseSchema = v.looseObject({
  data: v.looseObject({
    query: v.string(),
    requiresConfirmation: v.boolean(),
    candidates: v.array(v.variant("type", [
      publicApiContactCandidateSchema,
      publicApiSpaceCandidateSchema,
    ])),
  }),
});

const publicScheduleAttendeeSchema = v.looseObject({
  email: v.string(),
  displayName: nullableString,
});

export const publicScheduleSchema = v.looseObject({
  id: v.string(),
  title: nullableString,
  startsAt: v.string(),
  endsAt: v.string(),
  timeZone: v.string(),
  state: v.picklist(["upcoming", "late_start", "open", "completed", "canceled"]),
  revision: integer,
  code: v.nullish(v.string()),
  spaceName: v.nullish(v.string()),
  organizerName: v.optional(v.string()),
  attendeeCount: v.optional(count),
  attendees: v.optional(v.array(publicScheduleAttendeeSchema)),
  canManage: v.optional(v.boolean()),
});

export const publicScheduleResponseSchema = v.looseObject({
  data: publicScheduleSchema,
});

export const publicScheduleListResponseSchema = v.looseObject({
  data: v.array(publicScheduleSchema),
  nextCursor: v.nullish(v.string()),
});

export const publicScheduleCreateResponseSchema = v.looseObject({
  data: v.looseObject({
    id: v.string(),
    meetingLinkId: v.string(),
    code: v.string(),
    revision: revision,
    title: nullableString,
    startsAt: v.string(),
    endsAt: v.string(),
    timeZone: v.string(),
    reminderMinutesBefore: v.nullable(integer),
    canceledAt: nullableString,
    attendeeCount: count,
    spaceId: nullableString,
    spaceName: nullableString,
  }),
});

export const publicScheduleUpdateResponseSchema = v.looseObject({
  data: v.looseObject({
    id: v.string(),
    revision: revision,
    startsAt: v.string(),
    endsAt: v.string(),
    timeZone: v.string(),
    reminderMinutesBefore: v.nullable(integer),
  }),
});

export const publicScheduleCancelResponseSchema = v.looseObject({
  data: v.looseObject({
    id: v.string(),
    revision: revision,
    alreadyCanceled: v.boolean(),
  }),
});

const downloadableArtifactSchema = v.looseObject({
  filename: v.string(),
  mimeType: v.string(),
  size: v.pipe(v.number(), v.minValue(0)),
  createdAt: v.string(),
  downloadUrl: v.string(),
});

/**
 * One transcript segment as the meetings endpoint emits it. Producers add
 * server-side columns (segment id, identity, updatedAt), so objects are
 * passthrough and only the fields consumers rely on are contractual.
 */
export const publicTranscriptSegmentSchema = v.looseObject({
  participantName: v.string(),
  text: v.string(),
  language: v.nullish(v.string()),
  startedAt: v.string(),
});

export const publicTranscriptCursorSchema = v.looseObject({
  startedAt: v.number(),
  id: v.string(),
});

export const publicTranscriptSchema = v.looseObject({
  segments: v.array(publicTranscriptSegmentSchema),
  nextCursor: v.nullish(publicTranscriptCursorSchema),
  // `truncated` is set by paging clients (the CLI), never by the server.
  truncated: v.optional(v.boolean()),
});

/**
 * The transcript payload travels inside the meeting response; the schema
 * stays separate so paging clients (the CLI) can validate each continuation
 * envelope without requiring the meeting section to be present.
 */
export const publicMeetingTranscriptPageResponseSchema = v.looseObject({
  data: v.looseObject({
    transcript: publicTranscriptSchema,
  }),
});

export const publicMeetingResponseSchema = v.looseObject({
  data: v.looseObject({
    meeting: v.looseObject({
      id: v.string(),
      title: nullableString,
      startedAt: v.string(),
      endedAt: nullableString,
      retainUntil: nullableString,
      spaceName: nullableString,
      participants: v.array(v.string()),
    }),
    available: v.looseObject({
      summary: v.boolean(),
      transcript: v.boolean(),
      recordings: v.boolean(),
      whiteboardPdf: v.boolean(),
    }),
    summary: v.optional(v.unknown()),
    transcript: v.optional(v.unknown()),
    recordings: v.optional(v.array(downloadableArtifactSchema)),
    whiteboardPdf: v.nullish(downloadableArtifactSchema),
  }),
});

// Inferred wire shapes, so consumers derive types from these schemas instead
// of redeclaring them by hand.
export type PublicApiError = v.InferOutput<typeof publicApiErrorSchema>;
export type PublicApiMeResponse = v.InferOutput<typeof publicApiMeResponseSchema>;
export type PublicApiContactCandidate = v.InferOutput<typeof publicApiContactCandidateSchema>;
export type PublicApiSpaceCandidate = v.InferOutput<typeof publicApiSpaceCandidateSchema>;
export type PublicApiTargetsResponse = v.InferOutput<typeof publicApiTargetsResponseSchema>;
export type PublicScheduleAttendee = v.InferOutput<typeof publicScheduleAttendeeSchema>;
export type PublicSchedule = v.InferOutput<typeof publicScheduleSchema>;
export type PublicScheduleResponse = v.InferOutput<typeof publicScheduleResponseSchema>;
export type PublicScheduleListResponse = v.InferOutput<typeof publicScheduleListResponseSchema>;
export type PublicScheduleCreateResponse = v.InferOutput<typeof publicScheduleCreateResponseSchema>;
export type PublicScheduleUpdateResponse = v.InferOutput<typeof publicScheduleUpdateResponseSchema>;
export type PublicScheduleCancelResponse = v.InferOutput<typeof publicScheduleCancelResponseSchema>;
export type PublicDownloadableArtifact = v.InferOutput<typeof downloadableArtifactSchema>;
export type PublicTranscriptSegment = v.InferOutput<typeof publicTranscriptSegmentSchema>;
export type PublicTranscriptCursor = v.InferOutput<typeof publicTranscriptCursorSchema>;
export type PublicTranscript = v.InferOutput<typeof publicTranscriptSchema>;
export type PublicMeetingTranscriptPageResponse =
  v.InferOutput<typeof publicMeetingTranscriptPageResponseSchema>;
export type PublicMeetingResponse = v.InferOutput<typeof publicMeetingResponseSchema>;
