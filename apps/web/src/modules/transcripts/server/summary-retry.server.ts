import { Errors } from "@/lib/app-errors";
import { canAccessMeetingHistory } from "@/modules/meetings/server/access/resource-access";
import { enforceRateLimit } from "@/platform/http/rate-limit.server";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { requestMeetingSummary } from "./summary-jobs";
import type { RetryMeetingSummaryInput } from "./summary-retry.functions";

/**
 * Owe a new Summary when the last one failed. Generation itself only ever
 * runs in the meeting's summary job; this just starts another.
 */
export async function retryMeetingSummaryImpl({
  data,
  context: { user, db, env },
}: {
  data: RetryMeetingSummaryInput;
  context: AuthFnContext;
}): Promise<void> {
  await enforceRateLimit(env, `summary:retry:${user.id}:${data.meetingId}`);
  if (!(await canAccessMeetingHistory(db, data.meetingId, user.id))) throw Errors.FORBIDDEN();
  const meeting = await db.query.meetings.findFirst({
    where: { id: data.meetingId },
    columns: { summaryStatus: true },
  });
  if (meeting?.summaryStatus === "failed") await requestMeetingSummary(db, env, data.meetingId);
}
