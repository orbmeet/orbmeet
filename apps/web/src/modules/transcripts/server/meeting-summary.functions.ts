import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import * as v from "valibot";
import { idSchema, integerSchema } from "@orbmeet/public-api-contract/fields";
import { MAX_TRANSCRIPT_PAGE_SIZE, transcriptCursorSchema } from "../contract/page";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { getEndedMeetingImpl, getLatestMeetingTranscriptsImpl } from "./meeting-summary.server";

const transcriptPageSchema = v.object({
  cursor: v.optional(transcriptCursorSchema),
  limit: v.optional(integerSchema(1, MAX_TRANSCRIPT_PAGE_SIZE)),
});

const meetingLocatorSchema = v.object({ meetingId: idSchema });

const meetingTranscriptsSchema = v.object({
  ...meetingLocatorSchema.entries,
  ...transcriptPageSchema.entries,
});

export const getEndedMeeting = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(meetingLocatorSchema))
  .handler(async ({ data, context }) => {
    return getEndedMeetingImpl({ data, context });
  });

export const getLatestMeetingTranscripts = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(meetingTranscriptsSchema))
  .handler(async ({ data, context }) => {
    return getLatestMeetingTranscriptsImpl({ data, context });
  });

export type MeetingLocatorInput = v.InferOutput<typeof meetingLocatorSchema>;
export type MeetingTranscriptsInput = v.InferOutput<typeof meetingTranscriptsSchema>;
