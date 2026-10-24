import "@tanstack/react-start/server-only";
import { toWhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { isWhiteboardConfigured } from "../config.server";
import { runSyncCommand } from "../sync-commands.server";

/**
 * Tell a board's sync room that who may do what in it changed in D1, so it
 * re-reads authority now rather than at its next sweep. With
 * `narrowedPrincipalKey`, that principal's writes stop until the fresh
 * verdict lands: their authority was just narrowed. Nothing to tell without a
 * sync server.
 */
export async function refreshBoardAuthority(
  env: Env,
  syncRoomId: string,
  narrowedPrincipalKey?: string,
): Promise<void> {
  if (!isWhiteboardConfigured(env)) return;
  await runSyncCommand(env, "refreshAuthority", {
    whiteboardRoomId: toWhiteboardRoomId(syncRoomId),
    ...(narrowedPrincipalKey === undefined ? {} : { principalKey: narrowedPrincipalKey }),
  });
}
