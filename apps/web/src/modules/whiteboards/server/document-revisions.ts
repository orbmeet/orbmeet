/**
 * Whiteboard revision lifecycle: pinning the shared state a Meeting is
 * showing, duplicating a document, capturing Meeting-end revisions, and
 * recording restore points. Restoring itself lives in `./restores`; document
 * creation, lookup, and access predicates in `./documents`.
 *
 * The sync server owns every stored whiteboard snapshot — it writes and reads
 * the bytes; this module never touches them. Each flow here asks the sync
 * server to store a snapshot at a key it names, then records the D1 rows from
 * the metadata the command returns (hash, clock, size, referenced assets).
 */
import type { Database } from "@orbmeet/db";
import {
  meetingWhiteboards,
  whiteboardAssetReferences,
  whiteboardRevisionAssetReferences,
  whiteboardRevisions,
  whiteboards,
} from "@orbmeet/db/schema";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { SnapshotMeta, SyncCommandRequest } from "@orbmeet/whiteboard-core/sync-commands";
import { toWhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import {
  internalMeetingWhiteboardCaptureKey,
  whiteboardRevisionKey,
} from "@orbmeet/whiteboard-core/document-keys";
import {
  extractWhiteboardDocumentAssetIdentity,
} from "@orbmeet/whiteboard-core/whiteboard-asset-key";
import { boundedStatements } from "@/platform/database/db-batching";
import { Errors } from "@/lib/app-errors";
import { generateId } from "@/lib/ids";
import { getRunChanges, withD1Retry } from "@/platform/database/db-utils";
import { logError, logWarn } from "@/lib/logger";
import { commitRevisionWhiteboardAssets } from "./assets";
import { runSerially } from "@/app/serial/serial";
import {
  enqueueR2ObjectCleanup,
  keepR2ObjectStatement,
  r2KeyBeingDeletedSql,
  r2ObjectCleanupStatements,
} from "@/modules/assets/server/r2-cleanup.server";
import { mapWithConcurrency } from "@orbmeet/primitives";
import {
  attachExistingWhiteboardToMeeting,
  cleanupFailedWhiteboardCopy,
  insertDurableWhiteboardWithinLimit,
  type MeetingWhiteboardDocument,
} from "./documents";
import { loadSpaceEntitlement } from "@/modules/billing/server/entitlements.server";
import { expectSyncCommand, newCommandId, runSyncCommand, sendSyncCommand } from "./sync-commands.server";
import type { NodeLatencies } from "@orbmeet/nodes";
import { nodeForNewBoard, placeBoard } from "./board-placement.server";
import type { WhiteboardNode } from "./config.server";

/**
 * A snapshot may retain assets owned by this document or by a document it was
 * legitimately copied from. Never let snapshot bytes create that ownership:
 * foreign keys must already be authorized by a durable reference row.
 */
async function filterAuthorizedWhiteboardAssetKeys(
  db: Database,
  whiteboardId: string,
  r2Keys: readonly string[],
): Promise<string[]> {
  const foreignKeys = r2Keys.filter((r2Key) => {
    const identity = extractWhiteboardDocumentAssetIdentity(r2Key);
    return identity && identity.whiteboardId !== whiteboardId;
  });
  const authorized = new Set<string>();
  const lookups = boundedStatements([...new Set(foreignKeys)], (keys) =>
    db
      .select({
        r2Key: whiteboardAssetReferences.r2Key,
        sourceWhiteboardId: whiteboardAssetReferences.sourceWhiteboardId,
      })
      .from(whiteboardAssetReferences)
      .where(
        and(
          eq(whiteboardAssetReferences.whiteboardId, whiteboardId),
          inArray(whiteboardAssetReferences.r2Key, keys),
        ),
      ));
  for (const lookup of lookups) {
    for (const row of await lookup) {
      if (
        extractWhiteboardDocumentAssetIdentity(row.r2Key)?.whiteboardId === row.sourceWhiteboardId
      ) {
        authorized.add(row.r2Key);
      }
    }
  }
  return r2Keys.filter((r2Key) => {
    const identity = extractWhiteboardDocumentAssetIdentity(r2Key);
    return identity !== null && (identity.whiteboardId === whiteboardId || authorized.has(r2Key));
  });
}

/**
 * Insert a board's asset reference rows, only while the board row exists, so
 * they can share a batch with the board's own guarded insert. Chunked under
 * D1's bound-parameter limit.
 */
function insertAssetReferencesForBoard(
  db: Database,
  whiteboardId: string,
  rows: ReadonlyArray<typeof whiteboardAssetReferences.$inferInsert>,
) {
  return boundedStatements(rows, (chunk) => db.run(sql`
    insert into ${whiteboardAssetReferences} (id, whiteboard_id, source_whiteboard_id, r2_key, created_at)
    select column1, column2, column3, column4, column5
    from (values ${sql.join(
      chunk.map((row) => sql`(${row.id}, ${row.whiteboardId}, ${row.sourceWhiteboardId}, ${row.r2Key}, ${
        Math.floor((row.createdAt ?? new Date()).getTime() / 1000)
      })`),
      sql`, `,
    )})
    where exists (select 1 from ${whiteboards} where ${whiteboards.id} = ${whiteboardId})
      and not ${r2KeyBeingDeletedSql(sql`column4`)}
    on conflict do nothing
  `));
}

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
    source = { whiteboardRoomId: toWhiteboardRoomId(board.syncRoomId), whiteboardId: board.id };
    const placement = await placeBoard(db, env, board.syncRoomId, { kind: "service" });
    if (!placement) throw Errors.NOT_FOUND("Whiteboard");
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
    await insertDurableWhiteboardWithinLimit(
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

interface PreparedWhiteboardRevision {
  revisionId: string;
  snapshotR2Key: string;
  assetKeys: string[];
  values: Omit<typeof whiteboardRevisions.$inferInsert, "revisionNumber">;
}

function nextWhiteboardRevisionNumber(whiteboardId: string) {
  return sql<number>`(
    SELECT COALESCE(MAX(existing.revision_number), 0) + 1
    FROM ${whiteboardRevisions} AS existing
    WHERE existing.whiteboard_id = ${whiteboardId}
  )`;
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
  const createdAtSeconds = Math.floor((values.createdAt ?? new Date()).getTime() / 1000);
  return db
    .insert(whiteboardRevisions)
    .select(
      db
        .select({
          id: sql<string>`${values.id}`.as("id"),
          whiteboardId: sql<string>`${values.whiteboardId}`.as("whiteboard_id"),
          spaceId: sql<string>`${values.spaceId}`.as("space_id"),
          revisionNumber: nextWhiteboardRevisionNumber(values.whiteboardId).as("revision_number"),
          kind: sql<typeof values.kind>`${values.kind}`.as("kind"),
          sourceMeetingId: sql<string | null>`${values.sourceMeetingId ?? null}`.as(
            "source_meeting_id",
          ),
          snapshotR2Key: sql<string>`${values.snapshotR2Key}`.as("snapshot_r2_key"),
          snapshotHash: sql<string | null>`${values.snapshotHash ?? null}`.as("snapshot_hash"),
          assetManifest: sql<string | null>`${values.assetManifest ?? null}`.as("asset_manifest"),
          documentClock: sql<number | null>`${values.documentClock ?? null}`.as("document_clock"),
          snapshotSize: sql<number>`${values.snapshotSize}`.as("snapshot_size"),
          createdByUserId: sql<string | null>`${values.createdByUserId ?? null}`.as(
            "created_by_user_id",
          ),
          createdAt: sql<number>`${createdAtSeconds}`.as("created_at"),
        })
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
  const createdAtSeconds = Math.floor((values.createdAt ?? new Date()).getTime() / 1000);
  return db.insert(whiteboardRevisions).select(
    db
      .select({
        id: sql<string>`${values.id}`.as("id"),
        whiteboardId: sql<string>`${values.whiteboardId}`.as("whiteboard_id"),
        spaceId: sql<string>`${values.spaceId}`.as("space_id"),
        revisionNumber: nextWhiteboardRevisionNumber(values.whiteboardId).as("revision_number"),
        kind: sql<typeof values.kind>`${values.kind}`.as("kind"),
        sourceMeetingId: sql<string | null>`${values.sourceMeetingId ?? null}`.as(
          "source_meeting_id",
        ),
        snapshotR2Key: sql<string>`${values.snapshotR2Key}`.as("snapshot_r2_key"),
        snapshotHash: sql<string | null>`${values.snapshotHash ?? null}`.as("snapshot_hash"),
        assetManifest: sql<string | null>`${values.assetManifest ?? null}`.as("asset_manifest"),
        documentClock: sql<number | null>`${values.documentClock ?? null}`.as("document_clock"),
        snapshotSize: sql<number>`${values.snapshotSize}`.as("snapshot_size"),
        createdByUserId: sql<string | null>`${values.createdByUserId ?? null}`.as(
          "created_by_user_id",
        ),
        createdAt: sql<number>`${createdAtSeconds}`.as("created_at"),
      })
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

function insertPreparedRevisionAssetReferences(db: Database, prepared: PreparedWhiteboardRevision) {
  const createdAt = prepared.values.createdAt ?? new Date();
  return boundedStatements([...new Set(prepared.assetKeys)], (keys) =>
    db
      .insert(whiteboardRevisionAssetReferences)
      .values(keys.map((r2Key) => ({ revisionId: prepared.revisionId, r2Key, createdAt })))
      .onConflictDoNothing());
}

/**
 * Turn a snapshot the sync server has stored at a revision key into the rows
 * that record it: reconcile the assets it references, and build the revision
 * row the caller inserts.
 *
 * Deliberately stops short of the D1 write. Meeting capture commits its row in
 * the same batch as the `meeting_whiteboards` update it belongs to, and a
 * restore point commits alongside its history pruning — so callers own the
 * write and its rollback.
 */
async function prepareStoredRevision(
  db: Database,
  env: Env,
  input: {
    revisionId: string;
    whiteboardId: string;
    spaceId: string;
    stored: SnapshotMeta;
    kind: "meeting_end" | "pre_restore";
    sourceMeetingId: string | null;
    createdByUserId: string | null;
    now: Date;
  },
): Promise<PreparedWhiteboardRevision> {
  const referencedAssetKeys = await filterAuthorizedWhiteboardAssetKeys(
    db,
    input.whiteboardId,
    input.stored.assetKeys,
  );
  const { committedKeys, missingKeys } = await commitRevisionWhiteboardAssets(db, env, {
    whiteboardId: input.whiteboardId,
    spaceId: input.spaceId,
    r2Keys: referencedAssetKeys,
    now: input.now,
  });
  if (missingKeys.length > 0) {
    // Capture proceeds without them. The manifest is the authorization list for
    // reading a revision's assets, so recording a key with no object behind it
    // would authorize a 404; dropping it keeps the manifest describing what is
    // actually retrievable.
    logError(
      `[whiteboard-capture] ${missingKeys.length} referenced asset object(s) missing for whiteboard ${input.whiteboardId}; capturing without them:`,
      missingKeys.slice(0, 10),
    );
  }
  // Inherited document keys are not owned by this document, so the
  // commit helper does not register them. Their existing reference authority
  // was checked above; carry it into both the read manifest and the revision's
  // durable GC pins.
  const retainedAssetKeys = [
    ...new Set([
      ...committedKeys,
      ...referencedAssetKeys.filter(
        (key) => extractWhiteboardDocumentAssetIdentity(key)?.whiteboardId !== input.whiteboardId,
      ),
    ]),
  ].sort();
  return {
    revisionId: input.revisionId,
    snapshotR2Key: input.stored.key,
    assetKeys: retainedAssetKeys,
    values: {
      id: input.revisionId,
      whiteboardId: input.whiteboardId,
      spaceId: input.spaceId,
      kind: input.kind,
      sourceMeetingId: input.sourceMeetingId,
      snapshotR2Key: input.stored.key,
      snapshotHash: input.stored.hash,
      assetManifest: JSON.stringify(retainedAssetKeys),
      documentClock: input.stored.documentClock,
      snapshotSize: input.stored.size,
      createdByUserId: input.createdByUserId,
      createdAt: input.now,
    },
  };
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
