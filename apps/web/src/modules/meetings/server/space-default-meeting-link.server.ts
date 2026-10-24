/**
 * Server implementations behind the RPC declarations in this directory.
 * Split from the sibling RPC file so the declaration file carries no
 * DB/Drizzle imports and stays safe to include in client route graphs.
 */

import type { Database } from "@orbmeet/db";
import { meetingLinks, meetings, spaceDefaultMeetingLinks, spaces } from "@orbmeet/db/schema";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { Errors } from "@/lib/app-errors";
import { generateId } from "@/lib/ids";
import { generateMeetingCode } from "@/modules/meetings/contract/code-generation";
import { assertSpaceCapability, getSpaceAccess, retainsSpaceManagerSql } from "@/modules/spaces/server/helpers";
import { getRunChanges, isUniqueConstraintError } from "@/platform/database/db-utils";
import { enforceRateLimit } from "@/platform/http/rate-limit.server";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import type { SpaceDefaultMeetingLinkInput } from "./space-default-meeting-link.functions";

type SpaceDefaultMeetingLink = {
  id: string;
  code: string;
  title: string | null;
  joinPolicy: "open" | "approval_required" | "closed";
};

async function findSpaceDefaultMeetingLink(
  db: Database,
  spaceId: string,
): Promise<SpaceDefaultMeetingLink | null> {
  return await db
    .select({
      id: meetingLinks.id,
      code: meetingLinks.code,
      title: meetingLinks.title,
      joinPolicy: meetingLinks.joinPolicy,
    })
    .from(spaceDefaultMeetingLinks)
    .innerJoin(meetingLinks, eq(meetingLinks.id, spaceDefaultMeetingLinks.meetingLinkId))
    .where(
      and(
        eq(spaceDefaultMeetingLinks.spaceId, spaceId),
        eq(meetingLinks.reusePolicy, "reusable"),
        isNull(meetingLinks.archivedAt),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export async function ensureSpaceDefaultMeetingLink(
  db: Database,
  spaceId: string,
): Promise<SpaceDefaultMeetingLink> {
  const existingDefaultLink = await findSpaceDefaultMeetingLink(db, spaceId);
  if (existingDefaultLink) return existingDefaultLink;

  const now = new Date();
  const [existingSpaceLink] = await db
    .select({ id: meetingLinks.id })
    .from(meetingLinks)
    .innerJoin(spaces, eq(spaces.id, meetingLinks.spaceId))
    .where(
      and(
        eq(meetingLinks.spaceId, spaceId),
        eq(meetingLinks.spaceKind, "shared"),
        eq(meetingLinks.reusePolicy, "reusable"),
        isNull(meetingLinks.archivedAt),
        isNull(spaces.archivedAt),
      ),
    )
    .orderBy(asc(meetingLinks.createdAt), asc(meetingLinks.id))
    .limit(1);
  if (existingSpaceLink) {
    await db.batch([
      db
        .update(meetingLinks)
        .set({
          allowGuests: false,
          expiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(meetingLinks.id, existingSpaceLink.id),
            eq(meetingLinks.spaceId, spaceId),
            eq(meetingLinks.reusePolicy, "reusable"),
            isNull(meetingLinks.archivedAt),
            sql`EXISTS (
              SELECT 1 FROM ${spaces}
              WHERE ${spaces.id} = ${spaceId}
                AND ${spaces.kind} = 'shared'
                AND ${spaces.archivedAt} IS NULL
            )`,
          ),
        ),
      db
        .insert(spaceDefaultMeetingLinks)
        .select(
          db
            .select({
              spaceId: sql`${spaceId}`.as("space_id"),
              spaceKind: sql`'shared'`.as("space_kind"),
              meetingLinkId: sql`${existingSpaceLink.id}`.as("meeting_link_id"),
              linkReusePolicy: sql`'reusable'`.as("link_reuse_policy"),
            })
            .from(sql`(select 1)`).where(sql`EXISTS (
                SELECT 1 FROM ${meetingLinks}
                INNER JOIN ${spaces} ON ${spaces.id} = ${meetingLinks.spaceId}
                WHERE ${meetingLinks.id} = ${existingSpaceLink.id}
                  AND ${meetingLinks.spaceId} = ${spaceId}
                  AND ${meetingLinks.reusePolicy} = 'reusable'
                  AND ${meetingLinks.expiresAt} IS NULL
                  AND ${meetingLinks.archivedAt} IS NULL
                  AND ${spaces.kind} = 'shared'
                  AND ${spaces.archivedAt} IS NULL
              )
                AND NOT EXISTS (
                  SELECT 1 FROM ${spaceDefaultMeetingLinks}
                  WHERE ${spaceDefaultMeetingLinks.spaceId} = ${spaceId}
                )`),
        ),
    ]);
    const adopted = await findSpaceDefaultMeetingLink(db, spaceId);
    if (adopted) return adopted;
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  const MAX_CODE_COLLISION_ATTEMPTS = 3;

  for (let attempt = 0; attempt < MAX_CODE_COLLISION_ATTEMPTS; attempt++) {
    const meetingLinkId = generateId("MEETING_LINK");
    const code = generateMeetingCode();

    try {
      const [linkInsertResult, designationInsertResult] = await db.batch([
        db.insert(meetingLinks).select(
          db
            .select({
              id: sql`${meetingLinkId}`.as("id"),
              code: sql`${code}`.as("code"),
              reusePolicy: sql`'reusable'`.as("reuse_policy"),
              spaceId: sql`${spaceId}`.as("space_id"),
              spaceKind: sql`'shared'`.as("space_kind"),
              spentAt: sql`null`.as("spent_at"),
              title: sql`null`.as("title"),
              allowGuests: sql`0`.as("allow_guests"),
              joinPolicy: sql`'open'`.as("join_policy"),
              lastUsedAt: sql`null`.as("last_used_at"),
              expiresAt: sql`null`.as("expires_at"),
              archivedAt: sql`null`.as("archived_at"),
              createdAt: sql`${nowSeconds}`.as("created_at"),
              updatedAt: sql`${nowSeconds}`.as("updated_at"),
            })
            .from(sql`(select 1)`).where(sql`NOT EXISTS (
                  SELECT 1 FROM ${spaceDefaultMeetingLinks}
                  WHERE ${spaceDefaultMeetingLinks.spaceId} = ${spaceId}
                )
                  AND NOT EXISTS (
                    SELECT 1 FROM ${meetingLinks}
                    WHERE ${meetingLinks.spaceId} = ${spaceId}
                      AND ${meetingLinks.reusePolicy} = 'reusable'
                      AND ${meetingLinks.archivedAt} IS NULL
                  )
                  AND EXISTS (
                    SELECT 1 FROM ${spaces}
                    WHERE ${spaces.id} = ${spaceId}
                      AND ${spaces.kind} = 'shared'
                      AND ${spaces.archivedAt} IS NULL
                  )`),
        ),
        db.insert(spaceDefaultMeetingLinks).select(
          db
            .select({
              spaceId: sql`${spaceId}`.as("space_id"),
              spaceKind: sql`'shared'`.as("space_kind"),
              meetingLinkId: sql`${meetingLinkId}`.as("meeting_link_id"),
              linkReusePolicy: sql`'reusable'`.as("link_reuse_policy"),
            })
            .from(sql`(select 1)`).where(sql`EXISTS (
                SELECT 1 FROM ${meetingLinks}
                WHERE ${meetingLinks.id} = ${meetingLinkId}
                  AND ${meetingLinks.spaceId} = ${spaceId}
              )
                AND NOT EXISTS (
                  SELECT 1 FROM ${spaceDefaultMeetingLinks}
                  WHERE ${spaceDefaultMeetingLinks.spaceId} = ${spaceId}
                )`),
        ),
      ]);

      if (getRunChanges(linkInsertResult) === 0 || getRunChanges(designationInsertResult) === 0) {
        const concurrent = await findSpaceDefaultMeetingLink(db, spaceId);
        if (concurrent) return concurrent;
      } else {
        const created = await findSpaceDefaultMeetingLink(db, spaceId);
        if (created) return created;
      }
    } catch (err) {
      if (!isUniqueConstraintError(err) || attempt === MAX_CODE_COLLISION_ATTEMPTS - 1) {
        throw err;
      }
    }
  }

  throw Errors.VALIDATION("Failed to create the Space link. Please try again.");
}

/**
 * Read a Space's front door, healing a missing designation for a viewer who
 * could start a meeting through it.
 *
 * This is a GET that can write, which is normally a trap — it is cached by
 * TanStack Query and therefore refetched on its own schedule. It is safe here
 * only because `createSpace` provisions the link and its designation in the
 * same batch as the Space row, so `ensureSpaceDefaultMeetingLink` short-circuits
 * on its first SELECT for every Space created through the product. The write
 * path exists solely to heal legacy or interrupted provisioning, runs once, and
 * is guarded so concurrent refetches converge on one link.
 *
 * If a future change makes missing designations routine, move the heal to an
 * explicit mutation rather than letting refetch traffic drive writes.
 */
export async function getSpaceDefaultMeetingLinkImpl({
  data,
  context: { user, db },
}: {
  data: SpaceDefaultMeetingLinkInput;
  context: AuthFnContext;
}) {
  const access = await assertSpaceCapability(db, data.spaceId, user.id, "canView");
  const canStart = access.capabilities.canStartMeetings;
  const meetingLink = canStart
    ? await ensureSpaceDefaultMeetingLink(db, data.spaceId)
    : await findSpaceDefaultMeetingLink(db, data.spaceId);

  if (!meetingLink) {
    return {
      meetingLink: null,
      hasOpenMeeting: false,
      canStart,
      canReplace: access.capabilities.canManage,
    };
  }

  const openMeeting = await db.query.meetings.findFirst({
    where: { RAW: (row) => and(eq(row.spaceId, data.spaceId), eq(row.status, "open"))! },
    columns: { id: true, startedAt: true },
  });

  return {
    meetingLink: {
      id: meetingLink.id,
      code: meetingLink.code,
      title: meetingLink.title,
    },
    hasOpenMeeting: Boolean(openMeeting),
    openMeetingId: openMeeting?.id ?? null,
    startedAt: openMeeting?.startedAt?.toISOString() ?? null,
    canStart,
    canReplace: access.capabilities.canManage,
  };
}

/** Replace only the public code; the durable Space-link identity stays fixed. */
export async function replaceSpaceMeetingLinkCode(
  db: Database,
  spaceId: string,
  actorUserId: string,
  now = new Date(),
) {
  const meetingLink = await ensureSpaceDefaultMeetingLink(db, spaceId);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = generateMeetingCode();
    try {
      const result = await db
        .update(meetingLinks)
        .set({ code, updatedAt: now })
        .where(
          and(
            eq(meetingLinks.id, meetingLink.id),
            isNull(meetingLinks.archivedAt),
            retainsSpaceManagerSql(spaceId, actorUserId),
            sql`not exists ${db
              .select({ id: meetings.id })
              .from(meetings)
              .where(and(eq(meetings.spaceId, spaceId), eq(meetings.status, "open")))}`,
          ),
        );
      if (getRunChanges(result) === 0) {
        const access = await getSpaceAccess(db, spaceId, actorUserId);
        if (!access?.capabilities.canManage) {
          throw Errors.FORBIDDEN("Your Space role changed before the meeting link was replaced.");
        }
        throw Errors.CONFLICT("End the current Space meeting before replacing its link.");
      }
      return { meetingLinkId: meetingLink.id, code };
    } catch (error) {
      if (isUniqueConstraintError(error) && attempt < 2) {
        continue;
      }
      throw error;
    }
  }

  throw Errors.CONFLICT("Could not allocate a new Space meeting link. Please try again.");
}

export async function replaceSpaceMeetingLinkImpl({
  data,
  context: { user, env, db },
}: {
  data: SpaceDefaultMeetingLinkInput;
  context: AuthFnContext;
}) {
  await enforceRateLimit(env, `space:meeting-link:replace:${user.id}`);
  await assertSpaceCapability(db, data.spaceId, user.id, "canManage");
  return replaceSpaceMeetingLinkCode(db, data.spaceId, user.id);
}
