/**
 * Whiteboard revision lifecycle: pinning the shared state a Meeting is
 * showing, capturing Meeting-end revisions, and recording restore points.
 * Duplication & presentation live in `./document-copy`; restoring lives in
 * `./restores`; document creation, lookup, and access predicates in `./documents`.
 *
 * The sync server owns every stored whiteboard snapshot — it writes and reads
 * the bytes; this module never touches them. Each flow here asks the sync
 * server to store a snapshot at a key it names, then records the D1 rows from
 * the metadata the command returns (hash, clock, size, referenced assets).
 */
import type { Database } from "@orbmeet/db";
import {
  meetingWhiteboards,
  whiteboardRevisions,
  whiteboards,
} from "@orbmeet/db/schema";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { SnapshotMeta } from "@orbmeet/whiteboard-core/sync-commands";
import { toWhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import {
  internalMeetingWhiteboardCaptureKey,
  whiteboardRevisionKey,
} from "@orbmeet/whiteboard-core/document-keys";
import { boundedStatements } from "@/platform/database/db-batching";
import { Errors } from "@/lib/app-errors";
import { generateId } from "@/lib/ids";
import { getRunChanges, withD1Retry } from "@/platform/database/db-utils";
import { logWarn } from "@/lib/logger";
import {
  enqueueR2ObjectCleanup,
  keepR2ObjectStatement,
  r2KeyBeingDeletedSql,
  r2ObjectCleanupStatements,
} from "@/modules/assets/server/r2-cleanup.server";
import { loadSpaceEntitlement } from "@/modules/billing/server/entitlements.server";
import { expectSyncCommand, runSyncCommand, sendSyncCommand } from "./sync-commands.server";
import {
  insertPreparedRevisionAssetReferences,
  prepareStoredRevision,
  preparedRevisionSelectColumns,
  type PreparedWhiteboardRevision,
} from "./revision-assets";

export {
  copyWhiteboard,
  duplicateWhiteboard,
  presentWhiteboardInMeeting,
  type DuplicateWhiteboardInput,
} from "./document-copy";

/**
 * Pin what a Meeting shared of one presented Whiteboard.
 *
 * The meeting's room owes a pin at each boundary: the surface closing, focus
 * leaving the board, the Meeting ending. The sync server captures the live
 * room's state at a key derived from the boundary's
 * `commandId`, so a retry after a lost response repeats nothing; D1 then
 * moves the usage's pointer to it.
 *
 * The sync server copies the board as it is when the pin runs, so a pin is
 * only started before `startBefore`, close to its boundary. Past it, a pin
 * that never ran is answered `expired` and nothing is pinned: the capture
 * keeps the board's previous pin rather than one holding later edits.
 *
 * A pin may land late (the room retries it through a sync-server outage), so
 * pointers only move forward in document time: a pin that lost a race with a
 * later one for the same board leaves the later one in place.
 */
export async function pinMeetingWhiteboardSharedState(
  db: Database,
  env: Env,
  pin: { meetingId: string; usageId: string; commandId: string; startBefore: number },
  now = new Date(),
): Promise<void> {
  const [usage] = await db
    .select({
      id: meetingWhiteboards.id,
      whiteboardId: whiteboards.id,
      syncRoomId: whiteboards.syncRoomId,
      previousCaptureKey: meetingWhiteboards.lastSharedSnapshotR2Key,
      previousCaptureHash: meetingWhiteboards.lastSharedSnapshotHash,
    })
    .from(meetingWhiteboards)
    .innerJoin(whiteboards, eq(whiteboards.id, meetingWhiteboards.whiteboardId))
    .where(and(
      eq(meetingWhiteboards.id, pin.usageId),
      eq(meetingWhiteboards.meetingId, pin.meetingId),
      // Once captured, the Meeting's history is settled.
      sql`${meetingWhiteboards.capturedRevisionId} is null`,
    ))
    .limit(1);
  if (!usage) return;

  const captureKey = internalMeetingWhiteboardCaptureKey(pin.meetingId, usage.whiteboardId, pin.commandId);
  if (usage.previousCaptureKey === captureKey) return;
  // Owed to the cleanup queue before it exists: a capture this pin never puts
  // in the usage's slot is garbage, and one it does is kept while the usage is
  // unsettled, then deleted once its capture settles it.
  await enqueueR2ObjectCleanup(db, [captureKey], now);
  const result = await sendSyncCommand(env, "capture", {
    whiteboardRoomId: toWhiteboardRoomId(usage.syncRoomId),
    whiteboardId: usage.whiteboardId,
    commandId: pin.commandId,
    toKey: captureKey,
    startBefore: pin.startBefore,
  });
  if (!result.ok && result.reason === "expired") {
    logWarn("[whiteboard-capture] A sharing boundary passed before its pin could run", {
      meetingId: pin.meetingId,
      usageId: pin.usageId,
    });
    return;
  }
  const { copy } = expectSyncCommand(result);

  const unsettled = and(
    eq(meetingWhiteboards.id, usage.id),
    sql`${meetingWhiteboards.capturedRevisionId} is null`,
  );

  // An unchanged board merely advances when it was last shared; it keeps the
  // existing capture rather than a second copy.
  if (usage.previousCaptureKey && usage.previousCaptureHash === copy.hash) {
    await db.update(meetingWhiteboards).set({ lastSharedAt: now }).where(unsettled);
    return;
  }

  // The slot moves to the new capture, unless the queue has already started
  // deleting it; the one it held is owed to the queue, which keeps it should
  // this update not land and leave it there.
  await db.batch([
    db
      .update(meetingWhiteboards)
      .set({
        lastSharedSnapshotR2Key: captureKey,
        lastSharedSnapshotHash: copy.hash,
        lastSharedDocumentClock: copy.documentClock,
        lastSharedSnapshotSize: copy.size,
        lastSharedAt: now,
      })
      .where(and(
        unsettled,
        sql`coalesce(${meetingWhiteboards.lastSharedDocumentClock}, -1) <= ${copy.documentClock}`,
        sql`not ${r2KeyBeingDeletedSql(captureKey)}`,
      )),
    ...r2ObjectCleanupStatements(db, usage.previousCaptureKey ? [usage.previousCaptureKey] : [], now),
  ]);
}

// A revision a Meeting captured is Meeting history, outside the rolling undo budget.
function unpinnedRestorePointSql() {
  return sql`not exists (
    select 1 from ${meetingWhiteboards}
    where ${meetingWhiteboards.capturedRevisionId} = ${whiteboardRevisions.id}
  )`;
}

function insertPreparedWhiteboardRevision(
  db: Database,
  prepared: PreparedWhiteboardRevision,
  maxRestorePoints: number,
) {
  const values = prepared.values;
  return db
    .insert(whiteboardRevisions)
    .select(
      db
        .select(preparedRevisionSelectColumns(prepared))
        .from(whiteboards)
        .where(
          and(
            eq(whiteboards.id, values.whiteboardId),
            sql`not ${r2KeyBeingDeletedSql(values.snapshotR2Key)}`,
            sql`(
          select count(*) from ${whiteboardRevisions}
          where ${whiteboardRevisions.whiteboardId} = ${values.whiteboardId}
            and ${whiteboardRevisions.kind} = 'pre_restore'
            and ${unpinnedRestorePointSql()}
        ) < ${maxRestorePoints}`,
          ),
        ),
    )
    .onConflictDoNothing({ target: whiteboardRevisions.id })
    .returning({ id: whiteboardRevisions.id });
}

/**
 * The revision a usage's capture settles it with, inserted only under the
 * condition the settling update checks (the usage unsettled, its slot still
 * the capture this revision copied) and only while its object is not being
 * deleted, so the batch carrying both lands whole or not at all.
 */
function insertPreparedMeetingWhiteboardRevision(
  db: Database,
  prepared: PreparedWhiteboardRevision,
  meetingWhiteboardId: string,
  capturedSnapshotR2Key: string,
) {
  const values = prepared.values;
  return db.insert(whiteboardRevisions).select(
    db
      .select(preparedRevisionSelectColumns(prepared))
      .from(meetingWhiteboards)
      .where(
        and(
          eq(meetingWhiteboards.id, meetingWhiteboardId),
          sql`${meetingWhiteboards.capturedRevisionId} IS NULL`,
          eq(meetingWhiteboards.lastSharedSnapshotR2Key, capturedSnapshotR2Key),
          sql`not ${r2KeyBeingDeletedSql(values.snapshotR2Key)}`,
        ),
      ),
  );
}

/**
 * Record a restore point the sync server stored, inside the board's rolling
 * undo budget. The resulting Snapshot is a `pre_restore` one and appears in
 * History next to the Meeting-end Snapshots: a restore that could not itself
 * be undone would make the History panel a trap rather than a record.
 */
async function recordWhiteboardRestorePoint(
  db: Database,
  board: { id: string; spaceId: string },
  prepared: PreparedWhiteboardRevision,
): Promise<string> {
  const entitlement = await loadSpaceEntitlement(db, board.spaceId);
  const maxRestorePoints = entitlement.limits.maxWhiteboardRestorePointsPerBoard;
  let committed = false;
  // Two writers at the history limit can initially choose the same oldest
  // row. The loser re-selects after its no-op delete instead of reporting a
  // bogus plan-limit error; the next oldest row is then a real slot to claim.
  for (let attempt = 0; attempt < 3 && !committed; attempt++) {
    const [{ value: restorePointCount = 0 } = {}] = await db
      .select({ value: count() })
      .from(whiteboardRevisions)
      .where(
        and(
          eq(whiteboardRevisions.whiteboardId, board.id),
          eq(whiteboardRevisions.kind, "pre_restore"),
          unpinnedRestorePointSql(),
        ),
      );
    const pruneCount = Math.max(0, restorePointCount - maxRestorePoints + 1);
    const selected =
      pruneCount > 0
        ? await db
            .select({
              id: whiteboardRevisions.id,
              snapshotR2Key: whiteboardRevisions.snapshotR2Key,
            })
            .from(whiteboardRevisions)
            .where(
              and(
                eq(whiteboardRevisions.whiteboardId, board.id),
                eq(whiteboardRevisions.kind, "pre_restore"),
                unpinnedRestorePointSql(),
              ),
            )
            .orderBy(asc(whiteboardRevisions.revisionNumber))
            .limit(pruneCount)
        : [];
    const pruneStatements = boundedStatements(selected.map((revision) => revision.id), (ids) =>
      db
        .delete(whiteboardRevisions)
        .where(and(inArray(whiteboardRevisions.id, ids), unpinnedRestorePointSql())));
    // One transaction: the pruned revisions go with their objects owed to
    // the cleanup queue, and the new one takes its own object back from it
    // (the restore job owed it before the sync server wrote it).
    const statements = [
      ...pruneStatements,
      ...r2ObjectCleanupStatements(db, selected.map((revision) => revision.snapshotR2Key)),
    ];
    const insertedAt = statements.length;
    statements.push(
      insertPreparedWhiteboardRevision(db, prepared, maxRestorePoints),
      ...insertPreparedRevisionAssetReferences(db, prepared),
      keepR2ObjectStatement(db, prepared.snapshotR2Key),
    );
    const [first, ...rest] = statements;
    const results = await withD1Retry(() => db.batch([first, ...rest]), { idempotent: true });
    if ((results[insertedAt] as Array<{ id: string }>).length === 1) {
      committed = true;
      break;
    }
    // A retry of a batch that committed: the revision is there already.
    committed = Boolean(await db.query.whiteboardRevisions.findFirst({
      where: { id: prepared.revisionId },
      columns: { id: true },
    }));
  }
  if (!committed) {
    throw Errors.CONFLICT("Whiteboard history changed concurrently; retry the restore");
  }
  return prepared.revisionId;
}

/**
 * Record in History the restore point the sync server stored before a
 * restore, as a `pre_restore` revision. Idempotent by revision id, so a
 * retried restore never records it twice.
 */
export async function recordRestorePointInHistory(
  db: Database,
  env: Env,
  input: {
    board: { id: string; spaceId: string };
    revisionId: string;
    stored: SnapshotMeta;
    userId: string | null;
    now: Date;
  },
): Promise<void> {
  const existing = await db.query.whiteboardRevisions.findFirst({
    where: { id: input.revisionId },
    columns: { id: true },
  });
  if (existing) return;
  const prepared = await prepareStoredRevision(db, env, {
    revisionId: input.revisionId,
    whiteboardId: input.board.id,
    spaceId: input.board.spaceId,
    stored: input.stored,
    kind: "pre_restore",
    sourceMeetingId: null,
    createdByUserId: input.userId,
    now: input.now,
  });
  await recordWhiteboardRestorePoint(db, input.board, prepared);
}

export async function captureMeetingWhiteboardUsageRevision(
  db: Database,
  env: Env,
  meetingWhiteboardId: string,
  now = new Date(),
): Promise<string | null> {
  const [usage] = await db
    .select({
      id: meetingWhiteboards.id,
      meetingId: meetingWhiteboards.meetingId,
      lastSharedSnapshotR2Key: meetingWhiteboards.lastSharedSnapshotR2Key,
      lastSharedSnapshotHash: meetingWhiteboards.lastSharedSnapshotHash,
      capturedRevisionId: meetingWhiteboards.capturedRevisionId,
      whiteboardId: whiteboards.id,
      title: whiteboards.title,
      spaceId: whiteboards.spaceId,
    })
    .from(meetingWhiteboards)
    .innerJoin(whiteboards, eq(whiteboards.id, meetingWhiteboards.whiteboardId))
    .where(eq(meetingWhiteboards.id, meetingWhiteboardId))
    .limit(1);
  if (!usage) return null;
  if (usage.capturedRevisionId) return usage.capturedRevisionId;
  const capturedSnapshotR2Key = usage.lastSharedSnapshotR2Key;
  if (!capturedSnapshotR2Key || !usage.lastSharedSnapshotHash) {
    throw new Error(`Meeting Whiteboard boundary snapshot is missing: ${usage.whiteboardId}`);
  }
  const meeting = await db.query.meetings.findFirst({
    where: { id: usage.meetingId, status: "ended" },
    columns: { id: true },
  });
  if (!meeting) throw new Error(`Whiteboard capture requires an ended Meeting: ${usage.meetingId}`);

  // The capture settles the usage on the shared state it read. A pin landing
  // in between moves the pointer, and this capture then commits nothing.
  const unsettled = and(
    eq(meetingWhiteboards.id, usage.id),
    sql`${meetingWhiteboards.capturedRevisionId} IS NULL`,
    eq(meetingWhiteboards.lastSharedSnapshotR2Key, capturedSnapshotR2Key),
  );
  const settled = {
    captureStatus: "captured" as const,
    titleAtEnd: usage.title,
    capturedAt: now,
    focusedAt: null,
  };
  const recoverCapture = async () =>
    (await db.query.meetingWhiteboards.findFirst({
      where: { id: usage.id },
      columns: { capturedRevisionId: true },
    }))?.capturedRevisionId ?? null;

  // A shared state the board already holds as a revision — byte for byte,
  // which only that revision's own hash can say — points at that revision
  // instead of storing the same bytes again.
  const [existing] = await db
    .select({ id: whiteboardRevisions.id })
    .from(whiteboardRevisions)
    .where(and(
      eq(whiteboardRevisions.whiteboardId, usage.whiteboardId),
      eq(whiteboardRevisions.snapshotHash, usage.lastSharedSnapshotHash),
    ))
    .orderBy(desc(whiteboardRevisions.revisionNumber))
    .limit(1);
  if (existing) {
    const reused = await db
      .update(meetingWhiteboards)
      .set({ ...settled, capturedRevisionId: existing.id })
      .where(and(
        unsettled,
        // Pruning may have removed the revision since it was read.
        sql`EXISTS (SELECT 1 FROM ${whiteboardRevisions} WHERE ${whiteboardRevisions.id} = ${existing.id})`,
      ))
      .returning({ id: meetingWhiteboards.id });
    if (reused.length > 0) {
      await enqueueR2ObjectCleanup(db, [capturedSnapshotR2Key], now);
      return existing.id;
    }
    const recovered = await recoverCapture();
    if (recovered) return recovered;
    // The revision was pruned, or a pin moved the pointer: store a copy below,
    // or fail and let the job's retry read the usage again.
  }

  const revisionId = generateId("WHITEBOARD_REVISION");
  const destinationKey = whiteboardRevisionKey(usage.whiteboardId, revisionId);
  // Owed to the cleanup queue before it exists, and taken back by the batch
  // that commits the revision: a copy that never commits (a failure here, a
  // retry under a fresh revision id, a pin that moved the slot) is garbage.
  await enqueueR2ObjectCleanup(db, [destinationKey], now);
  const { copy } = await runSyncCommand(env, "copySnapshot", {
    sourceKey: capturedSnapshotR2Key,
    destinationKey,
  });
  const prepared = await prepareStoredRevision(db, env, {
    revisionId,
    whiteboardId: usage.whiteboardId,
    spaceId: usage.spaceId,
    stored: copy,
    kind: "meeting_end",
    sourceMeetingId: usage.meetingId,
    createdByUserId: null,
    now,
  });
  // One transaction, every statement under the same condition: the revision,
  // its references and the settled usage land together or not at all.
  try {
    const results = await db.batch([
      insertPreparedMeetingWhiteboardRevision(db, prepared, usage.id, capturedSnapshotR2Key),
      ...insertPreparedRevisionAssetReferences(db, prepared),
      db
        .update(meetingWhiteboards)
        .set({ ...settled, capturedRevisionId: prepared.revisionId })
        .where(and(
          unsettled,
          sql`EXISTS (SELECT 1 FROM ${whiteboardRevisions} WHERE ${whiteboardRevisions.id} = ${prepared.revisionId})`,
        )),
      keepR2ObjectStatement(db, destinationKey),
    ]);
    if (getRunChanges(results[results.length - 2]) === 0) {
      const recovered = await recoverCapture();
      if (recovered) return recovered;
      throw new Error(`Whiteboard capture lost its commit race: ${usage.id}`);
    }
  } catch (error) {
    // D1 can commit a batch and still lose the response: then the usage
    // points at this revision, and it stands.
    const recovered = await recoverCapture();
    if (recovered !== prepared.revisionId) {
      if (recovered) return recovered;
      throw error;
    }
  }
  // The revision holds its own copy; the slot's capture is now garbage.
  await enqueueR2ObjectCleanup(db, [capturedSnapshotR2Key], now);
  return prepared.revisionId;
}
