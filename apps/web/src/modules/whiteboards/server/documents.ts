import type { Database } from "@orbmeet/db";
import {
  meetingConnections,
  meetings,
  meetingWhiteboards,
  meetingWhiteboardSurfaces,
  spaceMembers,
  spaces,
  whiteboards,
} from "@orbmeet/db/schema";
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Errors } from "@/lib/app-errors";
import { coerceSuggestedTimeZone, formatCalendarDayLabel } from "@/lib/time-zone";
import { generateId } from "@/lib/ids";
import { getRunChanges, isUniqueConstraintError, withD1Retry } from "@/platform/database/db-utils";
import { logError } from "@/lib/logger";
import { startWhiteboardPurge } from "./purge.server";
import { runSerially } from "@/app/serial/serial";
import { loadSpaceEntitlement } from "@/modules/billing/server/entitlements.server";
import { connectionIsUnfinished } from "@/modules/meetings/server/connection/state";

export interface MeetingWhiteboardDocument {
  meetingWhiteboardId: string;
  whiteboardId: string;
  meetingId: string;
  syncRoomId: string;
  title: string;
  spaceId: string;
  status: "active" | "archived";
  captureStatus: "live" | "capturing" | "captured" | "failed";
  finalRevisionId: string | null;
  surfaceOpen: boolean;
}

/**
 * The name a Whiteboard created inside a Meeting starts with. The Meeting's own
 * title is something the class already recognizes and the board is renameable
 * in place; only an untitled Meeting falls back to the date. This runs once, at
 * creation — `whiteboards.title` is NOT NULL, so nothing computes a display
 * name at read time any more.
 */
function meetingWhiteboardTitle(
  meetingTitle: string | null,
  now: Date,
  timeZone: string | null,
): string {
  const trimmed = meetingTitle?.trim();
  if (trimmed) return trimmed.slice(0, 200);

  // The calendar day as the people in the Meeting experienced it.
  //
  // Not `now.toISOString()`, which is UTC because Workers run in UTC: a
  // Meeting held at 02:40 in Asia/Dhaka would produce "Whiteboard · 2026-09-13"
  // while its own record page — rendered in the browser's zone — is headed
  // "Meeting on September 14". One session, two dates, side by side.
  // Written as the app writes dates ("Oct 12, 2026"), not ISO: it is a name
  // people read in every list, beside "Last used today".
  return `Whiteboard · ${formatCalendarDayLabel(now, timeZone)}`.slice(0, 200);
}


/**
 * Roll back a failed copy without producing a D1 row that points at a missing
 * document. The relational row is the ownership authority, so the copy's
 * stored state is purged by a job that first sees the row gone (a lost DELETE
 * response included), and keeps it if the row survives.
 */
export async function cleanupFailedWhiteboardCopy(
  db: Database,
  env: Env,
  whiteboardId: string,
): Promise<void> {
  try {
    await startWhiteboardPurge(env, whiteboardId);
  } catch (error) {
    logError("[whiteboard] Could not start the purge of a rolled-back copy", { whiteboardId }, error);
  }
  try {
    await withD1Retry(
      () => db.delete(whiteboards).where(eq(whiteboards.id, whiteboardId)),
      { idempotent: true },
    );
  } catch (error) {
    logError("[whiteboard] Could not delete a rolled-back copy", { whiteboardId }, error);
  }
}

type DurableWhiteboardInsert = Pick<
  typeof whiteboards.$inferInsert,
  | "id" | "syncRoomId" | "syncNodeId" | "syncGeneration" | "spaceId" | "title" | "status" | "createdByUserId"
  | "createdAt" | "updatedAt"
>;

/**
 * The plan limit and insert are one D1 statement. Counting before a normal
 * insert would allow every concurrent creator to observe the same remaining
 * slot and permanently exceed the durable-document budget.
 */
export async function insertDurableWhiteboardWithinLimit(
  db: Database,
  input: DurableWhiteboardInsert,
  options: {
    /**
     * Statements that must commit with the board or not at all, run after its
     * insert in the same batch. Each must itself require the board row, so an
     * insert the batch skips leaves them nothing to write.
     */
    alongside?: () => BatchItem<"sqlite">[];
    /**
     * A condition the board itself requires besides the Space's limit, and
     * the refusal to throw when it is what kept the board out.
     */
    onlyIf?: { condition: SQL; refused: () => Error };
  } = {},
): Promise<void> {
  const { alongside = () => [], onlyIf } = options;
  const entitlement = await loadSpaceEntitlement(db, input.spaceId);
  const createdAtSeconds = Math.floor((input.createdAt ?? new Date()).getTime() / 1000);
  const updatedAtSeconds = Math.floor((input.updatedAt ?? input.createdAt ?? new Date()).getTime() / 1000);
  const [result] = await withD1Retry(
    () => db.batch([
      db.run(sql`
        insert into ${whiteboards} (
          id, sync_room_id, sync_node_id, sync_generation, space_id, title, status, created_by_user_id,
          archived_at, created_at, updated_at
        )
        select
          ${input.id}, ${input.syncRoomId}, ${input.syncNodeId ?? null}, ${input.syncGeneration ?? 0},
          ${input.spaceId}, ${input.title}, 'active', ${input.createdByUserId ?? null}, null,
          ${createdAtSeconds}, ${updatedAtSeconds}
        where (
          select count(*) from ${whiteboards}
          where ${whiteboards.spaceId} = ${input.spaceId}
            and ${whiteboards.status} = 'active'
        ) < ${entitlement.limits.maxWhiteboardsPerSpace}
          and ${onlyIf?.condition ?? sql`1`}
        on conflict(id) do nothing
      `),
      ...alongside(),
    ]),
    { idempotent: true },
  );
  if (getRunChanges(result) === 1) return;
  const existing = await db.query.whiteboards.findFirst({
    where: { id: input.id },
    columns: { syncRoomId: true, spaceId: true },
  });
  if (existing?.syncRoomId === input.syncRoomId && existing.spaceId === input.spaceId) return;
  if (onlyIf) {
    const holds = await db.get<{ holds: number }>(sql`select ${onlyIf.condition} as holds`);
    if (!holds?.holds) throw onlyIf.refused();
  }
  throw Errors.PLAN_LIMIT_REACHED(
    `This Space has reached its ${entitlement.limits.maxWhiteboardsPerSpace}-Whiteboard limit`,
  );
}

/**
 * The Whiteboard this Meeting is focused on. `focused_at` is unique per Meeting
 * (partial index), so the focused presentation is a single row rather than a
 * pointer that has to be reconciled against a most-recently-attached fallback.
 * A Meeting that has presented boards but is focused on none resolves to the
 * most recent one, which is what reopening the surface should restore.
 */
async function selectMeetingWhiteboardDocument(
  db: Database,
  meetingId: string,
): Promise<MeetingWhiteboardDocument | null> {
  const [row] = await selectMeetingWhiteboardDocumentStatement(db, meetingId);
  return row ?? null;
}

/** The document-select as a statement, so callers can batch it with writes. */
function selectMeetingWhiteboardDocumentStatement(
  db: Database,
  meetingId: string,
) {
  return meetingWhiteboardDocumentSelect(db)
    .where(eq(meetingWhiteboards.meetingId, meetingId))
    .orderBy(
      desc(meetingWhiteboards.focusedAt),
      desc(meetingWhiteboards.lastPresentedAt),
      desc(meetingWhiteboards.attachedAt),
    )
    .limit(1);
}

function meetingWhiteboardDocumentSelect(db: Database) {
  return db
    .select({
      meetingWhiteboardId: meetingWhiteboards.id,
      whiteboardId: whiteboards.id,
      meetingId: meetingWhiteboards.meetingId,
      syncRoomId: whiteboards.syncRoomId,
      title: whiteboards.title,
      spaceId: whiteboards.spaceId,
      status: whiteboards.status,
      captureStatus: meetingWhiteboards.captureStatus,
      finalRevisionId: meetingWhiteboards.capturedRevisionId,
      surfaceOpen: sql<boolean>`coalesce(${meetingWhiteboardSurfaces.open}, 0)`,
    })
    .from(meetingWhiteboards)
    .innerJoin(whiteboards, eq(whiteboards.id, meetingWhiteboards.whiteboardId))
    .innerJoin(meetings, eq(meetings.id, meetingWhiteboards.meetingId))
    .leftJoin(
      meetingWhiteboardSurfaces,
      eq(meetingWhiteboardSurfaces.meetingId, meetingWhiteboards.meetingId),
    );
}

export function findMeetingWhiteboardDocument(
  db: Database,
  meetingId: string,
): Promise<MeetingWhiteboardDocument | null> {
  return selectMeetingWhiteboardDocument(db, meetingId);
}

/** One of a Meeting's Whiteboard uses, whether or not it is presented. */
async function findMeetingWhiteboardUsage(
  db: Database,
  meetingId: string,
  usageId: string,
): Promise<MeetingWhiteboardDocument | null> {
  const [row] = await meetingWhiteboardDocumentSelect(db)
    .where(and(eq(meetingWhiteboards.meetingId, meetingId), eq(meetingWhiteboards.id, usageId)))
    .limit(1);
  return row ?? null;
}

/** A Meeting still taking boards: open, and not yet closing. */
function meetingTakesBoardsSql(meetingId: string, spaceId: string): SQL {
  return sql`exists (
    select 1 from ${meetings}
    where ${meetings.id} = ${meetingId} and ${meetings.spaceId} = ${spaceId}
      and ${meetings.status} = 'open' and ${meetings.closingAt} is null
  )`;
}

/**
 * A board's use in a Meeting, conditional, in the same statement, on the
 * Meeting still taking boards and the board being active in its Space:
 * attaching after the Meeting started closing would insert a usage no capture
 * will ever cover. Otherwise it inserts nothing.
 */
function insertMeetingWhiteboardUsage(
  db: Database,
  input: { usageId: string; meetingId: string; spaceId: string; whiteboardId: string; title: string; now: Date },
) {
  return db.insert(meetingWhiteboards).select(
    db
      .select({
        id: sql`${input.usageId}`.as("id"),
        meetingId: meetings.id,
        spaceId: meetings.spaceId,
        whiteboardId: sql`${input.whiteboardId}`.as("whiteboard_id"),
        titleAtUse: sql`${input.title}`.as("title_at_use"),
        captureStatus: sql`'live'`.as("capture_status"),
        attachedAt: sql`${Math.floor(input.now.getTime() / 1000)}`.as("attached_at"),
      })
      .from(meetings)
      .innerJoin(whiteboards, and(
        eq(whiteboards.id, input.whiteboardId),
        eq(whiteboards.spaceId, meetings.spaceId),
        eq(whiteboards.status, "active"),
      ))
      // The selected row must be this Meeting: the condition alone holds for
      // every Meeting in the Space while this one takes boards.
      .where(and(
        eq(meetings.id, input.meetingId),
        meetingTakesBoardsSql(input.meetingId, input.spaceId),
      )),
  );
}

/**
 * Attach a Whiteboard to an open Meeting: the usage row every presentation,
 * pin and capture of it in this Meeting hangs off. Attaching presents
 * nothing — the Meeting's room decides what the surface shows.
 */
async function attachWhiteboard(
  db: Database,
  input: {
    meetingId: string;
    spaceId: string;
    whiteboardId: string;
    title: string;
  },
): Promise<string> {
  const usageId = generateId("MEETING_WHITEBOARD");
  try {
    await insertMeetingWhiteboardUsage(db, { ...input, usageId, now: new Date() });
  } catch (error) {
    // A D1 write can commit and then lose its response. The generated usage id
    // makes that outcome distinguishable from a true failure.
    const committed = await db.query.meetingWhiteboards.findFirst({
      where: { id: usageId },
      columns: { id: true },
    });
    if (committed) return usageId;
    // Someone else attached the same board first: theirs is this Meeting's
    // one usage of it (meeting_whiteboards_meeting_board_unique_idx).
    if (isUniqueConstraintError(error)) {
      const concurrent = await db.query.meetingWhiteboards.findFirst({
        where: { meetingId: input.meetingId, whiteboardId: input.whiteboardId },
        columns: { id: true },
      });
      if (concurrent) return concurrent.id;
    }
    const stillOpen = await db.query.meetings.findFirst({
      where: { id: input.meetingId, status: "open" },
      columns: { id: true },
    });
    if (!stillOpen) throw Errors.CONFLICT("This Meeting has already ended");
    throw error;
  }
  const attached = await db.query.meetingWhiteboards.findFirst({
    where: { id: usageId },
    columns: { id: true },
  });
  if (!attached) throw Errors.CONFLICT("This Meeting has already ended");
  return usageId;
}

export interface MeetingWhiteboardCreateOptions {
  /**
   * The IANA zone the opening client is in. A *suggestion* used only to name an
   * untitled board; it is never persisted against the user.
   */
  clientTimeZone?: string | null;
}

/**
 * Creates a fresh durable Whiteboard in an open Meeting and attaches it. The
 * caller presents it through the Meeting's room.
 */
export async function createMeetingWhiteboardDocument(
  db: Database,
  meetingId: string,
  createdByUserId: string | null = null,
  options: MeetingWhiteboardCreateOptions = {},
): Promise<MeetingWhiteboardDocument | null> {
  const meeting = await db.query.meetings.findFirst({
    where: { id: meetingId, status: "open" },
    columns: { id: true, title: true, spaceId: true, startedByUserId: true },
  });
  if (!meeting) return null;

  // Whose day the board is named after, in order of authority:
  //
  // 1. The starter's saved zone — a durable choice they made.
  // 2. The zone the opening client volunteered with the request.
  // 3. UTC.
  //
  // Step 2 is why the board is no longer stamped with the Worker's UTC day for
  // almost everybody. `users.time_zone` is null until someone sets it in
  // Settings, and the schema is explicit that clients must not persist a device
  // zone on the user's behalf — so the saved zone is absent for a normal
  // account and step 1 alone silently meant "UTC". A board opened at 05:15 in
  // Asia/Dhaka was named for the previous day, which is the bug this comment's
  // predecessor claimed to have fixed.
  const namingUserId = meeting.startedByUserId ?? createdByUserId;
  const needsCalendarFallback = !meeting.title?.trim();
  const namingUser = needsCalendarFallback && namingUserId
    ? await db.query.users.findFirst({
        where: { id: namingUserId },
        columns: { timeZone: true },
      })
    : null;
  const namingTimeZone =
    namingUser?.timeZone ?? coerceSuggestedTimeZone(options.clientTimeZone);

  const whiteboardId = generateId("WHITEBOARD");
  const usageId = generateId("MEETING_WHITEBOARD");
  const now = new Date();
  const title = meetingWhiteboardTitle(meeting.title, now, namingTimeZone);
  // The board and its use in the Meeting commit together, both only while the
  // Meeting takes boards: a Meeting that closes in between gets neither.
  await insertDurableWhiteboardWithinLimit(db, {
    id: whiteboardId,
    syncRoomId: whiteboardId,
    spaceId: meeting.spaceId,
    title,
    status: "active",
    createdByUserId: createdByUserId ?? meeting.startedByUserId,
    createdAt: now,
    updatedAt: now,
  }, {
    onlyIf: {
      condition: meetingTakesBoardsSql(meeting.id, meeting.spaceId),
      refused: () => Errors.CONFLICT("This Meeting has already ended"),
    },
    alongside: () => [
      insertMeetingWhiteboardUsage(db, {
        usageId, meetingId: meeting.id, spaceId: meeting.spaceId, whiteboardId, title, now,
      }).onConflictDoNothing(),
    ],
  });
  return findMeetingWhiteboardUsage(db, meeting.id, usageId);
}

/**
 * Lazily creates the Meeting's first Whiteboard; later documents are explicit.
 * Creation runs in the Meeting's serial scope, so two people opening the
 * surface at once get the same board.
 */
export async function ensureMeetingWhiteboardDocument(
  db: Database,
  env: Pick<Env, "SERIAL_SCOPES">,
  meetingId: string,
  createdByUserId: string | null = null,
  options: MeetingWhiteboardCreateOptions = {},
): Promise<MeetingWhiteboardDocument | null> {
  const existing = await findMeetingWhiteboardDocument(db, meetingId);
  if (existing) return existing;
  return runSerially(env, {
    kind: "createFirstMeetingWhiteboard",
    meetingId,
    createdByUserId,
    clientTimeZone: options.clientTimeZone ?? null,
  }, { callerWaits: true });
}

/** The Meeting's first Whiteboard, created unless one exists; runs in the Meeting's serial scope. */
export async function createFirstMeetingWhiteboard(
  db: Database,
  { meetingId, createdByUserId, clientTimeZone }: {
    meetingId: string;
    createdByUserId: string | null;
    clientTimeZone: string | null;
  },
): Promise<MeetingWhiteboardDocument | null> {
  const existing = await findMeetingWhiteboardDocument(db, meetingId);
  if (existing) return existing;
  return createMeetingWhiteboardDocument(db, meetingId, createdByUserId, { clientTimeZone });
}

/** Attaches a durable document to a Meeting, or finds its existing use there. */
export async function attachExistingWhiteboardToMeeting(
  db: Database,
  input: { meetingId: string; whiteboardId: string; presentedByUserId: string },
): Promise<MeetingWhiteboardDocument> {
  const [row] = await db
    .select({
      meetingId: meetings.id,
      meetingSpaceId: meetings.spaceId,
      whiteboardId: whiteboards.id,
      boardSpaceId: whiteboards.spaceId,
      title: whiteboards.title,
      status: whiteboards.status,
    })
    .from(meetings)
    .innerJoin(whiteboards, eq(whiteboards.id, input.whiteboardId))
    .where(and(eq(meetings.id, input.meetingId), and(eq(meetings.status, "open"), sql`${meetings.closingAt} is null`)))
    .limit(1);
  if (!row || row.status !== "active") {
    throw Errors.NOT_FOUND("Whiteboard");
  }
  const canPresent = await db.query.spaceMembers.findFirst({
    where: { spaceId: row.boardSpaceId, userId: input.presentedByUserId },
    columns: { id: true },
  });
  if (!canPresent) throw Errors.NOT_FOUND("Whiteboard");
  if (row.boardSpaceId !== row.meetingSpaceId) {
    throw Errors.CONFLICT(
      "This Whiteboard belongs to another Space and must be copied before it can be presented",
    );
  }
  const existing = await db.query.meetingWhiteboards.findFirst({
    where: { meetingId: input.meetingId, whiteboardId: input.whiteboardId },
    columns: { id: true },
  });
  const usageId = existing?.id ?? await attachWhiteboard(db, {
    meetingId: input.meetingId,
    spaceId: row.meetingSpaceId,
    whiteboardId: input.whiteboardId,
    title: row.title,
  });
  const document = await findMeetingWhiteboardUsage(db, input.meetingId, usageId);
  if (!document) throw new Error("Whiteboard attachment was not persisted");
  return document;
}

/**
 * Resolve the open Meeting behind a participant connection. This is the only
 * Meeting lookup the whiteboard authorization path still needs: a Meeting is
 * never derived from a document, only from the connection that claims one.
 */
async function resolveActiveMeetingIdForWhiteboardConnection(
  db: Database,
  connectionId: string,
): Promise<string | null> {
  const [connection] = await db
    .select({ meetingId: meetingConnections.meetingId })
    .from(meetingConnections)
    .innerJoin(meetings, eq(meetings.id, meetingConnections.meetingId))
    .where(and(
      eq(meetingConnections.id, connectionId),
      connectionIsUnfinished(),
      and(eq(meetings.status, "open"), sql`${meetings.closingAt} is null`),
    ))
    .limit(1);
  return connection?.meetingId ?? null;
}

/**
 * The Meeting a participant's whiteboard token belongs to.
 *
 * The lookup runs connection → Meeting → "is this board presented there",
 * never document → Meeting. A Whiteboard has no owning Meeting to resolve: it
 * is a Space document that any number of Meetings may present.
 */
export async function resolveMeetingIdForWhiteboardConnection(
  db: Database,
  syncRoomId: string,
  connectionId: string | null | undefined,
): Promise<string | null> {
  if (!connectionId) return null;
  const meetingId = await resolveActiveMeetingIdForWhiteboardConnection(db, connectionId);
  if (!meetingId) return null;
  return (await isMeetingWhiteboardRoom(db, meetingId, syncRoomId)) ? meetingId : null;
}

/**
 * The open Meeting currently presenting this document, for service callers
 * (the recorder) that hold a room id and no participant connection.
 *
 * This is a read of presentation state, not a lease: it grants nothing and
 * excludes nobody. Where several open Meetings present the same board, the
 * focused one wins.
 */
export async function resolveOpenMeetingPresentingWhiteboard(
  db: Database,
  syncRoomId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ meetingId: meetingWhiteboards.meetingId })
    .from(meetingWhiteboards)
    .innerJoin(whiteboards, eq(whiteboards.id, meetingWhiteboards.whiteboardId))
    .innerJoin(meetings, eq(meetings.id, meetingWhiteboards.meetingId))
    .where(and(
      eq(whiteboards.syncRoomId, syncRoomId),
      eq(whiteboards.status, "active"),
      and(eq(meetings.status, "open"), sql`${meetings.closingAt} is null`),
    ))
    .orderBy(desc(meetingWhiteboards.focusedAt), desc(meetingWhiteboards.lastPresentedAt))
    .limit(1);
  return row?.meetingId ?? null;
}

async function isMeetingWhiteboardRoom(
  db: Database,
  meetingId: string,
  syncRoomId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: meetingWhiteboards.id })
    .from(meetingWhiteboards)
    .innerJoin(whiteboards, eq(whiteboards.id, meetingWhiteboards.whiteboardId))
    .where(and(
      eq(meetingWhiteboards.meetingId, meetingId),
      eq(whiteboards.syncRoomId, syncRoomId),
      eq(whiteboards.status, "active"),
    ))
    .limit(1);
  return Boolean(row);
}

export async function isWhiteboardRoomIdentity(
  db: Database,
  whiteboardId: string,
  syncRoomId: string,
): Promise<boolean> {
  const row = await db.query.whiteboards.findFirst({
    where: { id: whiteboardId, syncRoomId, status: "active" },
    columns: { id: true },
  });
  return Boolean(row);
}

export async function findWhiteboardIdForSyncRoom(
  db: Database,
  syncRoomId: string,
): Promise<string | null> {
  const row = await db.query.whiteboards.findFirst({ where: { syncRoomId }, columns: { id: true } });
  return row?.id ?? null;
}

/**
 * Creates a durable Whiteboard in a Space with no Meeting involved.
 *
 * This is the ordinary way a Whiteboard comes into existence: a person decides
 * to make one and names it. Meetings merely present what already exists.
 */
export async function createSpaceWhiteboard(
  db: Database,
  input: {
    spaceId: string;
    title: string;
    createdByUserId: string;
  },
): Promise<{ whiteboardId: string; title: string }> {
  const whiteboardId = generateId("WHITEBOARD");
  const now = new Date();
  const title = input.title.trim().slice(0, 200);
  if (!title) throw Errors.VALIDATION("A Whiteboard needs a name");
  await insertDurableWhiteboardWithinLimit(db, {
      id: whiteboardId,
      syncRoomId: whiteboardId,
      spaceId: input.spaceId,
      title,
      status: "active",
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now,
  });
  return { whiteboardId, title };
}

/**
 * Clause 1 of whiteboard authorization: durable Space membership. Every role
 * writes — a Space is a class roster, not a review workflow. Clause 2 (an
 * active Meeting edit grant) is evaluated separately by the grant path.
 *
 * A user's own private board resolves here too: a personal Space carries a real
 * `space_members` row for its owner.
 */
export async function canUserEditWhiteboardDocument(
  db: Database,
  whiteboardId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: spaceMembers.id })
    .from(whiteboards)
    .innerJoin(spaces, eq(spaces.id, whiteboards.spaceId))
    .innerJoin(spaceMembers, eq(spaceMembers.spaceId, whiteboards.spaceId))
    .where(and(
      eq(whiteboards.id, whiteboardId),
      eq(whiteboards.status, "active"),
      isNull(spaces.archivedAt),
      eq(spaceMembers.userId, userId),
    ))
    .limit(1);
  return Boolean(row);
}

export async function canUserReadWhiteboardDocument(
  db: Database,
  whiteboardId: string,
  userId: string,
): Promise<boolean> {
  const [board] = await db
    .select({ spaceId: whiteboards.spaceId })
    .from(whiteboards)
    .innerJoin(spaces, eq(spaces.id, whiteboards.spaceId))
    .where(and(
      eq(whiteboards.id, whiteboardId),
      eq(whiteboards.status, "active"),
      isNull(spaces.archivedAt),
    ))
    .limit(1);
  if (!board) return false;
  const membership = await db.query.spaceMembers.findFirst({
    where: { spaceId: board.spaceId, userId },
    columns: { id: true },
  });
  if (membership) return true;
  const [connection] = await db
    .select({ id: meetingConnections.id })
    .from(meetingConnections)
    .innerJoin(meetingWhiteboards, eq(meetingWhiteboards.meetingId, meetingConnections.meetingId))
    .innerJoin(meetings, eq(meetings.id, meetingConnections.meetingId))
    .where(and(
      eq(meetingWhiteboards.whiteboardId, whiteboardId),
      eq(meetingConnections.userId, userId),
      connectionIsUnfinished(),
      and(eq(meetings.status, "open"), sql`${meetings.closingAt} is null`),
    ))
    .limit(1);
  return Boolean(connection);
}
