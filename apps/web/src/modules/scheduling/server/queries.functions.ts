import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import * as v from "valibot";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { getMyUpcomingMeetingSchedulesImpl } from "./queries.server";

const getMyUpcomingMeetingSchedulesValidator = v.object({
  cursor: v.optional(v.string()),
  spaceId: v.optional(v.pipe(v.string(), v.nonEmpty(), v.maxLength(80))),
});

export const getMyUpcomingMeetingSchedules = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(getMyUpcomingMeetingSchedulesValidator))
  .handler(async ({ data, context }) => {
    return getMyUpcomingMeetingSchedulesImpl({ data, context });
  });

export type GetMyUpcomingMeetingSchedulesInput = v.InferOutput<typeof getMyUpcomingMeetingSchedulesValidator>;
