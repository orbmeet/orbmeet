import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import * as v from "valibot";
import { idSchema, meetingTitleSchema } from "@orbmeet/public-api-contract/fields";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { JOIN_POLICIES } from "../../contract/constants";
import { updateMeetingLinkImpl, archiveMeetingLinkImpl } from "./dashboard.server";

const archiveMeetingLinkSchema = v.object({
  meetingLinkId: idSchema,
});

const updateMeetingLinkSchema = v.object({
  meetingLinkId: idSchema,
  title: v.nullish(meetingTitleSchema),
  allowGuests: v.optional(v.boolean()),
  joinPolicy: v.optional(v.picklist(JOIN_POLICIES)),
});

export const updateMeetingLink = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(updateMeetingLinkSchema))
  .handler(async ({ data, context }) => {
    return updateMeetingLinkImpl({ data, context });
  });

export const archiveMeetingLink = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(archiveMeetingLinkSchema))
  .handler(async ({ data, context }) => {
    return archiveMeetingLinkImpl({ data, context });
  });

export type ArchiveMeetingLinkInput = v.InferOutput<typeof archiveMeetingLinkSchema>;
export type UpdateMeetingLinkInput = v.InferOutput<typeof updateMeetingLinkSchema>;
