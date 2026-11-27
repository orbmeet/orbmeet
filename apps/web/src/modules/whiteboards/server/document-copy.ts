import type { Database } from "@orbmeet/db";
import { whiteboardAssetReferences } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import type { NodeLatencies } from "@orbmeet/nodes";
import { mapWithConcurrency } from "@orbmeet/primitives";
import type { SyncCommandRequest } from "@orbmeet/whiteboard-core/sync-commands";
import { extractWhiteboardDocumentAssetIdentity } from "@orbmeet/whiteboard-core/whiteboard-asset-key";
import { toWhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { runSerially } from "@/app/serial/serial";
import { Errors } from "@/lib/app-errors";
import { generateId } from "@/lib/ids";
import { nodeForNewBoard, placeBoard } from "./board-placement.server";
import type { WhiteboardNode } from "./config.server";
import {
  attachExistingWhiteboardToMeeting,
  cleanupFailedWhiteboardCopy,
  insertDurableWhiteboard,
  type MeetingWhiteboardDocument,
} from "./documents";
import {
  filterAuthorizedWhiteboardAssetKeys,
  insertAssetReferencesForBoard,
} from "./revision-assets";
import { newCommandId, runSyncCommand } from "./sync-commands.server";

/**
 * Duplicates a Whiteboard inside its Space, or into another one. The copy is
 * an ordinary durable document — no Meeting is involved and nothing is
 * presented.
 *
 * The source is the board's current state (its room's latest, edits
 * included) or one of its revisions. The sync server seeds the new board's
 * room with it.
 */
export interface DuplicateWhiteboardInput {
  whiteboardId: string;
  userId: string;
  revisionId?: string;
  destinationSpaceId?: string;
  title?: string;
  /** Each node's latency for whoever asked for the copy: a copy of a revision is created on a node fast for them. */
  nodeLatencies?: NodeLatencies;
}

/**
 * The source state, its asset manifest, and reference publication are one
 * lifecycle operation, so a copy runs in the source board's serial scope,
 * where the board's purge runs too.
 */
export function duplicateWhiteboard(
  env: Pick<Env, "SERIAL_SCOPES">,
  input: DuplicateWhiteboardInput,
): Promise<{ whiteboardId: string; title: string }> {
  return runSerially(env, { kind: "duplicateWhiteboard", ...input }, { callerWaits: true });
}

/** One copy of a board; runs in the source board's serial scope. */
export async function copyWhiteboard(
  db: Database,
  env: Env,
  input: DuplicateWhiteboardInput,
): Promise<{ whiteboardId: string; title: string }> {
  const board = await db.query.whiteboards.findFirst({
    where: input.revisionId ? { id: input.whiteboardId } : { id: input.whiteboardId, status: "active" },
    columns: { id: true, spaceId: true, title: true, syncRoomId: true },
  });
  if (!board) throw Errors.NOT_FOUND("Whiteboard");

  let source: SyncCommandRequest<"seed">["source"];
  // The copy is created where it is seeded from: a live board's own node,
  // which reads its current state there.
  let node: WhiteboardNode;
  if (input.revisionId) {
    const revision = await db.query.whiteboardRevisions.findFirst({
      where: { id: input.revisionId, whiteboardId: board.id },
      columns: { snapshotR2Key: true },
    });
    if (!revision) throw Errors.NOT_FOUND("Whiteboard");
    source = { key: revision.snapshotR2Key };
    node = await nodeForNewBoard(db, env, input.nodeLatencies ?? {}, `${board.id}/${input.revisionId}`);
  } else {
    const placement = await placeBoard(db, env, board.syncRoomId, { kind: "service" });
    if (!placement) throw Errors.NOT_FOUND("Whiteboard");
    source = {
      whiteboardRoomId: toWhiteboardRoomId(board.syncRoomId),
      whiteboardId: board.id,
      generation: placement.generation,
    };
    node = placement.node;
  }
  const copyPlacement = { node, generation: 1 };

  const whiteboardId = generateId("WHITEBOARD");
  const title = (input.title ?? `Copy of ${board.title}`).slice(0, 200);
  const destinationSpaceId = input.destinationSpaceId ?? board.spaceId;
  const now = new Date();

  // The source board's serial scope keeps a board purge from deleting a live
  // source mid-seed. A purge of some other namespace that removes what the
  // seed reads fails the seed, which reports the content as unreadable.
  let assetKeys: string[];
  try {
    ({ assetKeys } = await runSyncCommand(env, "seed", {
      whiteboardRoomId: toWhiteboardRoomId(whiteboardId),
      whiteboardId,
      commandId: newCommandId(),
      source,
    }, { target: copyPlacement }));
  } catch (error) {
    // The seed may have created the new board's room before failing.
    await cleanupFailedWhiteboardCopy(db, env, whiteboardId);
    if (error instanceof Error && "statusCode" in error && error.statusCode === 409) {
      throw Errors.CONFLICT(
        "This Whiteboard's saved content cannot be read, so it cannot be duplicated.",
      );
    }
    throw error;
  }
  const sourceAssetKeys = await filterAuthorizedWhiteboardAssetKeys(db, board.id, assetKeys);
  const referenceRows = sourceAssetKeys.flatMap((r2Key) => {
    const identity = extractWhiteboardDocumentAssetIdentity(r2Key);
    if (!identity || identity.whiteboardId === whiteboardId) return [];
    return [
      {
        id: generateId("WHITEBOARD_ASSET"),
        whiteboardId,
        sourceWhiteboardId: identity.whiteboardId,
        r2Key,
        createdAt: now,
      } satisfies typeof whiteboardAssetReferences.$inferInsert,
    ];
  });
  const sourceObjectsExist = async () =>
    (await mapWithConcurrency(sourceAssetKeys, 8, (r2Key) => env.R2_BUCKET.head(r2Key)))
      .every((object) => object !== null);
  try {
    if (!(await sourceObjectsExist())) {
      throw Errors.CONFLICT("Whiteboard assets changed while the copy was being prepared");
    }
    // The copy displays the foreign assets these rows authorize, and a source
    // board's purge keeps exactly what they reference: the board and its
    // references commit together or not at all. A reference to an object the
    // cleanup queue is deleting is refused, and every object is checked again
    // once the references hold it (see r2KeyBeingDeletedSql).
    await insertDurableWhiteboard(
      db,
      {
        id: whiteboardId,
        syncRoomId: whiteboardId,
        syncNodeId: copyPlacement.node.id,
        syncGeneration: copyPlacement.generation,
        spaceId: destinationSpaceId,
        title,
        status: "active",
        createdByUserId: input.userId,
        createdAt: now,
        updatedAt: now,
      },
      { alongside: () => insertAssetReferencesForBoard(db, whiteboardId, referenceRows) },
    );
    const held = await db.$count(whiteboardAssetReferences, eq(whiteboardAssetReferences.whiteboardId, whiteboardId));
    if (held !== referenceRows.length || !(await sourceObjectsExist())) {
      throw Errors.CONFLICT("Whiteboard assets changed while the copy was being prepared");
    }
  } catch (error) {
    await cleanupFailedWhiteboardCopy(db, env, whiteboardId);
    throw error;
  }
  return { whiteboardId, title };
}

/**
 * Presents a Whiteboard in an open Meeting. Space boundaries are ownership
 * boundaries: a source from another Space is copied into the Meeting's Space,
 * then the independent copy is attached. The copy is removed if attachment
 * loses a race with Meeting finalization.
 */
export async function presentWhiteboardInMeeting(
  db: Database,
  env: Env,
  input: { meetingId: string; whiteboardId: string; presentedByUserId: string },
): Promise<MeetingWhiteboardDocument & { copiedFromWhiteboardId: string | null }> {
  const meeting = await db.query.meetings.findFirst({
    where: { id: input.meetingId, status: "open" },
    columns: { id: true, spaceId: true },
  });
  const source = await db.query.whiteboards.findFirst({
    where: { id: input.whiteboardId, status: "active" },
    columns: { id: true, spaceId: true, title: true },
  });
  if (!meeting || !source) throw Errors.NOT_FOUND("Whiteboard");
  const canPresent = await db.query.spaceMembers.findFirst({
    where: { spaceId: source.spaceId, userId: input.presentedByUserId },
    columns: { id: true },
  });
  if (!canPresent) throw Errors.NOT_FOUND("Whiteboard");

  let copiedWhiteboardId: string | null = null;
  try {
    if (source.spaceId !== meeting.spaceId) {
      const copy = await duplicateWhiteboard(env, {
        whiteboardId: source.id,
        userId: input.presentedByUserId,
        destinationSpaceId: meeting.spaceId,
        title: source.title,
      });
      copiedWhiteboardId = copy.whiteboardId;
    }
    const document = await attachExistingWhiteboardToMeeting(db, {
      ...input,
      whiteboardId: copiedWhiteboardId ?? source.id,
    });
    return { ...document, copiedFromWhiteboardId: copiedWhiteboardId ? source.id : null };
  } catch (error) {
    if (copiedWhiteboardId) {
      await cleanupFailedWhiteboardCopy(db, env, copiedWhiteboardId);
    }
    throw error;
  }
}
