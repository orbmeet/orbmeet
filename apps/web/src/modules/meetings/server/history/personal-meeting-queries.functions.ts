import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import * as v from "valibot";
import { idSchema, pageLimitSchema, searchTextSchema } from "@orbmeet/public-api-contract/fields";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { getMyMeetingsImpl } from "./personal-meeting-queries.server";

const getMyMeetingsSchema = v.object({
  search: v.optional(searchTextSchema),
  status: v.optional(v.picklist(["all", "open", "ended"]), "all"),
  scope: v.optional(v.picklist(["all", "personal", "spaces"]), "all"),
  spaceId: v.optional(idSchema),
  hasSummary: v.optional(v.boolean()),
  hasRecording: v.optional(v.boolean()),
  hasWhiteboard: v.optional(v.boolean()),
  /** Only meetings that started at or after this instant, in epoch milliseconds. */
  since: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  /** Only meetings that started before this instant, in epoch milliseconds. */
  until: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  /** Only meetings this person was let into, by the name they joined with. */
  person: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(200))),
  cursor: v.optional(v.string()),
  limit: pageLimitSchema(30),
});

export const getMyMeetings = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(getMyMeetingsSchema))
  .handler(async ({ data, context }) => {
    return getMyMeetingsImpl({ data, context });
  });

export type GetMyMeetingsInput = v.InferOutput<typeof getMyMeetingsSchema>;
