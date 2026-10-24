import * as v from "valibot";
import { idSchema, integerSchema, meetingTitleSchema } from "@orbmeet/public-api-contract/fields";
import { JOIN_POLICIES, MEETING_CODE_REGEX, MEETING_LINK_REUSE_POLICIES } from "./constants";
import { containsBlockedMeetingCodeTerm } from "./code-blocklist";

const meetingCodeSchema = v.pipe(v.string(), v.regex(MEETING_CODE_REGEX, "Invalid meeting code"));

export const createMeetingSchema = v.object({
  title: v.optional(meetingTitleSchema),
  // Refused by the handler with a pointer to the Space's own meeting link.
  spaceId: v.optional(idSchema),
  allowGuests: v.optional(v.boolean(), true),
  joinPolicy: v.optional(v.picklist(JOIN_POLICIES), "open"),
  linkType: v.optional(v.picklist(MEETING_LINK_REUSE_POLICIES), "one_time"),
  // Pro/Organization only, requires a reusable link.
  customCode: v.optional(v.pipe(
    v.string(),
    v.regex(MEETING_CODE_REGEX, "Code must be in abc-defg-hij format (3-4-3 lowercase letters)"),
    // Held to the same standard as a generated code. A chosen code is more
    // deliberate, not less: it is the address other people are asked to visit.
    v.check(
      (code) => !containsBlockedMeetingCodeTerm(code),
      "That meeting code isn't available. Please choose a different one.",
    ),
  )),
});

export const lookupMeetingSchema = v.object({
  code: meetingCodeSchema,
});

export const joinMeetingSchema = v.object({
  code: meetingCodeSchema,
  displayName: v.optional(v.pipe(v.string(), v.nonEmpty(), v.maxLength(100))),
  captionLanguage: v.optional(v.pipe(v.string(), v.nonEmpty(), v.maxLength(35))),
  // Allow reconnect via admissionId — guest secret is read from the HttpOnly cookie.
  reconnectAdmissionId: v.optional(idSchema),
  // Names this request, so a retry of it gets the same connection back.
  clientAttemptId: v.pipe(v.string(), v.uuid()),
  // Names a guest's first join, however many requests it takes: each retry
  // carries the same key, so it gets the same admission and seat back.
  firstJoinKey: v.optional(v.pipe(v.string(), v.uuid())),
  // The media node URL a rejoining client could not reach; the Worker probes
  // that node before sending the client back to it.
  unreachableMediaUrl: v.optional(v.pipe(v.string(), v.nonEmpty(), v.maxLength(256))),
  // Milliseconds from the browser to each media node it reached, by node id:
  // what places a meeting its join starts. Absent, the Worker measures from
  // its data centre instead.
  nodeLatencies: v.optional(v.pipe(
    v.record(
      v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,30}$/)),
      v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10_000)),
    ),
    v.check((latencies) => Object.keys(latencies).length <= 16, "Too many nodes"),
  )),
  // The connection a removed client lost, when it asks why it was removed. If
  // another tab or device took over from it, the answer is to stay out.
  replacesConnectionId: v.optional(idSchema),
  // The meeting a recovering or removed client was in. If it is no longer the
  // link's open meeting, it ended: the answer is that, never a new meeting.
  resumeMeetingId: v.optional(idSchema),
});

/** A participant acting through their own connection attempt. */
const ownConnection = { meetingId: idSchema, connectionId: idSchema };
/**
 * A moderator acting on the meeting. A signed-in moderator is known by their
 * session; a guest moderator names the connection that proves their seat.
 */
const moderatorConnection = { meetingId: idSchema, connectionId: v.optional(idSchema) };

export const endMeetingSchema = v.object({ meetingId: idSchema });
export const ownConnectionSchema = v.object(ownConnection);
export const listPendingAdmissionsSchema = v.object(moderatorConnection);
export const decideAdmissionSchema = v.object({
  ...moderatorConnection,
  admissionId: idSchema,
  approve: v.boolean(),
});
export const setMeetingJoinPolicySchema = v.object({
  meetingId: idSchema,
  joinPolicy: v.picklist(JOIN_POLICIES),
});
export const setMeetingModeratorSchema = v.object({
  meetingId: idSchema,
  targetParticipantIdentity: v.pipe(v.string(), v.nonEmpty(), v.maxLength(300)),
  moderator: v.boolean(),
});
/** A moderator's decision about one participant, named by their admission. */
export const requestBoardSchema = v.object({ ...ownConnection, requested: v.boolean() });
export const participantDecisionSchema = v.object({
  ...moderatorConnection,
  admissionId: idSchema,
});
export const decideScreenShareSchema = v.object({
  ...moderatorConnection,
  admissionId: idSchema,
  allow: v.boolean(),
});
export const setCountdownSchema = v.object({
  ...moderatorConnection,
  endsAtMs: v.nullable(integerSchema(0)),
});
export const setRecordingSchema = v.object({ meetingId: idSchema, on: v.boolean() });
/** A host or co-host turning transcription on or off; a guest co-host names their connection. */
export const setTranscriptionSchema = v.object({ ...moderatorConnection, on: v.boolean() });
export const requestTranscriptionStopSchema = v.object({ ...ownConnection, requested: v.boolean() });

const STREAMING_PLATFORMS = [
  "twitch",
  "youtube",
  "facebook",
  "kick",
  "linkedin",
  "instagram",
  "tiktok",
  "x",
  "custom",
] as const;
export type StreamingPlatform = (typeof STREAMING_PLATFORMS)[number];

export const FIXED_RTMP_STREAM_KEY_REGEX = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,511}$/;
const FIXED_RTMP_STREAMING_PLATFORMS = new Set<StreamingPlatform>([
  "twitch",
  "youtube",
  "facebook",
  "kick",
]);

export const setStreamingSchema = v.pipe(
  v.object({
    meetingId: idSchema,
    on: v.boolean(),
    platform: v.optional(v.picklist(STREAMING_PLATFORMS)),
    streamKey: v.optional(v.pipe(v.string(), v.nonEmpty(), v.maxLength(2048))),
  }),
  v.forward(
    v.partialCheck(
      [["on"], ["platform"], ["streamKey"]],
      (value) =>
        !(
          value.on
          && value.platform
          && FIXED_RTMP_STREAMING_PLATFORMS.has(value.platform)
          && value.streamKey
          && !FIXED_RTMP_STREAM_KEY_REGEX.test(value.streamKey.trim())
        ),
      "Stream key contains unsupported characters",
    ),
    ["streamKey"],
  ),
);
