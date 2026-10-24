import "@tanstack/react-start/server-only";
import { and, eq } from "drizzle-orm";
import { normalizeSpeechLanguageTag } from "@orbmeet/caption-protocol";
import { Errors } from "@/lib/app-errors";
import type { RequestFnContext } from "@/app/bootstrap/middleware";
import { getGuestCookieSecret } from "@/modules/meetings/server/access/guest-cookie.server";
import { enforceRateLimit } from "@/platform/http/rate-limit.server";
import { getOwnedActiveMeetingConnection } from "@/modules/meetings/server/room/connection-access";
import { createRoomServiceClient } from "@/platform/realtime/livekit-clients.server";
import {
  findMeetingMediaRoom,
  type MeetingMediaRoom,
} from "@/modules/meetings/server/room/media-placement.server";
import { connectionIsUnfinished } from "@/modules/meetings/server/connection/state";

export async function updateCaptionLanguageForRequest(
  data: { meetingId: string; connectionId: string; language: string },
  { env, db, user, clientIP }: RequestFnContext,
) {
  const language = normalizeSpeechLanguageTag(data.language);
  if (!language) throw Errors.VALIDATION("Unsupported caption language");

  const userId = user?.id ?? null;
  await enforceRateLimit(
    env,
    userId ? `caption-language:user:${userId}` : `caption-language:ip:${clientIP}`,
  );

  const connection = await db.query.meetingConnections.findFirst({
    where: {
      RAW: (row) =>
        and(
          eq(row.id, data.connectionId),
          eq(row.meetingId, data.meetingId),
          connectionIsUnfinished(row.connectionStatus),
        )!,
    },
    columns: { admissionId: true },
  });
  const ownedConnection = await getOwnedActiveMeetingConnection(db, {
    meetingId: data.meetingId,
    connectionId: data.connectionId,
    authenticatedUserId: userId,
    guestCookieSecret: connection?.admissionId
      ? getGuestCookieSecret(connection.admissionId)
      : null,
  });

  // A connection that holds a seat implies a placed Meeting.
  const room = await findMeetingMediaRoom(db, env, data.meetingId);
  if (!room) throw Errors.NOT_FOUND("Meeting");
  await updateParticipantCaptionLanguage(room, ownedConnection.livekitIdentity, language);
  return { language };
}

async function updateParticipantCaptionLanguage(
  room: MeetingMediaRoom,
  participantIdentity: string,
  language: string,
): Promise<void> {
  const roomService = createRoomServiceClient(room.node);
  await roomService.updateParticipant(room.roomName, participantIdentity, {
    attributes: { "orbmeet.caption_language": language },
  });
}
