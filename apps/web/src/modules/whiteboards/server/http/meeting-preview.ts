import { createDb } from "@orbmeet/db";
import { verifySessionFromRawRequest } from "@/modules/identity/server/session";
import { canManagePastMeeting } from "@/modules/meetings/server/access/access-assertions";
import { canAccessMeetingHistory } from "@/modules/meetings/server/access/resource-access";
import { MEETING_PREVIEW_PATH, sniffPreviewImageType } from "@/modules/whiteboards/contract/meeting-preview";
import { RequestBodyTooLargeError, readRequestBodyBytes } from "@/platform/http/request-body";
import { enforceWhiteboardAssetRateLimit } from "@/platform/http/rate-limit.server";
import { meetingPreviewKey } from "@/platform/storage/r2-keys";
import { hasBody } from "./wb-assets";

const MAX_PREVIEW_BYTES = 512 * 1024;
const PREVIEW_CACHE_CONTROL = "private, max-age=3600, must-revalidate";
const MEETING_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * A small picture of a meeting's board, for the lists of meetings. Lives under
 * the meeting's own prefix, so it goes when the meeting does, and has no row:
 * a list asks for it and shows its placeholder if there is none.
 *
 * Anyone who can open the meeting can read it. Only someone who can manage the
 * meeting can publish it, and only once the meeting is over: the recap page
 * draws it from the captured board.
 */
export async function handleMeetingPreview(request: Request, env: Env, pathname: string): Promise<Response> {
  await enforceWhiteboardAssetRateLimit(env, request);

  const session = await verifySessionFromRawRequest(request, env);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const meetingId = pathname.slice(MEETING_PREVIEW_PATH.length);
  if (!MEETING_ID_RE.test(meetingId)) return new Response("Invalid meetingId", { status: 400 });

  const db = createDb(env.DB);
  const key = meetingPreviewKey(meetingId);

  if (request.method === "GET") {
    if (!(await canAccessMeetingHistory(db, meetingId, session.userId))) {
      return new Response("Forbidden", { status: 403 });
    }
    // A revalidation asks whether the browser's copy is current; R2 answers
    // that without the body when given the one strong ETag a browser sends.
    const ifNoneMatch = request.headers.get("If-None-Match")?.trim() ?? "";
    const etag = /^"[^"\r\n]*"$/.test(ifNoneMatch) ? ifNoneMatch.slice(1, -1) : null;
    const object = etag === null
      ? await env.R2_BUCKET.get(key)
      : await env.R2_BUCKET.get(key, { onlyIf: { etagDoesNotMatch: etag } });
    // Briefly cached: most boards have one soon after their recap is opened.
    if (!object) return new Response(null, { status: 404, headers: { "Cache-Control": "private, max-age=30" } });
    const headers = {
      // Kept no longer than access is checked: past the hour the browser
      // asks again, and the check above runs, so someone removed from the
      // Space stops seeing the board within the hour (as with board assets).
      "Cache-Control": PREVIEW_CACHE_CONTROL,
      ETag: object.httpEtag,
      Vary: "Cookie",
    };
    // No body: the ETag matched, and the browser's copy is current.
    if (!hasBody(object)) return new Response(null, { status: 304, headers });
    return new Response(object.body, {
      headers: {
        ...headers,
        "Content-Type": object.httpMetadata?.contentType ?? "image/webp",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  const meeting = await db.query.meetings.findFirst({ where: { id: meetingId } });
  if (!meeting) return new Response("Meeting not found", { status: 404 });
  if (!(await canManagePastMeeting(db, meeting, session.userId))) {
    return new Response("Forbidden", { status: 403 });
  }
  if (meeting.status !== "ended") return new Response("Meeting has not ended", { status: 409 });

  let bytes: Uint8Array;
  try {
    bytes = await readRequestBodyBytes(request, MAX_PREVIEW_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return new Response("Payload too large", { status: 413 });
    throw error;
  }
  const contentType = sniffPreviewImageType(bytes);
  if (!contentType) return new Response("Not a preview image", { status: 415 });

  await env.R2_BUCKET.put(key, bytes, { httpMetadata: { contentType } });
  return new Response(null, { status: 204 });
}
