import "@tanstack/react-start/server-only";

import type { Database } from "@orbmeet/db";
import {
  meetingConnections,
  meetingLinks,
  meetings,
  spaceDefaultMeetingLinks,
  spaces,
  users,
} from "@orbmeet/db/schema";
import { and, eq } from "drizzle-orm";
import { SCHEDULED_MEETING_EARLY_JOIN_MS } from "@/modules/meetings/contract/constants";

import { getSpaceAccess } from "@/modules/spaces/server/helpers";
import { connectionIsPresent } from "../connection/state";
import { findClaimableSchedule } from "../lifecycle/meeting-occurrence";
import type { RequestFnContext } from "@/app/bootstrap/middleware";

export async function lookupMeetingForRequest(code: string, { db, user }: RequestFnContext) {
  return selectMeetingLookupByCode(db, code, user?.id);
}

export async function selectMeetingLookupByCode(
  db: Database,
  code: string,
  viewerUserId?: string | null,
) {
  const row = await db
    .select({
      meetingLink: {
        id: meetingLinks.id,
        reusePolicy: meetingLinks.reusePolicy,
        spaceId: meetingLinks.spaceId,
        title: meetingLinks.title,
        allowGuests: meetingLinks.allowGuests,
        joinPolicy: meetingLinks.joinPolicy,
        expiresAt: meetingLinks.expiresAt,
        archivedAt: meetingLinks.archivedAt,
      },
      defaultMeetingLinkId: spaceDefaultMeetingLinks.meetingLinkId,
      owner: {
        name: users.name,
      },
      space: {
        id: spaces.id,
        kind: spaces.kind,
        name: spaces.name,
      },
      openMeeting: {
        id: meetings.id,
        title: meetings.title,
        joinPolicy: meetings.joinPolicy,
        allowGuests: meetings.allowGuests,
      },
    })
    .from(meetingLinks)
    .innerJoin(spaces, eq(spaces.id, meetingLinks.spaceId))
    .leftJoin(
      spaceDefaultMeetingLinks,
      and(
        eq(spaceDefaultMeetingLinks.meetingLinkId, meetingLinks.id),
        eq(spaceDefaultMeetingLinks.spaceId, meetingLinks.spaceId),
      ),
    )
    .leftJoin(users, eq(users.id, spaces.ownerUserId))
    .leftJoin(
      meetings,
      and(
        eq(meetings.status, "open"),
        // A link owns its occurrence lineage — the same single predicate
        // `joinMeeting` resolves entry with, so what the pre-join screen
        // advertises is what the join endpoint will act on.
        //
        // Matching shared Spaces space-wide would be equivalent today
        // (`meeting_links_shared_space_unique_idx` allows one link per shared
        // Space and `meetings_link_space_fk` pins a meeting to its link's
        // Space), but it would leave the two predicates free to drift if either
        // index ever relaxed.
        eq(meetings.meetingLinkId, meetingLinks.id),
      ),
    )
    .where(eq(meetingLinks.code, code))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  const meetingLink = row?.meetingLink;
  const isSpaceDefault = Boolean(row?.defaultMeetingLinkId);
  // A schedule gates its dedicated one-time link. Reusable personal and Space
  // links remain available for ad-hoc Meetings outside a scheduled window.
  const schedule = meetingLink?.reusePolicy === "one_time"
    ? await db.query.meetingSchedules.findFirst({
        where: { meetingLinkId: meetingLink.id },
        columns: {
          title: true,
          startsAt: true,
          endsAt: true,
          timeZone: true,
          canceledAt: true,
        },
      })
    : null;
  if (!row || !meetingLink || meetingLink.archivedAt || schedule?.canceledAt) {
    return { exists: false } as const;
  }
  const now = new Date();
  // Expiry only kills a link with no occurrence running; an open meeting must
  // keep reading as joinable even when the link's expiry lapses mid-meeting.
  if (!row.openMeeting && meetingLink.expiresAt && meetingLink.expiresAt < now) {
    return { exists: false } as const;
  }

  // A personal space is not addressable as a space; only shared spaces
  // surface a space identity in lookup results.
  const sharedSpace = row.space.kind === "shared" ? row.space : null;

  // A never-used one-time link is startable only by someone with the space's
  // start capability; once its occurrence has ended the link is consumed and
  // reads as gone.
  if (meetingLink.reusePolicy === "one_time" && !row.openMeeting) {
    const priorMeeting = await db.query.meetings.findFirst({
      where: { meetingLinkId: meetingLink.id },
      columns: { id: true, title: true, status: true },
    });
    if (priorMeeting?.status === "ended") {
      return {
        exists: true,
        ended: true,
        meetingId: priorMeeting.id,
        reusePolicy: meetingLink.reusePolicy,
        title: priorMeeting.title,
        joinPolicy: meetingLink.joinPolicy,
        allowGuests: false,
        hasOpenMeeting: false,
        canStartMeeting: false,
        ownerName: row.owner?.name ?? null,
        spaceId: null,
        spaceName: null,
        requiresAuth: true,
        scheduledStartsAt: schedule?.startsAt.toISOString() ?? null,
        scheduledEndsAt: schedule?.endsAt.toISOString() ?? null,
        scheduledTimeZone: schedule?.timeZone ?? null,
        scheduledNotOpenYet: false,
        viewerAdmissionsInMeeting: [],
      } as const;
    }
  }

  // A reusable link's next meeting takes the title and join policy of the
  // schedule it would claim, exactly as `joinMeeting` starts it.
  const claimedSchedule = !row.openMeeting && meetingLink.reusePolicy === "reusable"
    ? await findClaimableSchedule(db, meetingLink, now)
    : null;

  const scheduledNotOpenYet = Boolean(
    !row.openMeeting
      && schedule
      && now.getTime() < schedule.startsAt.getTime() - SCHEDULED_MEETING_EARLY_JOIN_MS,
  );

  // Starting a meeting is a Space capability, whatever the space kind: the
  // personal space grants it to its owner only.
  let canStartMeeting = false;
  if (!row.openMeeting && viewerUserId) {
    const access = await getSpaceAccess(db, meetingLink.spaceId, viewerUserId);
    canStartMeeting = access?.capabilities.canStartMeetings ?? false;
  }
  if (scheduledNotOpenYet) canStartMeeting = false;

  // The admissions the viewer is in this meeting with right now, on any tab
  // or device. A signed-in person is one participant however many devices
  // they join from, so joining here moves them; the join screen says so first
  // rather than letting the other device be dropped without a word. Ids, not a
  // yes/no: a reloaded tab resumes its own admission, and only the browser
  // knows which one that is (it is kept per tab), so only it can tell "you are
  // in this meeting elsewhere" from "you were in it here a moment ago".
  const viewerAdmissionsInMeeting: string[] = row.openMeeting && viewerUserId
    ? await db
      .selectDistinct({ admissionId: meetingConnections.admissionId })
      .from(meetingConnections)
      .where(and(
        eq(meetingConnections.meetingId, row.openMeeting.id),
        eq(meetingConnections.userId, viewerUserId),
        connectionIsPresent(),
      ))
      .then((rows) => rows.map((connection) => connection.admissionId))
    : [];
  const allowGuests = row.openMeeting?.allowGuests ?? meetingLink.allowGuests;

  return {
    exists: true,
    ended: false,
    reusePolicy: meetingLink.reusePolicy,
    title:
      row.openMeeting?.title ??
      schedule?.title ??
      (claimedSchedule?.title?.trim() || null) ??
      (isSpaceDefault ? row.space.name : meetingLink.title),
    // Open meetings use their snapshot. Editing a reusable meeting link changes
    // the next meeting, not the join policy already in flight.
    joinPolicy: row.openMeeting?.joinPolicy ?? claimedSchedule?.joinPolicy ?? meetingLink.joinPolicy,
    // An open occurrence owns an immutable admission snapshot. Link edits
    // affect only the next occurrence, just like joinPolicy above.
    allowGuests,
    hasOpenMeeting: Boolean(row.openMeeting),
    canStartMeeting,
    ownerName: row.owner?.name ?? null,
    spaceId: sharedSpace?.id ?? null,
    spaceName: sharedSpace?.name ?? null,
    requiresAuth: !allowGuests,
    scheduledStartsAt: schedule?.startsAt.toISOString() ?? null,
    scheduledEndsAt: schedule?.endsAt.toISOString() ?? null,
    scheduledTimeZone: schedule?.timeZone ?? null,
    scheduledNotOpenYet,
    viewerAdmissionsInMeeting,
  } as const;
}
