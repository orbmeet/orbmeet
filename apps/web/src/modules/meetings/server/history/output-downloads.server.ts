import "@tanstack/react-start/server-only";
import type * as v from "valibot";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { Errors } from "@/lib/app-errors";
import { signDownloadUrl, signPlaybackUrl } from "@/modules/assets/server/signed-urls.server";
import type { getMeetingArtifactDownloadUrlSchema } from "@/modules/spaces/contract/schemas";
import { enforceRateLimit } from "@/platform/http/rate-limit.server";
import { assertMeetingHistoryAccess } from "../access/resource-access";
import type { GetRecordingPlaybackUrlInput } from "./output-downloads.functions";

export async function getMeetingArtifactDownloadUrlImpl({
  data,
  context: { user, env, db },
}: {
  data: v.InferOutput<typeof getMeetingArtifactDownloadUrlSchema>;
  context: AuthFnContext;
}) {
  await enforceRateLimit(env, `meeting-artifact:download:${user.id}`);
  const artifact = await db.query.meetingArtifacts.findFirst({
    where: { id: data.artifactId },
  });
  if (!artifact) {
    throw Errors.NOT_FOUND("Meeting output");
  }
  await assertMeetingHistoryAccess(db, artifact.meetingId, user.id);
  return signDownloadUrl(env, artifact);
}

/**
 * Mints an inline (streamable) signed R2 URL for a recording so it can play in
 * a <video> element. Unlike getMeetingArtifactDownloadUrl, it omits response-content-disposition
 * so the browser streams rather than downloads. Access uses the same
 * Meeting-history policy as the Summary, Transcript, and other Meeting outputs.
 */
export async function getRecordingPlaybackUrlImpl({
  data,
  context: { user, env, db },
}: {
  data: GetRecordingPlaybackUrlInput;
  context: AuthFnContext;
}) {
  await enforceRateLimit(env, `asset:url:${user.id}`);

  const artifact = await db.query.meetingArtifacts.findFirst({
    where: { id: data.artifactId },
  });
  if (!artifact) throw Errors.NOT_FOUND("Recording");
  if (artifact.type !== "recording") throw Errors.NOT_FOUND("Recording");

  await assertMeetingHistoryAccess(db, artifact.meetingId, user.id);

  return signPlaybackUrl(env, artifact.r2Key);
}
