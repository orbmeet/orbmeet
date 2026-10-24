import type { Database } from "@orbmeet/db";
import { meetings, meetingLinks, meetingSchedules, spaces, users } from "@orbmeet/db/schema";
import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { AppError, Errors } from "@/lib/app-errors";
import { generateId } from "@/lib/ids";
import {
  SCHEDULED_MEETING_EARLY_JOIN_MS,
  SCHEDULED_MEETING_LATE_JOIN_MS,
} from "@/modules/meetings/contract/constants";
import type { PlanLimits } from "@/modules/billing/contract/plan-limits";
import type { SubscriptionTier } from "@/modules/billing/contract/types";

import { getRunChanges, isUniqueConstraintError } from "@/platform/database/db-utils";
import { assertSpaceCapability, retainsSpaceViewerSql } from "@/modules/spaces/server/helpers";

const OPEN_MEETING_COLUMNS = {
  id: true,
  title: true,
  startedByUserId: true,
  spaceId: true,
  spaceKind: true,
  allowGuests: true,
  recordingEnabled: true,
  joinPolicy: true,
  startedAt: true,
  activeEgressId: true,
  activeStreamEgressId: true,
  egressStateRevision: true,
  billingPrincipalType: true,
  billingPrincipalId: true,
  billingPlan: true,
} as const;

interface OpenMeetingOccurrence {
  id: string;
  title: string | null;
  startedByUserId: string | null;
  spaceId: string;
  spaceKind: "personal" | "shared";
  allowGuests: boolean;
  recordingEnabled: boolean;
  joinPolicy: "open" | "approval_required" | "closed";
  startedAt: Date;
  activeEgressId: string | null;
  activeStreamEgressId: string | null;
  egressStateRevision: number;
  billingPrincipalType: "user" | "organization";
  billingPrincipalId: string;
  billingPlan: SubscriptionTier;
}

interface MeetingLinkForOccurrence {
  id: string;
  reusePolicy: "reusable" | "one_time";
  isSpaceDefault: boolean;
  spaceId: string;
  title: string | null;
  allowGuests: boolean;
  joinPolicy: "open" | "approval_required" | "closed";
  expiresAt: Date | null;
}

interface OccurrenceEntitlement {
  billingPrincipal: { type: "user" | "organization"; id: string };
  plan: SubscriptionTier;
  limits: Pick<PlanLimits, "recordingEnabled" | "maxConcurrentMeetings">;
}

interface AcquireMeetingOccurrenceInput {
  meetingLink: MeetingLinkForOccurrence;
  existingMeeting: OpenMeetingOccurrence | null;
  starter: { id: string } | null;
  entitlement: OccurrenceEntitlement;
}

interface AcquireMeetingOccurrenceResult {
  meeting: OpenMeetingOccurrence;
  createdMeetingId: string | null;
}

interface ScheduleForOccurrence {
  id: string;
  title: string | null;
  joinPolicy: "open" | "approval_required" | "closed";
  startsAt: Date;
  endsAt: Date;
}

export async function insertMeetingForLinkWithinLimit(
  db: Database,
  input: {
    meetingId: string;
    meetingLinkId: string;
    title: string | null;
    startedByUserId: string;
    billingPrincipal: { type: "user" | "organization"; id: string };
    billingPlan: SubscriptionTier;
    spaceId: string;
    spaceKind: "personal" | "shared";
    allowGuests: boolean;
    recordingEnabled: boolean;
    joinPolicy: "open" | "approval_required" | "closed";
    startedAt: Date;
    linkExpiresAt: Date | null;
    maxConcurrentMeetings: number | null;
    /** One-time links host exactly one occurrence, open or ended. */
    requireLinkUnused?: boolean;
    meetingScheduleId?: string | null;
  },
): Promise<boolean> {
  const startedAtSeconds = Math.floor(input.startedAt.getTime() / 1000);
  const billingPrincipal = input.billingPrincipal;
  const capacityCondition =
    input.maxConcurrentMeetings === null
      ? sql`1 = 1`
      : sql`(
        select count(*)
        from ${meetings}
        where ${meetings.billingPrincipalType} = ${billingPrincipal.type}
          and ${meetings.billingPrincipalId} = ${billingPrincipal.id}
          and ${meetings.status} = 'open'
      ) < ${input.maxConcurrentMeetings}`;
  const activeLinkCondition = sql`exists (
    select 1 from ${meetingLinks}
    where ${meetingLinks.id} = ${input.meetingLinkId}
      and ${meetingLinks.archivedAt} is null
      and ${meetingLinks.spaceId} = ${input.spaceId}
      and (${meetingLinks.reusePolicy} = 'reusable' or ${meetingLinks.spentAt} is null)
      and (${meetingLinks.expiresAt} is null or ${meetingLinks.expiresAt} >= ${startedAtSeconds})
  )`;
  const activeSpaceCondition = sql`exists (
    select 1 from ${spaces}
    where ${spaces.id} = ${input.spaceId}
      and ${spaces.archivedAt} is null
  )`;
  // The starter's authority is read before the insert, and a removal can land
  // in between. Fenced here too, so a starter removed from the Space cannot
  // still open an occurrence (and claim its schedule). Starting a meeting is
  // exactly the Space's viewer capability: a shared Space's members, a
  // personal Space's owner.
  const starterAuthorityCondition = retainsSpaceViewerSql(input.spaceId, input.startedByUserId);
  // Shared Spaces have one durable link and one live Meeting slot. Personal
  // spaces are an ownership boundary for many independent links, so their
  // concurrency is governed by the billing principal's plan instead.
  const noOpenSpaceMeetingCondition =
    input.spaceKind === "shared"
      ? sql`not exists (
        select 1 from ${meetings}
        where ${meetings.spaceId} = ${input.spaceId}
          and ${meetings.status} = 'open'
      )`
      : sql`1 = 1`;
  const linkUnusedCondition = input.requireLinkUnused
    ? sql`not exists (
        select 1 from ${meetings}
        where ${meetings.meetingLinkId} = ${input.meetingLinkId}
      )`
    : sql`1 = 1`;
  const scheduledWindowCondition = input.meetingScheduleId
    ? sql`exists (
      select 1 from ${meetingSchedules}
      where ${meetingSchedules.id} = ${input.meetingScheduleId}
        and ${meetingSchedules.meetingLinkId} = ${input.meetingLinkId}
        and ${meetingSchedules.meetingId} is null
        and ${meetingSchedules.canceledAt} is null
        and ${meetingSchedules.startsAt}
          <= ${startedAtSeconds + Math.floor(SCHEDULED_MEETING_EARLY_JOIN_MS / 1000)}
        and ${meetingSchedules.endsAt}
          >= ${startedAtSeconds - Math.floor(SCHEDULED_MEETING_LATE_JOIN_MS / 1000)}
    )`
    : sql`1 = 1`;

  // Gated insert. The query-builder select maps columns by name, so this stays
  // independent of the table's physical column order.
  const [meetingResult] = await db.batch([
    db.insert(meetings).select(
      db
        .select({
          id: sql`${input.meetingId}`.as("id"),
          meetingLinkId: sql`${input.meetingLinkId}`.as("meeting_link_id"),
          title: sql`${input.title}`.as("title"),
          startedByUserId: sql`${input.startedByUserId}`.as("started_by_user_id"),
          // The organizer of the schedule this occurrence claims; the schedule
          // claim below is fenced on the same conditions.
          organizerUserId: input.meetingScheduleId
            ? sql`(select ${meetingSchedules.organizerUserId} from ${meetingSchedules}
                where ${meetingSchedules.id} = ${input.meetingScheduleId})`.as("organizer_user_id")
            : sql`null`.as("organizer_user_id"),
          spaceId: sql`${input.spaceId}`.as("space_id"),
          spaceKind: sql`${input.spaceKind}`.as("space_kind"),
          status: sql`'open'`.as("status"),
          allowGuests: sql`${input.allowGuests ? 1 : 0}`.as("allow_guests"),
          recordingEnabled: sql`${input.recordingEnabled ? 1 : 0}`.as("recording_enabled"),
          // The starter's account default, read in the same statement.
          transcriptionEnabled: sql`coalesce((
            select ${users.transcribeMeetings} from ${users} where ${users.id} = ${input.startedByUserId}
          ), 1)`.as("transcription_enabled"),
          joinPolicy: sql`${input.joinPolicy}`.as("join_policy"),
          activeEgressId: sql`null`.as("active_egress_id"),
          activeStreamEgressId: sql`null`.as("active_stream_egress_id"),
          egressStateRevision: sql`0`.as("egress_state_revision"),
          startedAt: sql`${startedAtSeconds}`.as("started_at"),
          endedAt: sql`null`.as("ended_at"),
          retainUntil: sql`null`.as("retain_until"),
          transcriptSegmentCount: sql`0`.as("transcript_segment_count"),
          transcriptLastIngestedAt: sql`null`.as("transcript_last_ingested_at"),
          updatedAt: sql`${startedAtSeconds}`.as("updated_at"),
          billingPrincipalType: sql`${billingPrincipal.type}`.as("billing_principal_type"),
          billingPrincipalId: sql`${billingPrincipal.id}`.as("billing_principal_id"),
          billingPlan: sql`${input.billingPlan}`.as("billing_plan"),
        })
        .from(sql`(select 1)`).where(sql`${capacityCondition}
            and ${activeSpaceCondition}
            and ${starterAuthorityCondition}
            and ${noOpenSpaceMeetingCondition}
            and ${linkUnusedCondition}
            and ${activeLinkCondition}
            and ${scheduledWindowCondition}`),
    ),
    db.update(meetingLinks).set({
      lastUsedAt: input.startedAt,
      updatedAt: input.startedAt,
      // A one-time link is spent by the occurrence it mints. The guarded
      // insert above and this write share the batch, so a spent link makes
      // both statements zero-row no-ops rather than a second meeting.
      ...(input.requireLinkUnused ? { spentAt: input.startedAt } : {}),
      ...(input.linkExpiresAt ? { expiresAt: input.linkExpiresAt } : {}),
    }).where(sql`
          ${meetingLinks.id} = ${input.meetingLinkId}
          and exists (
            select 1 from ${meetings}
            where ${meetings.id} = ${input.meetingId}
          )
        `),
    db
      .update(meetingSchedules)
      .set({ meetingId: input.meetingId, updatedAt: input.startedAt })
      .where(
        and(
          eq(meetingSchedules.id, input.meetingScheduleId ?? ""),
          isNull(meetingSchedules.meetingId),
          isNull(meetingSchedules.canceledAt),
          sql`exists (
            select 1 from ${meetings}
            where ${meetings.id} = ${input.meetingId}
          )`,
        ),
      ),
  ]);

  return getRunChanges(meetingResult) > 0;
}

export async function acquireMeetingOccurrence(
  db: Database,
  input: AcquireMeetingOccurrenceInput,
): Promise<AcquireMeetingOccurrenceResult> {
  if (input.existingMeeting) {
    return { meeting: input.existingMeeting, createdMeetingId: null };
  }

  const { meetingLink, starter, entitlement } = input;
  if (meetingLink.reusePolicy === "one_time") {
    const priorMeeting = await db.query.meetings.findFirst({
      where: { meetingLinkId: meetingLink.id },
      columns: { id: true },
    });
    if (priorMeeting) throw Errors.MEETING_ENDED();
  }

  // Starting a meeting is a Space capability, whatever the space kind: the
  // personal space grants it to its owner only.
  if (!starter) throw Errors.MEETING_NOT_STARTED();
  await assertSpaceCapability(db, meetingLink.spaceId, starter.id, "canStartMeetings").catch(
    (error: unknown) => {
      // Hide authorization details from link visitors, but do not disguise a
      // database/provider outage as a normal "wait for the host" response.
      if (error instanceof AppError && error.code === "FORBIDDEN") {
        throw Errors.MEETING_NOT_STARTED();
      }
      throw error;
    },
  );
  const startedByUserId = starter.id;

  const space = await db.query.spaces.findFirst({
    where: { id: meetingLink.spaceId },
    columns: { kind: true, name: true },
  });
  if (!space) throw Errors.NOT_FOUND("Meeting");

  const { limits } = entitlement;
  const now = new Date();
  const schedule = await findScheduleForOccurrence(db, meetingLink, now);
  // A Meeting title names this bounded occurrence, never its containing Space.
  // Null intentionally means the UI renders a localized date/time fallback.
  const title =
    schedule?.title?.trim() ||
    (meetingLink.isSpaceDefault ? null : meetingLink.title?.trim() || null);
  const meetingId = generateId("MEETING");
  try {
    const created = await insertMeetingForLinkWithinLimit(db, {
      meetingId,
      meetingLinkId: meetingLink.id,
      title,
      startedByUserId,
      billingPrincipal: entitlement.billingPrincipal,
      billingPlan: entitlement.plan,
      spaceId: meetingLink.spaceId,
      spaceKind: space.kind,
      // Guest entry is a personal-space capability; a shared-space meeting is
      // member-guarded regardless of its link's flag.
      allowGuests: space.kind === "personal" && meetingLink.allowGuests,
      // Recording availability is purely a plan capability, snapshotted at
      // occurrence start — links and schedules no longer carry a user choice.
      recordingEnabled: limits.recordingEnabled,
      joinPolicy: schedule?.joinPolicy ?? meetingLink.joinPolicy,
      startedAt: now,
      linkExpiresAt: meetingLink.reusePolicy === "reusable" ? null : meetingLink.expiresAt,
      maxConcurrentMeetings: limits.maxConcurrentMeetings,
      requireLinkUnused: meetingLink.reusePolicy === "one_time",
      meetingScheduleId: schedule?.id ?? null,
    });
    if (created) {
      // Whiteboard document and surface state are both created lazily. A
      // A Meeting that never opens a Whiteboard leaves no Whiteboard records.
      const meeting = await db.query.meetings.findFirst({
        where: { id: meetingId },
        columns: OPEN_MEETING_COLUMNS,
      });
      if (!meeting) throw Errors.NOT_FOUND("Meeting");
      return { meeting, createdMeetingId: meetingId };
    }

    const meeting = await diagnoseOccurrenceInsertDecline(
      db,
      meetingLink,
      startedByUserId,
      limits,
      schedule?.id ?? null,
    );
    return { meeting, createdMeetingId: null };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (!isUniqueConstraintError(error)) throw error;
    const meeting = await findOpenMeetingForEntry(db, meetingLink);
    if (!meeting) throw error;
    return { meeting, createdMeetingId: null };
  }
}

async function diagnoseOccurrenceInsertDecline(
  db: Database,
  meetingLink: MeetingLinkForOccurrence,
  startedByUserId: string,
  limits: OccurrenceEntitlement["limits"],
  meetingScheduleId: string | null,
): Promise<OpenMeetingOccurrence> {
  const openMeeting = await findOpenMeetingForEntry(db, meetingLink);
  if (openMeeting) return openMeeting;

  if (meetingLink.reusePolicy === "one_time") {
    const consumed = await db.query.meetings.findFirst({
      where: { meetingLinkId: meetingLink.id },
      columns: { id: true },
    });
    if (consumed) throw Errors.MEETING_ENDED();
  }
  const activeSpace = await db.query.spaces.findFirst({
    where: {
      RAW: (row) => and(eq(row.id, meetingLink.spaceId), isNull(row.archivedAt))!,
    },
    columns: { id: true },
  });
  if (!activeSpace) throw Errors.NOT_FOUND("Meeting");
  // Lost between the capability check and the insert: answered as that check
  // answers a visitor who cannot start the meeting.
  const starter = await db.get<{ retained: number }>(
    sql`select ${retainsSpaceViewerSql(meetingLink.spaceId, startedByUserId)} as retained`,
  );
  if (!starter?.retained) throw Errors.MEETING_NOT_STARTED();
  const activeLink = await db.query.meetingLinks.findFirst({
    where: { RAW: (row) => and(eq(row.id, meetingLink.id), isNull(row.archivedAt))! },
    columns: { id: true, expiresAt: true },
  });
  if (!activeLink || (activeLink.expiresAt && activeLink.expiresAt < new Date())) {
    throw Errors.NOT_FOUND("Meeting");
  }
  // The gated insert also fences on the schedule window, which the organizer
  // can move or cancel between this joiner reading the schedule and the insert
  // running. Diagnose it before the plan branch, or a scheduling race is
  // reported to the joiner as a billing problem on a plan with zero open
  // meetings.
  if (meetingScheduleId) {
    // The same three conditions the gated insert fences on, including the time
    // window. Checking only "unclaimed and not canceled" diagnosed a
    // cancellation but not a reschedule: an organizer moving the meeting while
    // someone was joining left this to fall through to the plan branch, which
    // reported a scheduling race as a billing limit.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const claimableSchedule = await db.query.meetingSchedules.findFirst({
      where: {
        RAW: (row) =>
          and(
            eq(row.id, meetingScheduleId),
            isNull(row.meetingId),
            isNull(row.canceledAt),
            lte(
              row.startsAt,
              new Date((nowSeconds + Math.floor(SCHEDULED_MEETING_EARLY_JOIN_MS / 1000)) * 1000),
            ),
            gte(
              row.endsAt,
              new Date((nowSeconds - Math.floor(SCHEDULED_MEETING_LATE_JOIN_MS / 1000)) * 1000),
            ),
          )!,
      },
      columns: { id: true },
    });
    if (!claimableSchedule) throw Errors.MEETING_NOT_STARTED();
  }
  if (limits.maxConcurrentMeetings !== null) {
    throw Errors.PLAN_LIMIT_REACHED(
      `Maximum ${limits.maxConcurrentMeetings} concurrent meeting(s) on your plan`,
    );
  }
  throw Errors.CONFLICT("The meeting could not be started. Please try again.");
}

async function findOpenMeetingForEntry(
  db: Database,
  meetingLink: Pick<MeetingLinkForOccurrence, "id">,
): Promise<OpenMeetingOccurrence | null> {
  // A link owns its occurrence lineage. Shared Spaces enforce their separate
  // one-open-Meeting invariant at the schema and insertion boundaries.
  return (
    (await db.query.meetings.findFirst({
      where: {
        RAW: (row) => and(eq(row.meetingLinkId, meetingLink.id), eq(row.status, "open"))!,
      },
      columns: OPEN_MEETING_COLUMNS,
    })) ?? null
  );
}

async function findScheduleForOccurrence(
  db: Database,
  meetingLink: MeetingLinkForOccurrence,
  now: Date,
): Promise<ScheduleForOccurrence | null> {
  const schedule = await findClaimableSchedule(db, meetingLink, now);
  if (
    schedule &&
    meetingLink.reusePolicy === "one_time" &&
    now.getTime() < schedule.startsAt.getTime() - SCHEDULED_MEETING_EARLY_JOIN_MS
  ) {
    throw Errors.MEETING_NOT_STARTED();
  }
  return schedule;
}

/**
 * The schedule a meeting started through this link now would claim, and so
 * take its title and join policy from. The pre-join lookup asks the same
 * question, so what it shows is what the join does.
 */
export async function findClaimableSchedule(
  db: Database,
  meetingLink: Pick<MeetingLinkForOccurrence, "id" | "reusePolicy">,
  now: Date,
): Promise<ScheduleForOccurrence | null> {
  const earlyBoundary = new Date(now.getTime() + SCHEDULED_MEETING_EARLY_JOIN_MS);
  const lateBoundary = new Date(now.getTime() - SCHEDULED_MEETING_LATE_JOIN_MS);
  const schedule = await db.query.meetingSchedules.findFirst({
    where: {
      RAW: (row) =>
        and(
          eq(row.meetingLinkId, meetingLink.id),
          isNull(row.meetingId),
          isNull(row.canceledAt),
          gte(row.endsAt, lateBoundary),
          meetingLink.reusePolicy === "reusable" ? lte(row.startsAt, earlyBoundary) : undefined,
        )!,
    },
    columns: {
      id: true,
      title: true,
      joinPolicy: true,
      startsAt: true,
      endsAt: true,
    },
    // The same reusable personal or Space link can have yesterday's missed
    // occurrence and today's imminent occurrence inside the late/early windows.
    // The newest eligible start is the occurrence the entrant is actually joining.
    orderBy: (row) => [desc(row.startsAt)],
  });
  return schedule ?? null;
}
