import "@tanstack/react-start/server-only";
import { createDb } from "@orbmeet/db";
import {
  syncCommandFailure,
  type SyncCommandName,
  type SyncCommandRequest,
  type SyncCommandResult,
  type SyncCommandSuccess,
} from "@orbmeet/whiteboard-core/sync-commands";
import { syncRoomIdFromWhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { AppError, Errors } from "@/lib/app-errors";
import { generateId } from "@/lib/ids";
import { logError } from "@/lib/logger";
import { liveWhiteboardNodes, nodeForNewBoard, placeBoard, type BoardPlacement } from "./board-placement.server";
import { isWhiteboardConfigured, type WhiteboardNode } from "./config.server";
import { postSyncCommand } from "./sync-command-transport.server";

/**
 * The Worker's command channel to the whiteboard sync servers.
 *
 * Each board lives on one node (`board-placement.server.ts`), which owns its
 * room database and writes every stored snapshot of it; the Worker owns
 * authority (D1) and asks that node to act. Each call is one signed POST
 * answered with a typed result; see `@orbmeet/whiteboard-core/sync-commands`.
 */

/** A fresh idempotency key for one document command (and its retries). */
export function newCommandId(): string {
  return generateId("SYNC_COMMAND");
}

/** Where a command goes: the node holding its board, at the board's generation, or any node for one touching no board. */
export type SyncCommandTarget = { node: WhiteboardNode; generation?: number } | BoardPlacement;

async function commandTarget(env: Env, request: object): Promise<SyncCommandTarget> {
  const db = createDb(env.DB);
  const roomId = (request as { whiteboardRoomId?: unknown }).whiteboardRoomId;
  if (typeof roomId === "string") {
    const syncRoomId = syncRoomIdFromWhiteboardRoomId(roomId);
    const placement = syncRoomId ? await placeBoard(db, env, syncRoomId, { kind: "service" }) : null;
    if (placement) return placement;
  }
  // A command for no board (a snapshot copy, say) runs on any node that answers.
  return { node: await nodeForNewBoard(db, env, {}, crypto.randomUUID()) };
}

export async function sendSyncCommand<C extends SyncCommandName>(
  env: Env,
  name: C,
  request: SyncCommandRequest<C>,
  options: { timeoutMs?: number; target?: SyncCommandTarget } = {},
): Promise<SyncCommandResult<C>> {
  if (!isWhiteboardConfigured(env)) throw Errors.CONFIG_ERROR("Whiteboard not configured");
  if (name === "purge" && !options.target) {
    // A deleted board's row is gone, and with it where the board was: every
    // node deletes whatever it holds of it.
    const nodes = await liveWhiteboardNodes(createDb(env.DB), env);
    const results = await Promise.all(nodes.map((node) => postSyncCommand(node, name, request, options.timeoutMs)));
    return results.find((result) => !result.ok)
      ?? results[0]
      ?? syncCommandFailure("unavailable", "Whiteboard service unavailable");
  }
  const target = options.target ?? await commandTarget(env, request);
  const body = target.generation === undefined ? request : { ...request, generation: target.generation };
  return postSyncCommand(target.node, name, body, options.timeoutMs);
}

/** The success payload, or the failure as the matching application error. */
export function expectSyncCommand<C extends SyncCommandName>(
  result: SyncCommandResult<C>,
): SyncCommandSuccess<C> {
  if (result.ok) return result;
  switch (result.reason) {
    case "unavailable":
      throw new AppError("WHITEBOARD_UNAVAILABLE", "Whiteboard service unavailable", 503);
    case "incompatible":
      // A deploy left this Worker and the node speaking versions the other
      // cannot read: an outage until the other side ships, not a bad request.
      logError("[whiteboard] node refused the Worker's sync protocol:", result.message);
      throw new AppError("WHITEBOARD_UNAVAILABLE", "Whiteboard service unavailable", 503);
    case "forbidden":
      throw Errors.FORBIDDEN(result.message);
    case "not_found":
      throw Errors.NOT_FOUND("Whiteboard");
    case "rate_limited":
      throw Errors.RATE_LIMITED();
    case "invalid":
      throw Errors.VALIDATION(result.message);
    case "too_large":
      throw new AppError("WHITEBOARD_TOO_LARGE", result.message, 413, result.details);
    case "archived":
    case "busy":
    case "conflict":
    case "expired":
      throw new AppError("CONFLICT", result.message, 409, result.details);
  }
}

export async function runSyncCommand<C extends SyncCommandName>(
  env: Env,
  name: C,
  request: SyncCommandRequest<C>,
  options: { target?: SyncCommandTarget } = {},
): Promise<SyncCommandSuccess<C>> {
  return expectSyncCommand(await sendSyncCommand(env, name, request, options));
}

/**
 * A stored whiteboard snapshot's contents, or null when nothing is stored at
 * `key`. The sync server owns these bytes; the Worker never reads them from R2.
 */
export async function readStoredSnapshot<T = unknown>(env: Env, key: string): Promise<T | null> {
  const result = await sendSyncCommand(env, "readSnapshot", { key });
  if (!result.ok && result.reason === "not_found") return null;
  return expectSyncCommand(result).snapshot as T;
}
