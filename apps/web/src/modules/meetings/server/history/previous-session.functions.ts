import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import { preAuthRateLimitedRequestMiddleware } from "@/app/bootstrap/middleware";
import { lookupMeetingSchema } from "@/modules/meetings/contract/schemas";
import { getPreviousSessionForRequest } from "./previous-session.server";

/** The last session on a link, for the doorway. Empty for anyone who may not read its history. */
export const getPreviousSession = createServerFn({ method: "GET" })
  .validator(serverInput(lookupMeetingSchema))
  .middleware([preAuthRateLimitedRequestMiddleware("meeting:lookup-preauth")])
  .handler(async ({ data, context }) => {
    return getPreviousSessionForRequest(data.code, context);
  });
