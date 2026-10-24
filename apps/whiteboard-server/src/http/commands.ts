// The Worker's command endpoint: `POST /commands/<name>`, signed with the
// command keyring. Each request is read by the contract's own schema
// (`SYNC_COMMAND_REQUESTS` in @orbmeet/whiteboard-core) and handed to the room
// as a typed call; the room answers with a typed result, which this file alone
// maps onto HTTP.

import type { WhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import {
  parseSyncCommandRequest,
  SYNC_COMMAND_FAILURES,
  syncCommandFailure,
  type SyncCommandFailure,
  type SyncCommandName,
  type SyncCommandRequest,
  type SyncCommandResult,
} from "@orbmeet/whiteboard-core/sync-commands";
import type { RoomManager } from "../rooms/room-manager.ts";
import type { Room } from "../rooms/room.ts";
import type { DocumentCommandOptions } from "../rooms/room-document.ts";
import { Reply } from "./reply.ts";

type AnyResult = SyncCommandResult<SyncCommandName>;

export function syncCommandReply(result: AnyResult | SyncCommandFailure): Reply {
  return Reply.json(result, result.ok ? 200 : SYNC_COMMAND_FAILURES[result.reason]);
}

const isFailure = (value: unknown): value is SyncCommandFailure =>
  typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;

function documentOptions(request: { startBefore?: number }): DocumentCommandOptions {
  return request.startBefore === undefined ? {} : { startBefore: request.startBefore };
}

/** Live commands act on a resident room only; a cold room has no live state to change. */
function withResidentRoom(
  roomManager: RoomManager,
  roomId: WhiteboardRoomId,
  operation: (room: Room) => AnyResult | Promise<AnyResult>,
): AnyResult | Promise<AnyResult> {
  const room = roomManager.getRoomIfExists(roomId);
  // These commands act on live sessions, and a room nobody has connected to
  // since the server started has none yet: a retry once the sockets are back
  // succeeds. The board itself may well exist, so this is not "not found".
  if (!room) return syncCommandFailure("unavailable", "Nobody is connected to this whiteboard yet");
  return operation(room);
}

/** Commands that never prepare a room: snapshot copies touch none, and handoff and purge act on whatever is here. */
const UNPREPARED: ReadonlySet<SyncCommandName> = new Set(["copySnapshot", "readSnapshot", "handoff", "purge"]);

export async function dispatchSyncCommand<C extends SyncCommandName>(
  name: C,
  body: unknown,
  roomManager: RoomManager,
): Promise<AnyResult> {
  const request = parseSyncCommandRequest(name, body);
  if (isFailure(request)) return request;
  if ("generation" in request && request.generation !== undefined && !UNPREPARED.has(name)) {
    const failure = await roomManager.prepare(request.whiteboardRoomId, request.generation);
    if (failure) return failure;
  }
  return run({ name, request } as Command, roomManager);
}

/** A command and its request, as one union a `switch` narrows together. */
type Command = { [C in SyncCommandName]: { name: C; request: SyncCommandRequest<C> } }[SyncCommandName];

function run(command: Command, roomManager: RoomManager): AnyResult | Promise<AnyResult> {
  switch (command.name) {
    case "open":
    case "archive":
    case "reopen": {
      const { name, request } = command;
      return roomManager.withRoom(request.whiteboardRoomId, request.whiteboardId, (room): Promise<AnyResult> => {
        const options = documentOptions(request);
        return name === "open"
          ? room.document.open(request.commandId, request.whiteboardId, options)
          : name === "archive"
            ? room.document.archive(request.commandId, request.whiteboardId, options)
            : room.document.reopen(request.commandId, request.whiteboardId, options);
      });
    }
    case "capture": {
      const { request } = command;
      return roomManager.withRoom(request.whiteboardRoomId, request.whiteboardId, (room) =>
        room.document.capture(request.commandId, request.whiteboardId, request.toKey, documentOptions(request)),
      );
    }
    case "restore": {
      const { request } = command;
      return roomManager.withRoom(request.whiteboardRoomId, request.whiteboardId, (room) =>
        room.document.restore(
          request.commandId,
          request.whiteboardId,
          request.sourceKey,
          request.restorePointKey,
          documentOptions(request),
        ),
      );
    }
    case "seed": {
      const { request } = command;
      return roomManager.seed(request.whiteboardRoomId, request.whiteboardId, request.commandId, request.source);
    }
    case "handoff": {
      const { request } = command;
      return roomManager.handoff(request.whiteboardRoomId, request.whiteboardId, request.generation, {
        ifIdle: request.ifIdle === true,
      });
    }
    case "purge":
      return roomManager.purge(command.request.whiteboardRoomId, command.request.whiteboardId);
    case "copySnapshot":
      return roomManager.copySnapshot(command.request.sourceKey, command.request.destinationKey);
    case "readSnapshot":
      return roomManager.readSnapshot(command.request.key);
    case "refreshAuthority": {
      const room = roomManager.getRoomIfExists(command.request.whiteboardRoomId);
      if (!room) return { ok: true, status: "not_resident" };
      return room.authority.refresh(command.request.principalKey);
    }
    case "editRequest": {
      const { request } = command;
      return withResidentRoom(roomManager, request.whiteboardRoomId, (room) =>
        room.editRequest(request.principalKey, request.userId, request.userName));
    }
    case "editResolve": {
      const { request } = command;
      return withResidentRoom(roomManager, request.whiteboardRoomId, (room) =>
        room.editResolve(request.targetPrincipalKey, request.approverId, request.outcome));
    }
    case "pageEditValidate": {
      const { request } = command;
      return withResidentRoom(roomManager, request.whiteboardRoomId, (room) =>
        room.validateEditedPageFromClient(request.userId, request.connectionId, request.pageId));
    }
    case "pagePresentValidate": {
      const { request } = command;
      return withResidentRoom(roomManager, request.whiteboardRoomId, (room) =>
        room.validatePresentedPageFromClient(request.userId, request.connectionId, request.pageId));
    }
    // Both need a live caller in the room, so a room that is not loaded can
    // only refuse them; loading it from storage first would be wasted work.
    case "pageAdd": {
      const { request } = command;
      return withResidentRoom(roomManager, request.whiteboardRoomId, (room) =>
        room.addPage(request.userId, request.afterPageNumber));
    }
    case "navigationControllerSet": {
      const { request } = command;
      return withResidentRoom(roomManager, request.whiteboardRoomId, (room) =>
        room.navigation.setController(request.targetUserId, request.approverId));
    }
    case "navigationControllerRelease": {
      const { request } = command;
      return withResidentRoom(roomManager, request.whiteboardRoomId, (room) =>
        room.navigation.releaseController(request.requesterId));
    }
  }
}
