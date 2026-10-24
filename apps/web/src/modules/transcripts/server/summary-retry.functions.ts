import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import * as v from "valibot";
import { idSchema } from "@orbmeet/public-api-contract/fields";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { retryMeetingSummaryImpl } from "./summary-retry.server";

const retryMeetingSummaryValidator = v.object({ meetingId: idSchema });

/** Owe a new Summary for an ended Meeting whose last summary job gave up. */
export const retryMeetingSummary = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(retryMeetingSummaryValidator))
  .handler(async ({ data, context }) => {
    await retryMeetingSummaryImpl({ data, context });
  });

export type RetryMeetingSummaryInput = v.InferOutput<typeof retryMeetingSummaryValidator>;
