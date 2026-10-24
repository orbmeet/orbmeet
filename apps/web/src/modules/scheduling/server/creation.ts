import type { Database } from "@orbmeet/db";
import { meetingLinks, spaceMembers, spaces, users } from "@orbmeet/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { Errors } from "@/lib/app-errors";
import type { AuthenticatedUser } from "@/modules/identity/contract/auth/session-user";

import { logError } from "@/lib/logger";
import { rememberInvitedContacts } from "@/modules/contacts/server/contact-index";
import { getSpaceAccess } from "@/modules/spaces/server/helpers";
import {
  createMeetingScheduleRecord,
  loadIdempotentMeetingScheduleCreate,
  meetingScheduleCreateFingerprint,
  type CreateMeetingScheduleInput,
} from "./commands";
import {ensureSpaceDefaultMeetingLink} from "@/modules/meetings/server/space-default-meeting-link.server";

export async function createMeetingScheduleForUser(
  db: Database,
  organizer: AuthenticatedUser,
  input: CreateMeetingScheduleInput,
) {
  const idempotencyFingerprint = input.idempotencyKey
    ? input.idempotencyFingerprint ?? await meetingScheduleCreateFingerprint(input)
    : undefined;
  const prior = await loadIdempotentMeetingScheduleCreate(
    db,
    organizer.id,
    input.idempotencyKey,
    idempotencyFingerprint,
  );
  if (prior) {
    if (!input.spaceId) {
      await rememberInvitedContacts(db, organizer, input.attendees).catch((error) => {
        logError("[scheduling] Failed to update the organizer contact index", error);
      });
    }
    return prior;
  }
  let attendees = input.attendees;
  let title = input.title;
  let spaceMeetingLink: { id: string; code: string } | undefined;
  let personalMeetingLink: { id: string; code: string } | undefined;
  let spaceName: string | undefined;

  if (input.spaceId && input.meetingLinkId) {
    throw Errors.VALIDATION("Choose either a Space or a personal meeting link");
  }

  if (input.spaceId) {
    if (input.attendees.length > 0) {
      throw Errors.VALIDATION(
        "Space meetings invite Space members; additional email guests are not supported",
      );
    }
    const access = await getSpaceAccess(db, input.spaceId, organizer.id);
    if (!access?.capabilities.canManage) throw Errors.NOT_FOUND("Space");
    const space = await db.query.spaces.findFirst({
      where: { RAW: (row) => and(eq(row.id, input.spaceId!), isNull(row.archivedAt))! },
      columns: { id: true, name: true },
    });
    if (!space) throw Errors.NOT_FOUND("Space");
    attendees = await db
      .select({ email: users.email, displayName: users.name })
      .from(spaceMembers)
      .innerJoin(users, eq(users.id, spaceMembers.userId))
      .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
      .where(and(eq(spaceMembers.spaceId, space.id), isNull(spaces.archivedAt)));
    // Space names and schedule titles share the same 200-character DB bound;
    // reserve room for the generated suffix instead of producing an invalid
    // row for a valid long Space name.
    title ||= `${Array.from(space.name).slice(0, 192).join("")} meeting`;
    spaceMeetingLink = await ensureSpaceDefaultMeetingLink(db, space.id);
    spaceName = space.name;
  } else if (input.meetingLinkId) {
    const link = await db
      .select({
        id: meetingLinks.id,
        code: meetingLinks.code,
        title: meetingLinks.title,
      })
      .from(meetingLinks)
      .innerJoin(spaces, eq(spaces.id, meetingLinks.spaceId))
      .where(and(
        eq(meetingLinks.id, input.meetingLinkId),
        eq(meetingLinks.reusePolicy, "reusable"),
        eq(meetingLinks.spaceKind, "personal"),
        isNull(meetingLinks.archivedAt),
        eq(spaces.ownerUserId, organizer.id),
        isNull(spaces.archivedAt),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!link) throw Errors.NOT_FOUND("Personal meeting link");
    personalMeetingLink = { id: link.id, code: link.code };
    title ||= link.title ?? undefined;
  }

  const result = await createMeetingScheduleRecord(
    db,
    organizer,
    { ...input, title, attendees, idempotencyFingerprint },
    { spaceMeetingLink, personalMeetingLink, spaceName },
  );

  if (!input.spaceId) {
    await rememberInvitedContacts(db, organizer, attendees).catch((error) => {
      logError("[scheduling] Failed to update the organizer contact index", error);
    });
  }
  return result;
}
