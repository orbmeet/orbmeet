import type { ParticipantInfo } from "livekit-server-sdk";
import { participantRemovalOptions } from "@/modules/meetings/contract/livekit-helpers";
import { logError } from "@/lib/logger";


type ParticipantRemovalRoomService = {
  updateParticipant(
    room: string,
    identity: string,
    options: {
      permission: {
        canPublish: boolean;
        canSubscribe: boolean;
        canPublishData: boolean;
        canUpdateMetadata: boolean;
      };
    },
  ): Promise<ParticipantInfo>;
  removeParticipant(
    room: string,
    identity: string,
    options?: ReturnType<typeof participantRemovalOptions>,
  ): Promise<void>;
};

export function isLiveKitMissingError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    const message = String(err).toLowerCase();
    return message.includes("not found") || message.includes("does not exist");
  }
  const errorLike = err as { status?: unknown; code?: unknown; message?: unknown };
  if (errorLike.status === 404) return true;
  if (typeof errorLike.code === "string" && errorLike.code.toLowerCase() === "not_found") return true;
  const message = typeof errorLike.message === "string" ? errorLike.message.toLowerCase() : "";
  return message.includes("not found") || message.includes("does not exist");
}

/**
 * Self-hosted LiveKit cannot revoke already-issued reconnect tokens immediately.
 * Zero permissions before kicking so a participant who reconnects on a cached
 * LiveKit refresh token cannot publish, subscribe, or send data while the app's
 * durable D1/webhook backstops remove them again.
 */
export async function zeroPermissionsAndRemoveParticipant(
  roomService: ParticipantRemovalRoomService,
  roomName: string,
  identity: string,
  logPrefix: string,
): Promise<void> {
  let permissionError: unknown = null;
  try {
    await roomService.updateParticipant(roomName, identity, {
        permission: {
          canPublish: false,
          canSubscribe: false,
          canPublishData: false,
          canUpdateMetadata: false,
        },
      });
  } catch (err) {
    if (isLiveKitMissingError(err)) return;
    logError(`${logPrefix} Failed to zero LiveKit permissions before removal:`, err);
    permissionError = err;
  }

  try {
    await roomService.removeParticipant(roomName, identity, participantRemovalOptions());
  } catch (err) {
    if (isLiveKitMissingError(err)) return;
    throw err;
  }

  // Removal can succeed while permission revocation transiently fails. Report
  // that partial result so webhook/durable callers retry the revocation if the
  // participant reconnects with a still-valid LiveKit token.
  if (permissionError) throw permissionError;
}
