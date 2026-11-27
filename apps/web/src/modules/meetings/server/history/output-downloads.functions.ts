import { createServerFn } from "@tanstack/react-start";
import * as v from "valibot";
import { idSchema } from "@orbmeet/public-api-contract/fields";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { serverInput } from "@/lib/validation";
import { getMeetingArtifactDownloadUrlSchema } from "@/modules/spaces/contract/schemas";
import {
  getMeetingArtifactDownloadUrlImpl,
  getRecordingPlaybackUrlImpl,
  getWhiteboardPdfDownloadUrlImpl,
} from "./output-downloads.server";

const getRecordingPlaybackUrlValidator = v.object({ artifactId: idSchema });
const getWhiteboardPdfDownloadUrlValidator = v.object({
  meetingId: idSchema,
  whiteboardId: v.optional(idSchema),
});

export const getMeetingArtifactDownloadUrl = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(getMeetingArtifactDownloadUrlSchema))
  .handler(async ({ data, context }) => {
    return getMeetingArtifactDownloadUrlImpl({ data, context });
  });

export const getRecordingPlaybackUrl = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(getRecordingPlaybackUrlValidator))
  .handler(async ({ data, context }) => {
    return getRecordingPlaybackUrlImpl({ data, context });
  });

export const getWhiteboardPdfDownloadUrl = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(getWhiteboardPdfDownloadUrlValidator))
  .handler(async ({ data, context }) => {
    return getWhiteboardPdfDownloadUrlImpl({ data, context });
  });

export type GetRecordingPlaybackUrlInput = v.InferOutput<typeof getRecordingPlaybackUrlValidator>;
export type GetWhiteboardPdfDownloadUrlInput = v.InferOutput<typeof getWhiteboardPdfDownloadUrlValidator>;
