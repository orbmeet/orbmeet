import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import { preAuthRateLimitedRequestMiddleware } from "@/app/bootstrap/middleware";
import { joinMeetingSchema } from "@/modules/meetings/contract/schemas";
import { joinMeetingImpl } from "./join.server";

export const joinMeeting = createServerFn({ method: "POST" })
  .validator(serverInput(joinMeetingSchema))
  .middleware([preAuthRateLimitedRequestMiddleware("meeting:join-preauth")])
  .handler(async ({ data, context }) => {
    return joinMeetingImpl({ data, context });
  });
