import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import * as v from "valibot";
import { idSchema, integerSchema } from "@orbmeet/public-api-contract/fields";
import { Errors } from "@/lib/app-errors";
import { createWhiteboardJWT } from "@orbmeet/whiteboard-core/whiteboard-jwt";
import { toWhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { authMiddleware } from "@/app/bootstrap/middleware";
import {
  canUserEditWhiteboardDocument,
} from "@/modules/whiteboards/server/documents";
import { isWhiteboardConfigured } from "@/modules/whiteboards/server/config.server";
import { newCommandId, runSyncCommand } from "@/modules/whiteboards/server/sync-commands.server";
import { placeBoard } from "@/modules/whiteboards/server/board-placement.server";
import { currentNodeLatencies } from "@/platform/realtime/node-latency.server";

/**
 * Editing a Whiteboard with no Meeting anywhere in sight.
 *
 * This is clause 1 of whiteboard authorization on its own — durable Space
 * membership — which is what makes preparing a board before class possible.
 * The `solo` service marks the token as carrying no Meeting binding, so the
 * sync server's access check knows not to look for one.
 */
const STANDALONE_WHITEBOARD_CONNECTION_ID = "solo";
const STANDALONE_TOKEN_TTL_SECONDS = 60 * 60;

export const getStandaloneWhiteboardAccess = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(v.object({ whiteboardId: idSchema })))
  .handler(async ({ data, context: { user, db, env } }) => {
    if (!isWhiteboardConfigured(env)) {
      throw Errors.CONFLICT("The Whiteboard service is not configured");
    }
    if (!(await canUserEditWhiteboardDocument(db, data.whiteboardId, user.id))) {
      throw Errors.NOT_FOUND("Whiteboard");
    }
    const board = await db.query.whiteboards.findFirst({
      where: { id: data.whiteboardId, status: "active" },
      columns: { id: true, syncRoomId: true, title: true },
    });
    if (!board) throw Errors.NOT_FOUND("Whiteboard");

    // Near its editor, once no one is using it where it is.
    const placement = await placeBoard(db, env, board.syncRoomId, { kind: "editor", latencies: await currentNodeLatencies(env) });
    if (!placement) throw Errors.NOT_FOUND("Whiteboard");
    // This authenticated document-open boundary gives a new or legacy blank
    // board its first page before any token can expose it to the editor.
    await runSyncCommand(env, "open", {
      whiteboardRoomId: toWhiteboardRoomId(board.syncRoomId),
      whiteboardId: board.id,
      commandId: newCommandId(),
    }, { target: placement });
    const stillActive = await db.query.whiteboards.findFirst({
      where: { id: board.id, status: "active" },
      columns: { id: true },
    });
    if (!stillActive) throw Errors.NOT_FOUND("Whiteboard");

    const whiteboardRoomId = toWhiteboardRoomId(board.syncRoomId);
    const token = await createWhiteboardJWT(
      placement.node.jwtKeyring,
      {
        sub: user.id,
        name: user.name,
        role: "participant",
        capabilities: {
          canEditWhiteboard: true,
          // Surface control and whiteboard management are Meeting-room
          // concepts: there is no room to present to and nobody to manage.
          canControlSurface: false,
          canManageWhiteboard: false,
        },
        sid: whiteboardRoomId,
        connectionId: STANDALONE_WHITEBOARD_CONNECTION_ID,
        grantPrincipal: { type: "user", id: user.id },
        service: "solo",
        documentId: board.id,
        generation: placement.generation,
      },
      STANDALONE_TOKEN_TTL_SECONDS,
    );

    // Note: unlike the Meeting flows (service.server.ts, meeting-actions.server.ts), this
    // deliberately does NOT set the path-scoped asset-token cookies. A `solo`
    // token carries no Meeting connection, so `verifyWhiteboardAssetToken`
    // can never accept it — assets authorize through the session fallback —
    // and a freshly minted JWT cookie would rotate the `Cookie` header on
    // every access mint, busting the browser's `Vary: Cookie` cache partition
    // for every board asset on each visit.

    return {
      token,
      whiteboardUrl: placement.node.whiteboardUrl,
      documentId: board.id,
      documentTitle: board.title,
    };
  });

const addStandaloneWhiteboardPageSchema = v.object({
  whiteboardId: idSchema,
  afterPageNumber: v.optional(integerSchema(0)),
});

export const addStandaloneWhiteboardPage = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(addStandaloneWhiteboardPageSchema))
  .handler(async ({ data, context: { user, db, env } }) => {
    if (!(await canUserEditWhiteboardDocument(db, data.whiteboardId, user.id))) {
      throw Errors.NOT_FOUND("Whiteboard");
    }
    const board = await db.query.whiteboards.findFirst({
      where: { id: data.whiteboardId, status: "active" },
      columns: { syncRoomId: true },
    });
    if (!board) throw Errors.NOT_FOUND("Whiteboard");

    const { status, page } = await runSyncCommand(env, "pageAdd", {
      whiteboardRoomId: toWhiteboardRoomId(board.syncRoomId),
      userId: user.id,
      afterPageNumber: data.afterPageNumber,
    });
    return { success: true, status, page };
  });
