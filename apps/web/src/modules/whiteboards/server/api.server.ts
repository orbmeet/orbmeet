/**
 * Server implementations behind the RPC declarations in this directory.
 * Split from the sibling RPC file so the declaration file carries no
 * DB/Drizzle imports and stays safe to include in client route graphs.
 */

import type { Database } from "@orbmeet/db";
import { whiteboardAssetReferences, whiteboardAssets, whiteboardRevisionAssetReferences, meetings, meetingWhiteboards, spaceMembers, spaces, whiteboardRevisions, whiteboards } from "@orbmeet/db/schema";
import { and, desc, eq, exists, isNull, lt, or, sql } from "drizzle-orm";
import { Errors } from "@/lib/app-errors";
import { assertPastMeetingManager } from "@/modules/meetings/server/access/access-assertions";
import { assertSpaceCapability, getSpaceAccess, retainsSpaceViewerSql } from "@/modules/spaces/server/helpers";
import { createMeetingWhiteboardDocument, createSpaceWhiteboard } from "./documents";
import { duplicateWhiteboard as duplicateWhiteboardDocument, presentWhiteboardInMeeting } from "./document-revisions";
import { restoreWhiteboardFromRevision } from "./restores";
import { startWhiteboardPurge } from "./purge.server";
import { logWarn } from "@/lib/logger";
import { d1UnicodeContains } from "@/platform/database/d1-unicode-like";
import { getRunChanges } from "@/platform/database/db-utils";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { type WhiteboardListCursorInput } from "./api.functions";
import type { CreateMeetingWhiteboardInput, CreateSpaceWhiteboardInput, ListMyWhiteboardsInput, ListWhiteboardsInput, MeetingWhiteboardChoicesInput, MeetingWhiteboardCopyPolicyInput, PresentWhiteboardInput, RenameWhiteboardInput, RestoreWhiteboardSnapshotInput, WhiteboardDocumentInput } from "./api.functions";
import { presentOnMeetingSurface } from "@/modules/whiteboards/server/surface-state.server";
import { authorizeInMeeting, userSubject } from "@/modules/meetings/server/runtime/client.server";
import { ensurePersonalSpace } from "@/modules/spaces/server/personal";
import { newCommandId, runSyncCommand } from "@/modules/whiteboards/server/sync-commands.server";
import { toWhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { loadSpaceEntitlement } from "@/modules/billing/server/entitlements.server";
import { enqueueR2ObjectCleanup } from "@/modules/assets/server/r2-cleanup.server";
import { runSerially } from "@/app/serial/serial";

export async function getWhiteboardImpl({
  data,
  context: { user, db },
}: {
  data: WhiteboardDocumentInput;
  context: AuthFnContext;
}) {
  const [document] = await db
    .select({
      id: whiteboards.id,
      title: whiteboards.title,
      spaceId: whiteboards.spaceId,
      spaceKind: spaces.kind,
      spaceName: spaces.name,
      spaceSlug: spaces.slug,
      status: whiteboards.status,
      createdByUserId: whiteboards.createdByUserId,
      revisionId: sql<string>`${whiteboardRevisions.id}`,
      meetingId: sql<string>`${whiteboardRevisions.sourceMeetingId}`,
    })
    .from(whiteboards)
    .innerJoin(spaces, eq(spaces.id, whiteboards.spaceId))
    // Left-joined: a Whiteboard prepared outside a Meeting has no captured
    // revision, and it is still a document you can open. `revisionId` is
    // history, not identity.
    .leftJoin(whiteboardRevisions, eq(whiteboardRevisions.whiteboardId, whiteboards.id))
    .where(
      and(
        eq(whiteboards.id, data.whiteboardId),
        eq(whiteboards.status, "active"),
        isNull(spaces.archivedAt),
      ),
    )
    .orderBy(desc(whiteboardRevisions.revisionNumber))
    .limit(1);
  if (!document) throw Errors.NOT_FOUND("Whiteboard");
  const access = await assertSpaceCapability(db, document.spaceId, user.id, "canView").catch(() => {
    throw Errors.NOT_FOUND("Whiteboard");
  });
  return {
    ...document,
    spaceId: document.spaceKind === "shared" ? document.spaceId : null,
    contextKind: document.spaceKind === "personal" ? ("personal" as const) : ("space" as const),
    // A personal Space is not a place the user can navigate to, so naming it
    // tells them nothing. Absence of a Space label means "mine".
    contextName: document.spaceKind === "personal" ? null : document.spaceName,
    contextSlug: document.spaceKind === "shared" ? document.spaceSlug : null,
    canManageLifecycle: document.createdByUserId === user.id || access.capabilities.canManage,
  };
}

type WhiteboardListCursor = WhiteboardListCursorInput;

// The lists put the most recently changed board first. `updatedAt` only ever
// moves forward (every write stamps it now, or leaves it), so a board that
// changes while someone is paging jumps ahead of every cursor already handed
// out: it is never served twice, and the next first page shows it at the top.
// The cursor carries its own sort key, so the row it ended on may go away.

function whiteboardCursorClause(cursor: WhiteboardListCursor | undefined) {
  return cursor
    ? or(
        lt(whiteboards.updatedAt, new Date(cursor.updatedAt)),
        and(eq(whiteboards.updatedAt, new Date(cursor.updatedAt)), lt(whiteboards.id, cursor.id)),
      )
    : undefined;
}

function nextWhiteboardCursor(rows: Array<{ id: string; updatedAt: Date }>, limit: number) {
  if (rows.length <= limit) return null;
  const last = rows[limit - 1];
  return last ? { updatedAt: last.updatedAt.getTime(), id: last.id } : null;
}

/**
 * "Last used in Calculus · Jul 27" — the one piece of Meeting context a card
 * carries. It is provenance, not a gate: a board that has never been presented
 * simply has none, and opens exactly the same way.
 */
function qualifiedColumn(tableName: string, columnName: string) {
  return sql`${sql.identifier(tableName)}.${sql.identifier(columnName)}`;
}

// These columns live inside correlated raw-SQL subqueries. Keep their table
// qualifiers explicit: an unqualified `id` resolves to the inner table in
// SQLite instead of the outer Whiteboard row.
export const whiteboardUsageColumns = (() => {
  const listedWhiteboardId = qualifiedColumn("whiteboards", whiteboards.id.name);
  const usageWhiteboardId = qualifiedColumn(
    "meeting_whiteboards",
    meetingWhiteboards.whiteboardId.name,
  );
  const usageLastPresentedAt = qualifiedColumn(
    "meeting_whiteboards",
    meetingWhiteboards.lastPresentedAt.name,
  );
  const usageAttachedAt = qualifiedColumn(
    "meeting_whiteboards",
    meetingWhiteboards.attachedAt.name,
  );
  const usageMeetingId = qualifiedColumn("meeting_whiteboards", meetingWhiteboards.meetingId.name);
  const listedMeetingId = qualifiedColumn("meetings", meetings.id.name);
  const listedMeetingTitle = qualifiedColumn("meetings", meetings.title.name);

  return {
    // `sql<Date>` is type-only. MAX returns SQLite's raw epoch number, so reuse
    // the timestamp column decoder before the API serializes this value.
    lastUsedAt: sql<Date | null>`(
      select max(${usageLastPresentedAt}) from ${meetingWhiteboards}
      where ${usageWhiteboardId} = ${listedWhiteboardId}
    )`.mapWith(meetingWhiteboards.lastPresentedAt),
    lastUsedIn: sql<string | null>`(
      select ${listedMeetingTitle} from ${meetingWhiteboards}
      inner join ${meetings} on ${listedMeetingId} = ${usageMeetingId}
      where ${usageWhiteboardId} = ${listedWhiteboardId}
      order by ${usageLastPresentedAt} desc, ${usageAttachedAt} desc
      limit 1
    )`,
  };
})();

export async function selectSpaceWhiteboardsPage(
  db: Database,
  data: { spaceId: string; cursor?: WhiteboardListCursor; limit: number },
) {
  const rows = await db
    .select({
      id: whiteboards.id,
      title: whiteboards.title,
      status: whiteboards.status,
      createdAt: whiteboards.createdAt,
      updatedAt: whiteboards.updatedAt,
      lastUsedAt: whiteboardUsageColumns.lastUsedAt,
      lastUsedIn: whiteboardUsageColumns.lastUsedIn,
    })
    .from(whiteboards)
    .where(
      and(
        eq(whiteboards.spaceId, data.spaceId),
        eq(whiteboards.status, "active"),
        whiteboardCursorClause(data.cursor),
      ),
    )
    .orderBy(desc(whiteboards.updatedAt), desc(whiteboards.id))
    .limit(data.limit + 1);
  const page = rows.slice(0, data.limit);
  return {
    whiteboards: page.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    })),
    nextCursor: nextWhiteboardCursor(rows, data.limit),
  };
}

export async function listSpaceWhiteboardsImpl({
  data,
  context: { user, db },
}: {
  data: ListWhiteboardsInput;
  context: AuthFnContext;
}) {
  await assertSpaceCapability(db, data.spaceId, user.id, "canView");
  return selectSpaceWhiteboardsPage(db, data);
}

export async function listMyWhiteboardsImpl({
  data,
  context: { user, db },
}: {
  data: ListMyWhiteboardsInput;
  context: AuthFnContext;
}) {
  const memberBoard = db
    .select({ one: sql<number>`1` })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, whiteboards.spaceId), eq(spaceMembers.userId, user.id)));
  const columns = {
    id: whiteboards.id,
    title: whiteboards.title,
    spaceId: whiteboards.spaceId,
    spaceKind: spaces.kind,
    spaceName: spaces.name,
    status: whiteboards.status,
    createdByUserId: whiteboards.createdByUserId,
    archivedAt: whiteboards.archivedAt,
    canManageLifecycle: sql<boolean>`coalesce((
          ${whiteboards.createdByUserId} = ${user.id}
          or exists (
            select 1 from ${spaceMembers} lifecycle_manager
            where lifecycle_manager.space_id = ${whiteboards.spaceId}
              and lifecycle_manager.user_id = ${user.id}
              and lifecycle_manager.role = 'admin'
          )
        ), 0)`,
    hasMeetingUses: sql<boolean>`exists (
          select 1 from ${meetingWhiteboards} usage
          where usage.whiteboard_id = ${whiteboards.id}
        )`,
    hasDependentHistory: sql<boolean>`exists (
          select 1
          from ${whiteboardRevisionAssetReferences} dependent_pin
          inner join ${whiteboardRevisions} dependent_revision
            on dependent_revision.id = dependent_pin.revision_id
          inner join ${whiteboardAssets} source_asset
            on source_asset.r2_key = dependent_pin.r2_key
          where source_asset.whiteboard_id = ${whiteboards.id}
            and dependent_revision.whiteboard_id <> ${whiteboards.id}
        )`,
    updatedAt: whiteboards.updatedAt,
    lastUsedAt: whiteboardUsageColumns.lastUsedAt,
    lastUsedIn: whiteboardUsageColumns.lastUsedIn,
  } as const;
  const rows = await db
    .select(columns)
    .from(whiteboards)
    .innerJoin(spaces, eq(spaces.id, whiteboards.spaceId))
    .where(
      and(
        isNull(spaces.archivedAt),
        eq(whiteboards.status, data.status),
        exists(memberBoard),
        whiteboardCursorClause(data.cursor),
      ),
    )
    .orderBy(desc(whiteboards.updatedAt), desc(whiteboards.id))
    .limit(data.limit + 1);
  const page = rows.slice(0, data.limit);
  const serialize = (row: (typeof rows)[number]) => ({
    id: row.id,
    title: row.title,
    spaceId: row.spaceKind === "shared" ? row.spaceId : null,
    spaceName: row.spaceKind === "shared" ? row.spaceName : null,
    contextKind: row.spaceKind === "personal" ? ("personal" as const) : ("space" as const),
    // A personal Space is not somewhere the user can navigate to, and the
    // English word "Personal" is presentation text masquerading as data.
    // Absence of a Space label is what says "mine".
    contextName: row.spaceKind === "personal" ? null : row.spaceName,
    status: row.status,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    canManageLifecycle: row.canManageLifecycle,
    canPermanentlyDelete: row.canManageLifecycle && !row.hasMeetingUses && !row.hasDependentHistory,
    hasMeetingUses: row.hasMeetingUses,
    hasDependentHistory: row.hasDependentHistory,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastUsedIn: row.lastUsedIn,
    updatedAt: row.updatedAt.toISOString(),
  });
  return {
    whiteboards: page.map(serialize),
    nextCursor: nextWhiteboardCursor(rows, data.limit),
  };
}

/** An open meeting whose room says `userId` may moderate it now. */
async function requireMeetingModerator(db: Database, env: Env, meetingId: string, userId: string) {
  const meeting = await db.query.meetings.findFirst({
    where: { RAW: (row) => and(eq(row.id, meetingId), eq(row.status, "open"))! },
    columns: { id: true, spaceId: true },
  });
  if (!meeting) throw Errors.NOT_FOUND("Meeting");
  await authorizeInMeeting(env, meeting.id, userId);
  return meeting;
}

/**
 * The Whiteboards this presenter can put on the Meeting surface. Choices from
 * another Space remain discoverable, but presenting one materializes an
 * independent copy inside the Meeting's Space before it is attached.
 */
export async function selectPresentableWhiteboardsPage(
  db: Database,
  data: {
    userId: string;
    meetingSpaceId: string;
    cursor?: WhiteboardListCursor;
    limit: number;
    search?: string;
  },
) {
  const titleSearch = data.search?.trim() || null;
  const rows = await db
    .select({
      whiteboardId: whiteboards.id,
      spaceId: whiteboards.spaceId,
      title: whiteboards.title,
      contextKind: spaces.kind,
      contextName: spaces.name,
      updatedAt: whiteboards.updatedAt,
      lastUsedAt: whiteboardUsageColumns.lastUsedAt,
      lastUsedIn: whiteboardUsageColumns.lastUsedIn,
    })
    .from(whiteboards)
    .innerJoin(spaces, eq(spaces.id, whiteboards.spaceId))
    .innerJoin(
      spaceMembers,
      and(eq(spaceMembers.spaceId, whiteboards.spaceId), eq(spaceMembers.userId, data.userId)),
    )
    .where(
      and(
        eq(whiteboards.status, "active"),
        isNull(spaces.archivedAt),
        titleSearch ? d1UnicodeContains(whiteboards.title, titleSearch) : undefined,
        whiteboardCursorClause(data.cursor),
      ),
    )
    .orderBy(desc(whiteboards.updatedAt), desc(whiteboards.id))
    .limit(data.limit + 1);
  const page = rows.slice(0, data.limit);
  return {
    whiteboards: page.map((row) => ({
      ...row,
      isFromAnotherSpace: row.spaceId !== data.meetingSpaceId,
      contextKind: row.contextKind === "personal" ? ("personal" as const) : ("space" as const),
      contextName: row.contextKind === "personal" ? null : row.contextName,
      updatedAt: row.updatedAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    })),
    nextCursor: nextWhiteboardCursor(
      rows.map((row) => ({ id: row.whiteboardId, updatedAt: row.updatedAt })),
      data.limit,
    ),
  };
}

export async function listPresentableWhiteboardsImpl({
  data,
  context: { user, db, env },
}: {
  data: MeetingWhiteboardChoicesInput;
  context: AuthFnContext;
}) {
  const meeting = await requireMeetingModerator(db, env, data.meetingId, user.id);
  return selectPresentableWhiteboardsPage(db, {
    userId: user.id,
    meetingSpaceId: meeting.spaceId,
    cursor: data.cursor,
    limit: data.limit,
    search: data.search,
  });
}

/** Whether attendees may save a copy of a past Meeting's captured Whiteboard. */
export async function setMeetingWhiteboardCopyPolicyImpl({
  data,
  context: { user, db },
}: {
  data: MeetingWhiteboardCopyPolicyInput;
  context: AuthFnContext;
}) {
  // The policy guards copies of a past meeting's capture, and managing a past
  // meeting is its Space's owner and admins' (there is no host once it ends).
  const meeting = await assertPastMeetingManager(db, data.meetingId, user.id);
  if (meeting.status !== "ended") {
    throw Errors.VALIDATION("Copy access is set once the Meeting has ended");
  }
  const updated = await db
    .update(meetingWhiteboards)
    .set({ allowParticipantCopy: data.allowParticipantCopy })
    .where(
      and(
        eq(meetingWhiteboards.meetingId, data.meetingId),
        eq(meetingWhiteboards.whiteboardId, data.whiteboardId),
      ),
    )
    .returning({ id: meetingWhiteboards.id });
  if (updated.length === 0) throw Errors.NOT_FOUND("Meeting Whiteboard");
  return { allowParticipantCopy: data.allowParticipantCopy };
}

/** Present a durable Whiteboard, copying it across a Space boundary first. */
export async function presentWhiteboardImpl({
  data,
  context: { user, db, env },
}: {
  data: PresentWhiteboardInput;
  context: AuthFnContext;
}) {
  // The room presents for moderators too; ask it before copying anything.
  const meeting = await requireMeetingModerator(db, env, data.meetingId, user.id);
  const document = await presentWhiteboardInMeeting(db, env, {
    ...data,
    presentedByUserId: user.id,
  });
  // The room pins what the previous board shared and switches everyone over.
  const surface = await presentOnMeetingSurface(env, meeting.id, userSubject(user.id), document);
  return {
    surface,
    whiteboardId: document.whiteboardId,
    copiedFromWhiteboardId: document.copiedFromWhiteboardId,
  };
}

export async function createNewWhiteboardImpl({
  data,
  context: { user, db, env },
}: {
  data: CreateMeetingWhiteboardInput;
  context: AuthFnContext;
}) {
  const meeting = await requireMeetingModerator(db, env, data.meetingId, user.id);
  const document = await createMeetingWhiteboardDocument(db, meeting.id, user.id, {
    clientTimeZone: data.clientTimeZone,
  });
  if (!document) throw Errors.NOT_FOUND("Meeting");
  const surface = await presentOnMeetingSurface(env, meeting.id, userSubject(user.id), document);
  return { surface, whiteboardId: document.whiteboardId };
}

/**
 * Create a Whiteboard outside any Meeting. This is the ordinary path: a person
 * decides to make one and names it. No Meeting is started, nothing is
 * presented, and the document is immediately editable.
 */
export async function createWhiteboardImpl({
  data,
  context: { user, db },
}: {
  data: CreateSpaceWhiteboardInput;
  context: AuthFnContext;
}) {
  let spaceId = data.spaceId;
  if (spaceId) {
    await assertSpaceCapability(db, spaceId, user.id, "canView");
  } else {
    spaceId = await ensurePersonalSpace(db, user);
  }
  return createSpaceWhiteboard(db, {
    spaceId,
    title: data.title,
    createdByUserId: user.id,
  });
}

/**
 * A Whiteboard's Snapshots, newest first — the board's History panel.
 *
 * Snapshots are a byproduct, never a choice: one is written automatically when
 * a Meeting that presented this board ends. Labelling each by the Meeting that
 * produced it is what makes the list mean something, because "revision 4" tells
 * a teacher nothing and "Calculus · Jul 27" tells them everything.
 */
export async function listWhiteboardSnapshotsImpl({
  data,
  context: { user, db },
}: {
  data: WhiteboardDocumentInput;
  context: AuthFnContext;
}) {
  const board = await db.query.whiteboards.findFirst({
    where: { id: data.whiteboardId, status: "active" },
    columns: { id: true, spaceId: true },
  });
  if (!board) throw Errors.NOT_FOUND("Whiteboard");
  await assertSpaceCapability(db, board.spaceId, user.id, "canView").catch(() => {
    throw Errors.NOT_FOUND("Whiteboard");
  });
  const rows = await db
    .select({
      id: whiteboardRevisions.id,
      revisionNumber: whiteboardRevisions.revisionNumber,
      kind: whiteboardRevisions.kind,
      createdAt: whiteboardRevisions.createdAt,
      snapshotSize: whiteboardRevisions.snapshotSize,
      meetingId: whiteboardRevisions.sourceMeetingId,
      meetingTitle: meetings.title,
    })
    .from(whiteboardRevisions)
    // Left-joined: `source_meeting_id` is ON DELETE SET NULL, so a purged
    // Meeting must not take its Snapshot out of the list with it.
    .leftJoin(meetings, eq(meetings.id, whiteboardRevisions.sourceMeetingId))
    .where(eq(whiteboardRevisions.whiteboardId, board.id))
    .orderBy(desc(whiteboardRevisions.revisionNumber))
    .limit(100);
  return {
    snapshots: rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

/**
 * Duplicate a Whiteboard. This lives in the board's own overflow menu, never in
 * the in-meeting picker: nobody should make a fork-or-not decision while thirty
 * students wait.
 */
export async function duplicateWhiteboardImpl({
  data,
  context: { user, db, env },
}: {
  data: WhiteboardDocumentInput;
  context: AuthFnContext;
}) {
  const board = await db.query.whiteboards.findFirst({
    where: { id: data.whiteboardId, status: "active" },
    columns: { id: true, spaceId: true },
  });
  if (!board) throw Errors.NOT_FOUND("Whiteboard");
  await assertSpaceCapability(db, board.spaceId, user.id, "canView").catch(() => {
    throw Errors.NOT_FOUND("Whiteboard");
  });
  return duplicateWhiteboardDocument(env, { whiteboardId: board.id, userId: user.id });
}

/**
 * Put a Whiteboard back to the state a Snapshot recorded.
 *
 * The one destructive thing History can do, so it is made undoable rather than
 * confirmable-and-final: the state being replaced is frozen as its own
 * `pre_restore` Snapshot first, and lands in this same list. "Are you sure?" is
 * a worse guarantee than a way back.
 */
export async function restoreWhiteboardSnapshotImpl({
  data,
  context: { user, db, env },
}: {
  data: RestoreWhiteboardSnapshotInput;
  context: AuthFnContext;
}) {
  const board = await db.query.whiteboards.findFirst({
    where: { id: data.whiteboardId, status: "active" },
    columns: { id: true, spaceId: true },
  });
  if (!board) throw Errors.NOT_FOUND("Whiteboard");
  // Clause 1, exactly as for rename: a Space is a class roster, and a member
  // who can erase the board by hand but not undo that by restoring would have
  // only the destructive half of the same power.
  await assertSpaceCapability(db, board.spaceId, user.id, "canView");

  return restoreWhiteboardFromRevision(db, env, {
    whiteboardId: data.whiteboardId,
    revisionId: data.revisionId,
    userId: user.id,
  });
}

export async function renameWhiteboardImpl({
  data,
  context: { user, db },
}: {
  data: RenameWhiteboardInput;
  context: AuthFnContext;
}) {
  const board = await db.query.whiteboards.findFirst({
    where: { id: data.whiteboardId, status: "active" },
    columns: { id: true, spaceId: true },
  });
  if (!board) throw Errors.NOT_FOUND("Whiteboard");
  // Clause 1: any Space member. Naming is part of editing a document, and a
  // Space is a class roster, not a review workflow — a member who can draw on
  // a board but cannot fix its name would be a strange kind of collaborator.
  await assertSpaceCapability(db, board.spaceId, user.id, "canView");
  const now = new Date();
  const result = await db
    .update(whiteboards)
    .set({ title: data.title, updatedAt: now })
    .where(
      and(
        eq(whiteboards.id, board.id),
        eq(whiteboards.status, "active"),
        retainsSpaceViewerSql(board.spaceId, user.id),
      ),
    )
    .run();
  if (getRunChanges(result) === 0) {
    const access = await getSpaceAccess(db, board.spaceId, user.id);
    if (!access?.capabilities.canView) {
      throw Errors.FORBIDDEN("Your Space access changed before the Whiteboard was renamed.");
    }
    throw Errors.CONFLICT("This Whiteboard was archived before it could be renamed.");
  }
  return { title: data.title, updatedAt: now.toISOString() };
}

async function assertWhiteboardLifecycleAuthority(
  db: Database,
  board: { spaceId: string; createdByUserId: string | null },
  userId: string,
) {
  // A board's creator manages it like a Space manager does, for as long as
  // they still belong to its Space.
  const access = await assertSpaceCapability(db, board.spaceId, userId, "canView");
  if (board.createdByUserId !== userId && !access.capabilities.canManage) throw Errors.FORBIDDEN();
}

/** Archive is the normal reversible removal path for a durable Whiteboard. */
export async function archiveWhiteboardImpl({
  data,
  context: { user, env },
}: {
  data: WhiteboardDocumentInput;
  context: AuthFnContext;
}) {
  return runSerially(env, { kind: "archiveWhiteboard", whiteboardId: data.whiteboardId, actorUserId: user.id }, { callerWaits: true });
}

/** Archive a board; runs in its serial scope, with every other change to its lifecycle. */
export async function archiveWhiteboard(
  db: Database,
  env: Env,
  { whiteboardId, actorUserId }: { whiteboardId: string; actorUserId: string },
): Promise<{ archivedAt: string }> {
  const board = await db.query.whiteboards.findFirst({
    where: { id: whiteboardId, status: "active" },
    columns: { id: true, syncRoomId: true, spaceId: true, createdByUserId: true },
  });
  if (!board) throw Errors.NOT_FOUND("Whiteboard");
  await assertWhiteboardLifecycleAuthority(db, board, actorUserId);
  const openUse = await db
    .select({ id: meetingWhiteboards.id })
    .from(meetingWhiteboards)
    .innerJoin(meetings, eq(meetings.id, meetingWhiteboards.meetingId))
    .where(and(eq(meetingWhiteboards.whiteboardId, board.id), eq(meetings.status, "open")))
    .limit(1);
  if (openUse.length > 0) {
    throw Errors.CONFLICT("End the Meeting using this Whiteboard before archiving it");
  }
  const target = {
    whiteboardRoomId: toWhiteboardRoomId(board.syncRoomId),
    whiteboardId: board.id,
  };
  let archived = false;
  try {
    // The sync room closes its sockets and refuses writes before D1 says
    // "archived", so the board's state is final from here.
    // Inside the try: a failure here may still have archived the room (a
    // lost response, a timeout while it runs), so it is compensated like any
    // later failure. The room runs the reopen after an archive in progress.
    await runSyncCommand(env, "archive", {
      ...target,
      commandId: newCommandId(),
    });

    const now = new Date();
    const updated = await db
      .update(whiteboards)
      .set({
        status: "archived",
        archivedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(whiteboards.id, board.id),
          eq(whiteboards.status, "active"),
          // A meeting may have started using the board since the check above.
          sql`not exists (
            select 1
            from ${meetingWhiteboards}
            inner join ${meetings}
              on ${meetings.id} = ${meetingWhiteboards.meetingId}
            where ${meetingWhiteboards.whiteboardId} = ${board.id}
              and ${meetings.status} = 'open'
          )`,
        ),
      )
      .returning({ id: whiteboards.id });
    if (updated.length === 0) {
      throw Errors.CONFLICT("This Whiteboard changed. Refresh and try again.");
    }
    archived = true;
    return { archivedAt: now.toISOString() };
  } finally {
    if (!archived) {
      // D1 still says active: make sure the room is open, so the board stays usable.
      await runSyncCommand(env, "reopen", { ...target, commandId: newCommandId() }).catch(
        (error) => {
          logWarn("[whiteboard] archive rollback reopen failed", { whiteboardId: board.id }, error);
        },
      );
    }
  }
}

export async function restoreArchivedWhiteboardImpl({
  data,
  context: { user, env },
}: {
  data: WhiteboardDocumentInput;
  context: AuthFnContext;
}) {
  return runSerially(env, {
    kind: "restoreArchivedWhiteboard",
    whiteboardId: data.whiteboardId,
    actorUserId: user.id,
  }, { callerWaits: true });
}

/** Bring an archived board back; runs in its serial scope. */
export async function restoreArchivedWhiteboard(
  db: Database,
  env: Env,
  { whiteboardId, actorUserId }: { whiteboardId: string; actorUserId: string },
): Promise<{ restoredAt: string }> {
  const board = await db.query.whiteboards.findFirst({
    where: { id: whiteboardId, status: "archived" },
    columns: {
      id: true,
      syncRoomId: true,
      spaceId: true,
      createdByUserId: true,
      archivedAt: true,
    },
  });
  if (!board) throw Errors.NOT_FOUND("Archived Whiteboard");
  await assertWhiteboardLifecycleAuthority(db, board, actorUserId);

  // Reuse the same atomic active-document quota gate as creation.
  const entitlement = await loadSpaceEntitlement(db, board.spaceId);
  const now = new Date();
  const restored = await db.run(sql`
        update ${whiteboards}
        set status = 'active', archived_at = null, updated_at = ${Math.floor(now.getTime() / 1000)}
        where id = ${board.id}
          and status = 'archived'
          and (
            select count(*) from ${whiteboards} active_board
            where active_board.space_id = ${board.spaceId}
              and active_board.status = 'active'
          ) < ${entitlement.limits.maxWhiteboardsPerSpace}
      `);
  if (!restored.meta.changes) {
    throw Errors.PLAN_LIMIT_REACHED(
      `This Space has reached its ${entitlement.limits.maxWhiteboardsPerSpace}-Whiteboard limit`,
    );
  }
  try {
    await runSyncCommand(env, "reopen", {
      whiteboardRoomId: toWhiteboardRoomId(board.syncRoomId),
      whiteboardId: board.id,
      commandId: newCommandId(),
    });
  } catch (error) {
    // Do not expose an active document while its sync room still refuses
    // writes as archived. Put the durable lifecycle back exactly
    // where it was; a retry can safely attempt the reopen again.
    await db
      .update(whiteboards)
      .set({
        status: "archived",
        archivedAt: board.archivedAt,
        updatedAt: new Date(),
      })
      .where(and(eq(whiteboards.id, board.id), eq(whiteboards.status, "active")));
    throw error;
  }
  return { restoredAt: now.toISOString() };
}

/**
 * Permanently delete an archived Whiteboard only when it has never appeared in
 * Meeting history. Used boards remain archived so their Meeting record
 * keeps a valid document identity until the owning Space is deleted.
 */
export async function deleteArchivedWhiteboardImpl({
  data,
  context: { user, env },
}: {
  data: WhiteboardDocumentInput;
  context: AuthFnContext;
}) {
  return runSerially(env, {
    kind: "deleteArchivedWhiteboard",
    whiteboardId: data.whiteboardId,
    actorUserId: user.id,
  }, { callerWaits: true });
}

/** Delete an archived board for good; runs in its serial scope. */
export async function deleteArchivedWhiteboard(
  db: Database,
  env: Env,
  { whiteboardId, actorUserId }: { whiteboardId: string; actorUserId: string },
): Promise<{ success: true }> {
  const board = await db.query.whiteboards.findFirst({
    where: { id: whiteboardId, status: "archived" },
    columns: { id: true, spaceId: true, createdByUserId: true },
  });
  if (!board) throw Errors.NOT_FOUND("Archived Whiteboard");
  await assertWhiteboardLifecycleAuthority(db, board, actorUserId);
  const usage = await db.query.meetingWhiteboards.findFirst({
    where: { whiteboardId: board.id },
    columns: { id: true },
  });
  if (usage) {
    throw Errors.CONFLICT(
      "This Whiteboard is part of Meeting history and must remain archived until its Space is deleted",
    );
  }
  const revisionPin = await db
    .select({ r2Key: whiteboardRevisionAssetReferences.r2Key })
    .from(whiteboardRevisionAssetReferences)
    .innerJoin(
      whiteboardRevisions,
      eq(whiteboardRevisions.id, whiteboardRevisionAssetReferences.revisionId),
    )
    .innerJoin(
      whiteboardAssets,
      eq(whiteboardAssets.r2Key, whiteboardRevisionAssetReferences.r2Key),
    )
    .where(
      and(
        eq(whiteboardAssets.whiteboardId, board.id),
        sql`${whiteboardRevisions.whiteboardId} <> ${board.id}`,
      ),
    )
    .limit(1);
  if (revisionPin.length > 0) {
    throw Errors.CONFLICT(
      "This Whiteboard supplied content used by another Whiteboard's history and must remain archived",
    );
  }
  const referencedSourceKeys = await db
    .select({ r2Key: whiteboardAssetReferences.r2Key })
    .from(whiteboardAssetReferences)
    .where(eq(whiteboardAssetReferences.whiteboardId, board.id));
  // Queue before deleting the referrer. The cleanup queue waits out a grace
  // period and rechecks every relational owner before deleting.
  await enqueueR2ObjectCleanup(
    db,
    referencedSourceKeys.map((row) => row.r2Key),
  );
  // Started before the delete, so a committed delete always has its purge;
  // the job waits to see the row gone and keeps a board whose delete did
  // not land (see purge.server.ts).
  await startWhiteboardPurge(env, board.id);
  const deleted = await db
    .delete(whiteboards)
    .where(
      and(
        eq(whiteboards.id, board.id),
        eq(whiteboards.status, "archived"),
        sql`not exists (
          select 1 from ${meetingWhiteboards}
          where ${meetingWhiteboards.whiteboardId} = ${board.id}
        )`,
      ),
    )
    .returning({ id: whiteboards.id });
  if (deleted.length === 0) {
    throw Errors.CONFLICT("This Whiteboard changed. Refresh and try again.");
  }
  return { success: true };
}
