/**
 * Server implementations behind the RPC declarations in this directory.
 * Split from the sibling RPC file so the declaration file carries no
 * DB/Drizzle imports and stays safe to include in client route graphs.
 */

import type { Database } from "@orbmeet/db";
import { decodeKeysetCursor, encodeKeysetCursor } from "@/lib/keyset-cursor";
import { meetingLinks, meetings, meetingScheduleAttendees, meetingSchedules, spaceMembers, spaces, users, userContacts } from "@orbmeet/db/schema";
import { and, asc, eq, exists, gt, gte, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { AppError } from "@/lib/app-errors";
import { normalizeEmail } from "@/modules/identity/contract/auth/email-normalization";
import { SCHEDULED_MEETING_LATE_JOIN_MS } from "@/modules/meetings/contract/constants";
import type { AutomationScheduleSelector } from "@orbmeet/public-api-contract";
import { d1UnicodeContains } from "@/platform/database/d1-unicode-like";
import { retainsSpaceManagerSql } from "@/modules/spaces/server/helpers";
import { utcBoundsForLocalDate } from "@/lib/local-date-bounds";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import type { GetMyUpcomingMeetingSchedulesInput } from "./queries.functions";

const MAX_SELECTOR_CANDIDATES = 51;
const DEFAULT_PUBLIC_SCHEDULE_PAGE_SIZE = 50;
const MAX_PUBLIC_SCHEDULE_PAGE_SIZE = 100;

type ScheduleCursor = { startsAt: Date; id: string };

function encodeScheduleCursor(cursor: ScheduleCursor): string {
  return encodeKeysetCursor({ at: cursor.startsAt, id: cursor.id });
}

export function decodeScheduleCursor(value: string): ScheduleCursor | null {
  const cursor = decodeKeysetCursor(value);
  return cursor && { startsAt: cursor.at, id: cursor.id };
}

function serializeSchedule(
  row: {
    id: string;
    meetingLinkId: string;
    meetingLinkReusePolicy: "reusable" | "one_time";
    organizerUserId: string;
    spaceId: string;
    spaceKind: "personal" | "shared" | null;
    spaceName: string | null;
    title: string | null;
    startsAt: Date;
    endsAt: Date;
    timeZone: string;
    reminderMinutesBefore: number | null;
    revision: number;
    canceledAt: Date | null;
    cancelReason: string | null;
    code: string;
    organizerName: string;
    meetingId: string | null;
    meetingStatus: "open" | "ended" | null;
    linkExpiresAt: Date | null;
    canManageSpace: number;
    organizerIsCurrentMember: number;
  },
  viewerUserId: string,
  attendees: Array<{
    id: string;
    userId: string | null;
    email: string;
    displayName: string | null;
  }>,
  now = new Date(),
) {
  const state = row.canceledAt
    ? "canceled"
    : row.meetingStatus === "open"
      ? "open"
      : row.meetingStatus === "ended"
        ? "completed"
        : row.endsAt < now
          ? "late_start"
          : "upcoming";
  const isOrganizer = row.organizerUserId === viewerUserId;
  const isPersonalSchedule = row.spaceKind === "personal";
  const hasCurrentAuthority = row.canManageSpace === 1;
  return {
    id: row.id,
    meetingLinkId: row.meetingLinkId,
    meetingLinkReusePolicy: row.meetingLinkReusePolicy,
    meetingId: row.meetingId,
    code: row.code,
    title: row.title,
    organizerUserId: row.organizerUserId,
    // The personal space is not addressable as a space in client payloads.
    spaceId: row.spaceKind === "shared" ? row.spaceId : null,
    spaceName: row.spaceKind === "shared" ? row.spaceName : null,
    organizerName: row.organizerName,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    timeZone: row.timeZone,
    reminderMinutesBefore: row.reminderMinutesBefore,
    revision: row.revision,
    state,
    canceledAt: row.canceledAt?.toISOString() ?? null,
    cancelReason: row.cancelReason,
    canManage:
      hasCurrentAuthority &&
      (isOrganizer || row.organizerIsCurrentMember === 0) &&
      (state === "upcoming" || state === "late_start"),
    attendeeCount: attendees.length,
    // Invitee identities stay between the organizer and their own schedule;
    // shared-space schedules expose only the count.
    attendees: isOrganizer && isPersonalSchedule ? attendees : [],
  };
}

async function selectScheduleRows(
  db: Database,
  filters: {
    viewerUserId: string;
    viewerEmail: string;
    scheduleId?: string;
    spaceId?: string;
    now?: Date;
    selector?: AutomationScheduleSelector;
    limit?: number;
    manageableOnly?: boolean;
    includeCanceled?: boolean;
    excludeCompleted?: boolean;
    cursor?: ScheduleCursor | undefined;
  },
) {
  const normalizedViewerEmail = normalizeEmail(filters.viewerEmail);
  const bounds = filters.selector?.date
    ? utcBoundsForLocalDate(filters.selector.date, filters.selector.timeZone)
    : null;
  const titleQuery = filters.selector?.title ?? null;
  const spaceQuery = filters.selector?.space ?? null;
  const participantQuery = filters.selector?.participant ?? null;
  return db
    .select({
      id: meetingSchedules.id,
      meetingLinkId: meetingSchedules.meetingLinkId,
      meetingLinkReusePolicy: meetingLinks.reusePolicy,
      organizerUserId: meetingSchedules.organizerUserId,
      spaceId: meetingSchedules.spaceId,
      spaceKind: spaces.kind,
      spaceName: spaces.name,
      title: meetingSchedules.title,
      startsAt: meetingSchedules.startsAt,
      endsAt: meetingSchedules.endsAt,
      timeZone: meetingSchedules.timeZone,
      reminderMinutesBefore: meetingSchedules.reminderMinutesBefore,
      revision: meetingSchedules.revision,
      canceledAt: meetingSchedules.canceledAt,
      cancelReason: meetingSchedules.cancelReason,
      code: meetingLinks.code,
      organizerName: users.name,
      meetingId: meetings.id,
      meetingStatus: meetings.status,
      linkExpiresAt: meetingLinks.expiresAt,
      // The personal space's owner membership makes this one rule cover both
      // kinds: a personal schedule is managed by the personal space owner.
      canManageSpace: sql<number>`case when ${retainsSpaceManagerSql(
        meetingSchedules.spaceId,
        filters.viewerUserId,
      )} then 1 else 0 end`,
      organizerIsCurrentMember: sql<number>`case when exists (
        select 1 from ${spaceMembers} organizer_membership
        where organizer_membership.space_id = ${meetingSchedules.spaceId}
          and organizer_membership.user_id = ${meetingSchedules.organizerUserId}
      ) then 1 else 0 end`,
    })
    .from(meetingSchedules)
    .innerJoin(meetingLinks, eq(meetingLinks.id, meetingSchedules.meetingLinkId))
    .innerJoin(users, eq(users.id, meetingSchedules.organizerUserId))
    .leftJoin(spaces, eq(spaces.id, meetingSchedules.spaceId))
    .leftJoin(meetings, eq(meetings.id, meetingSchedules.meetingId))
    .where(
      and(
        filters.scheduleId ? eq(meetingSchedules.id, filters.scheduleId) : undefined,
        filters.spaceId ? eq(meetingSchedules.spaceId, filters.spaceId) : undefined,
        filters.cursor
          ? or(
              gt(meetingSchedules.startsAt, filters.cursor.startsAt),
              and(
                eq(meetingSchedules.startsAt, filters.cursor.startsAt),
                gt(meetingSchedules.id, filters.cursor.id),
              ),
            )
          : undefined,
        bounds ? gte(meetingSchedules.startsAt, bounds.earliest) : undefined,
        bounds ? lt(meetingSchedules.startsAt, bounds.latest) : undefined,
        titleQuery ? d1UnicodeContains(meetingSchedules.title, titleQuery) : undefined,
        spaceQuery
          ? // The personal space is never addressed by name; the selector only
            // matches shared spaces.
            and(
              eq(spaces.kind, "shared"),
              d1UnicodeContains(spaces.name, spaceQuery),
            )
          : undefined,
        participantQuery
          ? exists(
              db
                .select({ id: meetingScheduleAttendees.id })
                .from(meetingScheduleAttendees)
                .where(
                  and(
                    eq(meetingScheduleAttendees.scheduleId, meetingSchedules.id),
                    or(
                      d1UnicodeContains(meetingScheduleAttendees.displayName, participantQuery),
                      d1UnicodeContains(visibleAttendeeEmail(), participantQuery),
                    ),
                  ),
                ),
            )
          : undefined,
        filters.manageableOnly
          ? and(
              retainsSpaceManagerSql(meetingSchedules.spaceId, filters.viewerUserId),
              or(
                eq(meetingSchedules.organizerUserId, filters.viewerUserId),
                sql`not exists (
                  select 1 from ${spaceMembers} departed_organizer
                  where departed_organizer.space_id = ${meetingSchedules.spaceId}
                    and departed_organizer.user_id = ${meetingSchedules.organizerUserId}
                )`,
              ),
              or(isNull(meetings.id), eq(meetings.status, "open")),
            )
          : undefined,
        filters.now
          ? or(
              eq(meetings.status, "open"),
              and(
                isNull(meetingLinks.archivedAt),
                or(
                  // Away from an open occurrence there are three visibility
                  // windows. Shared schedules advertise a permanent Space
                  // link, so the occurrence's own late-start window is their
                  // visibility boundary — otherwise missed schedules would
                  // live forever. Personal schedules keep the same boundary:
                  // visible while their link is unexpired, or while the
                  // occurrence itself is within that late-start window.
                  // One-time links expire exactly at window end, and reusable
                  // links carry no expiry at all — a NULL `expiresAt` fails
                  // the >= check in SQLite, so those fall through to the
                  // occurrence window and stay visible exactly as long as a
                  // shared schedule would be.
                  and(
                    eq(spaces.kind, "shared"),
                    gte(
                      meetingSchedules.endsAt,
                      new Date(filters.now.getTime() - SCHEDULED_MEETING_LATE_JOIN_MS),
                    ),
                  ),
                  and(
                    eq(spaces.kind, "personal"),
                    or(
                      gte(meetingLinks.expiresAt, filters.now),
                      gte(
                        meetingSchedules.endsAt,
                        new Date(filters.now.getTime() - SCHEDULED_MEETING_LATE_JOIN_MS),
                      ),
                    ),
                  ),
                ),
              ),
            )
          : undefined,
        filters.includeCanceled ? undefined : isNull(meetingSchedules.canceledAt),
        filters.excludeCompleted
          ? or(isNull(meetings.status), ne(meetings.status, "ended"))
          : undefined,
        or(
          and(
            eq(spaces.kind, "shared"),
            exists(
              db
                .select({ id: spaceMembers.id })
                .from(spaceMembers)
                .where(
                  and(
                    eq(spaceMembers.spaceId, meetingSchedules.spaceId),
                    eq(spaceMembers.userId, filters.viewerUserId),
                  ),
                ),
            ),
          ),
          and(
            eq(spaces.kind, "personal"),
            or(
              eq(meetingSchedules.organizerUserId, filters.viewerUserId),
              exists(
                db
                  .select({ id: meetingScheduleAttendees.id })
                  .from(meetingScheduleAttendees)
                  .where(
                    and(
                      eq(meetingScheduleAttendees.scheduleId, meetingSchedules.id),
                      or(
                        eq(meetingScheduleAttendees.userId, filters.viewerUserId),
                        eq(meetingScheduleAttendees.normalizedEmail, normalizedViewerEmail),
                      ),
                    ),
                  ),
              ),
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(meetingSchedules.startsAt), asc(meetingSchedules.id))
    .limit(filters.scheduleId ? 1 : (filters.limit ?? 50));
}

/**
 * An attendee's email as a schedule may show it: empty for an account holder
 * the organizer has no contact email for, whose address the organizer never
 * supplied. Shown and searched through this one expression, so a search can
 * never match an address the results would hide. Correlated with the
 * enclosing query's `meeting_schedules` row.
 */
function visibleAttendeeEmail(): SQL<string> {
  return sql<string>`case when ${meetingScheduleAttendees.userId} is not null and not exists (
      select 1 from ${userContacts} private_contact
      where private_contact.owner_user_id = ${meetingSchedules.organizerUserId}
        and private_contact.contact_user_id = ${meetingScheduleAttendees.userId}
        and private_contact.email is not null
    ) then '' else ${meetingScheduleAttendees.email} end`;
}

async function loadAttendees(db: Database, scheduleIds: string[]) {
  if (scheduleIds.length === 0)
    return new Map<string, Awaited<ReturnType<typeof selectAttendees>>>();
  const rows = await selectAttendees(db, scheduleIds);
  const bySchedule = new Map<string, typeof rows>();
  for (const attendee of rows) {
    const bucket = bySchedule.get(attendee.scheduleId) ?? [];
    bucket.push(attendee);
    bySchedule.set(attendee.scheduleId, bucket);
  }
  return bySchedule;
}

function selectAttendees(db: Database, scheduleIds: string[]) {
  return db
    .select({
      id: meetingScheduleAttendees.id,
      scheduleId: meetingScheduleAttendees.scheduleId,
      userId: meetingScheduleAttendees.userId,
      email: visibleAttendeeEmail(),
      displayName: meetingScheduleAttendees.displayName,
    })
    .from(meetingScheduleAttendees)
    .innerJoin(meetingSchedules, eq(meetingSchedules.id, meetingScheduleAttendees.scheduleId))
    .where(inArray(meetingScheduleAttendees.scheduleId, scheduleIds));
}

export async function getMyUpcomingMeetingSchedulesImpl({
  data,
  context: { user, db },
}: {
  data: GetMyUpcomingMeetingSchedulesInput;
  context: AuthFnContext;
}) {
  let cursor: ScheduleCursor | undefined;
  if (data.cursor) {
    cursor = decodeScheduleCursor(data.cursor) ?? undefined;
    if (!cursor) throw new AppError("VALIDATION_ERROR", "Invalid schedule cursor", 400);
  }
  return listMeetingSchedulesPageForUser(db, user, {
    cursor,
    limit: 50,
    spaceId: data.spaceId,
  });
}

export async function listMeetingSchedulesPageForUser(
  db: Database,
  user: { id: string; email: string },
  options: {
    cursor?: ScheduleCursor | undefined;
    limit?: number | undefined;
    now?: Date | undefined;
    spaceId?: string | undefined;
  } = {},
) {
  const now = options.now ?? new Date();
  const limit = Math.min(
    MAX_PUBLIC_SCHEDULE_PAGE_SIZE,
    Math.max(1, options.limit ?? DEFAULT_PUBLIC_SCHEDULE_PAGE_SIZE),
  );
  const rows = await selectScheduleRows(db, {
    viewerUserId: user.id,
    viewerEmail: user.email,
    now,
    cursor: options.cursor,
    spaceId: options.spaceId,
    limit: limit + 1,
    excludeCompleted: true,
  });
  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
  const attendees = await loadAttendees(
    db,
    pageRows.map((row) => row.id),
  );
  const schedules = pageRows.map((row) =>
    serializeSchedule(row, user.id, attendees.get(row.id) ?? [], now),
  );
  const last = pageRows.at(-1);
  return {
    schedules,
    nextCursor:
      hasNextPage && last ? encodeScheduleCursor({ startsAt: last.startsAt, id: last.id }) : null,
  };
}

export async function resolveManageableMeetingScheduleForUser(
  db: Database,
  user: { id: string; email: string },
  selector: AutomationScheduleSelector,
  now = new Date(),
  options: { includeCanceled?: boolean } = {},
) {
  const rows = await selectScheduleRows(db, {
    viewerUserId: user.id,
    viewerEmail: user.email,
    now,
    selector,
    limit: MAX_SELECTOR_CANDIDATES,
    manageableOnly: true,
    includeCanceled: options.includeCanceled,
  });
  const selectorWindowSaturated = rows.length === MAX_SELECTOR_CANDIDATES;
  const attendees = await loadAttendees(
    db,
    rows.map((row) => row.id),
  );
  const schedules = rows.map((row) =>
    serializeSchedule(row, user.id, attendees.get(row.id) ?? [], now),
  );
  const candidates = schedules.filter(
    (schedule) => schedule.canManage || (options.includeCanceled && schedule.state === "canceled"),
  );

  if (candidates.length === 0 && !selectorWindowSaturated) {
    throw new AppError(
      "SCHEDULE_NOT_FOUND",
      "No manageable scheduled meeting matches those details",
      404,
      { selector },
    );
  }
  if (candidates.length > 1 || selectorWindowSaturated) {
    throw new AppError(
      "AMBIGUOUS_SCHEDULE",
      selectorWindowSaturated
        ? "Too many scheduled meetings match those details; add another detail to narrow the search"
        : "More than one scheduled meeting matches those details",
      409,
      {
        selector,
        candidates: candidates.slice(0, 10).map((candidate) => ({
          title: candidate.title,
          startsAt: candidate.startsAt,
          timeZone: candidate.timeZone,
          spaceName: candidate.spaceName,
          participants: candidate.attendees.map(
            (attendee) => attendee.displayName ?? attendee.email,
          ),
        })),
        moreCandidates: selectorWindowSaturated || candidates.length > 10,
      },
    );
  }
  return candidates[0];
}

export async function findMeetingScheduleForUser(
  db: Database,
  user: { id: string; email: string },
  scheduleId: string,
  options: { includeCanceled?: boolean } = {},
) {
  const rows = await selectScheduleRows(db, {
    viewerUserId: user.id,
    viewerEmail: user.email,
    scheduleId,
    includeCanceled: options.includeCanceled,
  });
  const row = rows[0];
  if (!row) return null;
  const attendees = await loadAttendees(db, [row.id]);
  return serializeSchedule(row, user.id, attendees.get(row.id) ?? []);
}
