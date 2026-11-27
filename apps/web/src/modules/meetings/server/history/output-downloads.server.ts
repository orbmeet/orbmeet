import "@tanstack/react-start/server-only";
import { meetingLinks, meetings } from "@orbmeet/db/schema";
import { and, desc, eq } from "drizzle-orm";
import type * as v from "valibot";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { Errors } from "@/lib/app-errors";
import { buildAttachmentContentDisposition } from "@/modules/assets/server/content-disposition";
import { buildR2Client } from "@/modules/assets/server/r2-client.server";
import { signDownloadUrl, signPlaybackUrl } from "@/modules/assets/server/signed-urls.server";
import type { getMeetingArtifactDownloadUrlSchema } from "@/modules/spaces/contract/schemas";
import { enforceRateLimit } from "@/platform/http/rate-limit.server";
import { assertMeetingHistoryAccess } from "../access/resource-access";
import type {
  GetRecordingPlaybackUrlInput,
  GetWhiteboardPdfDownloadUrlInput,
} from "./output-downloads.functions";

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

export async function getWhiteboardPdfDownloadUrlImpl({
  data,
  context: { user, db, env },
}: {
  data: GetWhiteboardPdfDownloadUrlInput;
  context: AuthFnContext;
}) {
  await enforceRateLimit(env, `meeting-artifact:download:${user.id}`);
  await assertMeetingHistoryAccess(db, data.meetingId, user.id);

  const artifact = await db.query.meetingArtifacts.findFirst({
    where: {
      RAW: (row) => and(eq(row.meetingId, data.meetingId), eq(row.type, "whiteboard_pdf"))!,
    },
    columns: { r2Key: true },
    orderBy: (row) => [desc(row.createdAt), desc(row.id)],
  });
  const meeting = await db
    .select({ title: meetings.title, code: meetingLinks.code })
    .from(meetings)
    .innerJoin(meetingLinks, eq(meetings.meetingLinkId, meetingLinks.id))
    .where(eq(meetings.id, data.meetingId))
    .get();
  if (!artifact || !meeting) throw Errors.NOT_FOUND("Whiteboard PDF");
  if (!env.R2_BUCKET_NAME) throw Errors.CONFIG_ERROR("Storage not configured");

  const { r2, endpoint } = buildR2Client(env);
  const url = new URL(`/${env.R2_BUCKET_NAME}/${artifact.r2Key}`, endpoint);
  url.searchParams.set("X-Amz-Expires", "300");
  url.searchParams.set(
    "response-content-disposition",
    buildAttachmentContentDisposition(`whiteboard-${meeting.title ?? meeting.code}.pdf`),
  );
  const signed = await r2.sign(new Request(url.toString(), { method: "GET" }), {
    aws: { signQuery: true },
  });
  return { downloadUrl: signed.url };
}
