import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import * as v from "valibot";
import { idSchema } from "@orbmeet/public-api-contract/fields";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { saveMeetingWhiteboardCopyImpl, getWhiteboardSnapshotImpl, getMeetingWhiteboardSnapshotsImpl, getMeetingWhiteboardHistoryImpl, getWhiteboardPdfDownloadUrlImpl } from "./export.server";

const historyRequestSchema = v.object({
  meetingId: idSchema,
  whiteboardId: v.optional(idSchema),
});

const saveMeetingCopySchema = v.object({
  meetingId: idSchema,
  whiteboardId: idSchema,
});

const getMeetingWhiteboardSnapshotsValidator = v.pick(historyRequestSchema, ["meetingId"]);

export const saveMeetingWhiteboardCopy = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(saveMeetingCopySchema))
  .handler(async ({ data, context }) => {
    return saveMeetingWhiteboardCopyImpl({ data, context });
  });

export const getWhiteboardSnapshot = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(historyRequestSchema))
  .handler(async ({ data, context }) => {
    return getWhiteboardSnapshotImpl({ data, context });
  });

export const getMeetingWhiteboardSnapshots = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(getMeetingWhiteboardSnapshotsValidator))
  .handler(async ({ data, context }) => {
    return getMeetingWhiteboardSnapshotsImpl({ data, context });
  });

export const getMeetingWhiteboardHistory = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(historyRequestSchema))
  .handler(async ({ data, context }) => {
    return getMeetingWhiteboardHistoryImpl({ data, context });
  });

export const getWhiteboardPdfDownloadUrl = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(historyRequestSchema))
  .handler(async ({ data, context }) => {
    return getWhiteboardPdfDownloadUrlImpl({ data, context });
  });

export type HistoryRequestInput = v.InferOutput<typeof historyRequestSchema>;
export type SaveMeetingCopyInput = v.InferOutput<typeof saveMeetingCopySchema>;
export type GetMeetingWhiteboardSnapshotsInput = v.InferOutput<typeof getMeetingWhiteboardSnapshotsValidator>;
