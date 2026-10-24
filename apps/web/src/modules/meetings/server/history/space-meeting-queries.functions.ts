import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import * as v from "valibot";
import { idSchema, meetingTitleSchema, pageLimitSchema } from "@orbmeet/public-api-contract/fields";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { listSpaceMeetingsImpl, renameOpenMeetingImpl } from "./space-meeting-queries.server";

const renameOpenMeetingSchema = v.object({
  meetingId: idSchema,
  title: v.nullable(meetingTitleSchema),
  expectedTitle: v.nullable(v.pipe(v.string(), v.maxLength(200))),
});

const listSpaceMeetingsSchema = v.object({
  spaceId: idSchema,
  // Opaque keyset cursor (`lib/keyset-cursor`) over the ended meetings.
  cursor: v.optional(v.string()),
  limit: pageLimitSchema(30),
});

export const listSpaceMeetings = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(listSpaceMeetingsSchema))
  .handler(async ({ data, context }) => {
    return listSpaceMeetingsImpl({ data, context });
  });

export const renameOpenMeeting = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(renameOpenMeetingSchema))
  .handler(async ({ data, context }) => {
    return renameOpenMeetingImpl({ data, context });
  });

export type RenameOpenMeetingInput = v.InferOutput<typeof renameOpenMeetingSchema>;
export type ListSpaceMeetingsInput = v.InferOutput<typeof listSpaceMeetingsSchema>;
