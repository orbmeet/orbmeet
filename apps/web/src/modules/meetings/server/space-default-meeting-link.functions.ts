import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import * as v from "valibot";
import { idSchema } from "@orbmeet/public-api-contract/fields";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { getSpaceDefaultMeetingLinkImpl, replaceSpaceMeetingLinkImpl } from "./space-default-meeting-link.server";

const spaceDefaultMeetingLinkSchema = v.object({
  spaceId: idSchema,
});

export const getSpaceDefaultMeetingLink = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(spaceDefaultMeetingLinkSchema))
  .handler(async ({ data, context }) => {
    return getSpaceDefaultMeetingLinkImpl({ data, context });
  });

export const replaceSpaceMeetingLink = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(spaceDefaultMeetingLinkSchema))
  .handler(async ({ data, context }) => {
    return replaceSpaceMeetingLinkImpl({ data, context });
  });

export type SpaceDefaultMeetingLinkInput = v.InferOutput<typeof spaceDefaultMeetingLinkSchema>;
