import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import { cancelMeetingScheduleSchema, rescheduleMeetingSchema } from "@orbmeet/public-api-contract";
import { createMeetingScheduleFromAppSchema } from "@/modules/scheduling/contract/schemas";

import { rateLimited } from "@/app/bootstrap/middleware";
import { createMeetingScheduleForUser } from "./creation";
import { kickNotificationDelivery } from "./notifications.server";
import { rescheduleMeetingScheduleRecord, cancelMeetingScheduleRecord } from "./commands";

export const createMeetingSchedule = createServerFn({ method: "POST" })
  .middleware([rateLimited(({ user }) => `meeting-schedule:create:${user.id}`)])
  .validator(serverInput(createMeetingScheduleFromAppSchema))
  .handler(async ({ data, context: { user, env, db, executionCtx } }) => {
    const result = await createMeetingScheduleForUser(db, user, data);
    kickNotificationDelivery(env, executionCtx);
    return result;
  });

export const rescheduleMeeting = createServerFn({ method: "POST" })
  .middleware([rateLimited(({ user }) => `meeting-schedule:reschedule:${user.id}`)])
  .validator(serverInput(rescheduleMeetingSchema))
  .handler(async ({ data, context: { user, env, db, executionCtx } }) => {
    const result = await rescheduleMeetingScheduleRecord(db, user.id, data);
    kickNotificationDelivery(env, executionCtx);
    return result;
  });

export const cancelMeetingSchedule = createServerFn({ method: "POST" })
  .middleware([rateLimited(({ user }) => `meeting-schedule:cancel:${user.id}`)])
  .validator(serverInput(cancelMeetingScheduleSchema))
  .handler(async ({ data, context: { user, env, db, executionCtx } }) => {
    const result = await cancelMeetingScheduleRecord(db, user.id, data);
    kickNotificationDelivery(env, executionCtx);
    return result;
  });
