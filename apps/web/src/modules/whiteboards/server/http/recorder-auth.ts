import { createDb } from "@orbmeet/db";
import {
  RequestBodyTooLargeError,
  parseJsonObjectBody,
  readRequestBodyText,
} from "@/platform/http/request-body";
import { createWhiteboardJWT } from "@orbmeet/whiteboard-core/whiteboard-jwt";
import { toWhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { verifyRecorderBootstrapToken } from "@/modules/whiteboards/server/recorder-bootstrap-token";
import { canAccessWhiteboardAsRecorder } from "@/modules/whiteboards/server/meeting/access";
import { createWhiteboardAssetCookieString } from "@/modules/whiteboards/server/cookies";
import { findMeetingWhiteboardDocument } from "@/modules/whiteboards/server/documents";
import { placeBoard } from "@/modules/whiteboards/server/board-placement.server";
import { isWhiteboardConfigured } from "@/modules/whiteboards/server/config.server";

const MAX_RECORDER_AUTH_BODY_BYTES = 4096;
const RECORDER_WHITEBOARD_TOKEN_TTL_SECONDS = 60 * 60;

export async function handleRecorderAuth(request: Request, env: Env): Promise<Response> {
  if (!isWhiteboardConfigured(env)) {
    return new Response("Whiteboard recorder auth is not configured", { status: 503 });
  }

  let bodyText: string;
  try {
    bodyText = await readRequestBodyText(request, MAX_RECORDER_AUTH_BODY_BYTES);
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return new Response("Payload too large", { status: 413 });
    }
    throw err;
  }

  const body = parseJsonObjectBody(bodyText) as
    | { recorderToken?: unknown; bootstrapToken?: unknown }
    | null;
  if (!body) {
    return new Response("Invalid JSON", { status: 400 });
  }

  const credential = typeof body.recorderToken === "string"
    ? body.recorderToken.trim()
    : typeof body.bootstrapToken === "string"
      ? body.bootstrapToken.trim()
      : "";
  if (!credential) {
    return new Response("Missing recorder token", { status: 400 });
  }

  let meetingId: string;
  try {
    ({ meetingId } = await verifyRecorderBootstrapToken(credential, env));
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const db = createDb(env.DB);
  // The credential grants nothing on its own: the Meeting must be recording
  // or streaming right now.
  if (!(await canAccessWhiteboardAsRecorder(db, meetingId))) {
    return new Response("Forbidden", { status: 403 });
  }
  // Access to the board the Meeting presents now. The recorder asks again
  // when its room state says the Meeting switched boards.
  const document = await findMeetingWhiteboardDocument(db, meetingId);
  if (!document || document.status !== "active") {
    return new Response("No whiteboard is presented", { status: 404 });
  }
  const whiteboardRoomId = toWhiteboardRoomId(document.syncRoomId);
  const whiteboardId = document.whiteboardId;
  const syncRoomId = document.syncRoomId;
  // Wherever the board is: the recorder follows the Meeting, it never moves it.
  const placement = await placeBoard(db, env, syncRoomId, { kind: "service" });
  if (!placement) {
    return new Response("No whiteboard is presented", { status: 404 });
  }

  const token = await createWhiteboardJWT(
    placement.node.jwtKeyring,
    {
      sub: "recorder",
      name: "Recorder",
      role: "guest",
      capabilities: { canEditWhiteboard: false, canControlSurface: false, canManageWhiteboard: false },
      sid: whiteboardRoomId,
      connectionId: "recorder",
      grantPrincipal: { type: "guest_admission", id: "recorder" },
      service: "recorder",
      documentId: whiteboardId,
      generation: placement.generation,
    },
    RECORDER_WHITEBOARD_TOKEN_TTL_SECONDS,
  );

  const response = Response.json({
    token,
    whiteboardUrl: placement.node.whiteboardUrl,
    documentId: whiteboardId,
    expiresIn: RECORDER_WHITEBOARD_TOKEN_TTL_SECONDS,
  });
  for (const scopeId of new Set([meetingId, syncRoomId, whiteboardId])) {
    response.headers.append(
      "Set-Cookie",
      createWhiteboardAssetCookieString(
        scopeId,
        token,
        RECORDER_WHITEBOARD_TOKEN_TTL_SECONDS,
        { appUrl: env.APP_URL, environment: env.ENVIRONMENT },
      ),
    );
  }
  return response;
}
