import * as v from "valibot";
import { parseInput } from "@/lib/validation";
import { createFileRoute } from "@tanstack/react-router";
import {
  cancelMeetingScheduleSchema,
  publicScheduleCancelResponseSchema,
  publicScheduleResponseSchema,
  publicScheduleUpdateResponseSchema,
  rescheduleMeetingSchema,
} from "@orbmeet/public-api-contract";
import { Errors } from "@/lib/app-errors";

import {
  apiJson,
  handleAutomationApi,
  readAutomationJsonObject,
} from "@/app/adapters/public-api/http";
import {
  cancelMeetingScheduleRecord,
  rescheduleMeetingScheduleRecord,
} from "@/modules/scheduling/server/commands";
import { findMeetingScheduleForUser } from "@/modules/scheduling/server/queries.server";
import { getCloudflareCtx } from "@/platform/runtime/server-runtime.server";
import { kickNotificationDelivery } from "@/modules/scheduling/server/notifications.server";

export const Route = createFileRoute("/api/v1/schedules/$scheduleId")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        handleAutomationApi(request, "meetings:read", async ({ principal }) => {
          const includeCanceled =
            new URL(request.url).searchParams.get("includeCanceled") === "true";
          const schedule = await findMeetingScheduleForUser(
            principal.db,
            principal.user,
            params.scheduleId,
            { includeCanceled },
          );
          if (!schedule) throw Errors.NOT_FOUND("Scheduled meeting");
          return apiJson(v.parse(publicScheduleResponseSchema, { data: schedule }));
        }),
      PATCH: ({ request, params }) =>
        handleAutomationApi(request, "meetings:write", async ({ env, principal }) => {
          const parsed = parseInput(rescheduleMeetingSchema, {
            ...(await readAutomationJsonObject(request)),
            scheduleId: params.scheduleId,
          });
          const result = await rescheduleMeetingScheduleRecord(
            principal.db,
            principal.user.id,
            parsed,
          );
          kickNotificationDelivery(env, getCloudflareCtx());
          return apiJson(v.parse(publicScheduleUpdateResponseSchema, { data: result }));
        }),
      DELETE: ({ request, params }) =>
        handleAutomationApi(request, "meetings:write", async ({ env, principal }) => {
          const parsed = parseInput(cancelMeetingScheduleSchema, {
            ...(await readAutomationJsonObject(request)),
            scheduleId: params.scheduleId,
          });
          const result = await cancelMeetingScheduleRecord(
            principal.db,
            principal.user.id,
            parsed,
          );
          kickNotificationDelivery(env, getCloudflareCtx());
          return apiJson(v.parse(publicScheduleCancelResponseSchema, { data: result }));
        }),
    },
  },
});
