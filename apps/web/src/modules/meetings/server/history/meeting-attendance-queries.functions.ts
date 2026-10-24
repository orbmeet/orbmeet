import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import * as v from "valibot";
import { idSchema } from "@orbmeet/public-api-contract/fields";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { getMeetingAttendanceImpl } from "./meeting-attendance-queries.server";

const meetingAttendanceSchema = v.object({
  meetingId: idSchema,
  cursor: v.optional(v.string()),
});

export const getMeetingAttendance = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(meetingAttendanceSchema))
  .handler(async ({ data, context }) => {
    return getMeetingAttendanceImpl({ data, context });
  });

export type MeetingAttendanceInput = v.InferOutput<typeof meetingAttendanceSchema>;
