import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import { preAuthRateLimitedRequestMiddleware } from "@/app/bootstrap/middleware";
import { lookupMeetingSchema } from "@/modules/meetings/contract/schemas";
import { lookupMeetingForRequest } from "./meeting-lookup.server";

/** Public pre-flight lookup; authentication is optional but refines start authority. */
export const lookupMeeting = createServerFn({ method: "GET" })
  .validator(serverInput(lookupMeetingSchema))
  .middleware([preAuthRateLimitedRequestMiddleware("meeting:lookup-preauth")])
  .handler(async ({ data, context }) => {
    return lookupMeetingForRequest(data.code, context);
  });
