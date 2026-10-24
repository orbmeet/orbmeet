/**
 * Server implementations behind the RPC declarations in this directory.
 * Split from the sibling RPC file so the declaration file carries no
 * DB/Drizzle imports and stays safe to include in client route graphs.
 */

import type { Database } from "@orbmeet/db";
import { meetingLinks, organizations, spaceDefaultMeetingLinks, spaces, spaceInvites, spaceMembers, meetings, users } from "@orbmeet/db/schema";
import { eq, and, sql, count, isNull } from "drizzle-orm";
import type * as v from "valibot";
import { createSpaceSchema, updateSpaceSchema, getSpaceSchema } from "@/modules/spaces/contract/schemas";
import { generateId } from "@/lib/ids";
import { generateMeetingCode } from "@/modules/meetings/contract/code-generation";
import { Errors } from "@/lib/app-errors";
import { getPlanLimits } from "@/modules/billing/contract/plan-limits";
import { enforceRateLimit } from "@/platform/http/rate-limit.server";
import { getRunChanges, isUniqueConstraintError } from "@/platform/database/db-utils";
import { assertSpaceCapability, activeOwnedSharedSpaceCountSql, getSpaceAccess, retainsSpaceManagerSql, selectSpacesForUser } from "./helpers";
import { assertOrganizationRole, retainsOrganizationAdminSql } from "@/modules/organizations/server/authority.server";
import { generateInviteCode } from "@/platform/crypto/tokens.server";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import type { GetSpaceBySlugInput } from "./crud.functions";
import { requireSpaceSlug } from "@/modules/spaces/contract/slug";

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "space"
  );
}

export async function insertSpaceWithInitialMembership(
  db: Database,
  params: {
    spaceId: string;
    slug: string;
    memberId: string;
    meetingLinkId: string;
    meetingLinkCode: string;
    inviteId: string;
    inviteToken: string;
    creatorUserId: string;
    name: string;
    description: string | null;
    now: Date;
    maxSpaces: number | null;
    organizationId?: string | null;
    timeZone?: string;
  },
): Promise<boolean> {
  const {
    spaceId,
    slug,
    memberId,
    meetingLinkId,
    meetingLinkCode,
    inviteId,
    inviteToken,
    creatorUserId,
    name,
    description,
    now,
    maxSpaces,
    organizationId = null,
    timeZone = "UTC",
  } = params;
  const ownerUserId = organizationId ? null : creatorUserId;

  // Gate the authoritative Space insert at write time. Personal-billed Spaces
  // re-read their active quota; Organization-billed Spaces re-read the creator's
  // current owner/admin authority. SQLite serializes the batch as one write
  // transaction, so neither a concurrent create nor a concurrent demotion can
  // slip between the predicate and insert. Every dependent insert is gated on
  // the parent existing, making a declined creation a clean all-row no-op.
  // The query-builder select form maps columns by name, so these inserts are
  // independent of physical column order.
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const one = sql`(select 1)`;
  const creationAllowed = organizationId
    ? and(
        retainsOrganizationAdminSql(organizationId, creatorUserId),
        sql`exists (
          select 1 from ${organizations} funded_organization
          where funded_organization.id = ${organizationId}
            and funded_organization.plan = 'organization'
        )`,
      )
    : maxSpaces === null
      ? sql`exists (
          select 1 from ${users} creating_owner
          where creating_owner.id = ${creatorUserId}
            and creating_owner.deletion_started_at is null
        )`
      : sql`${activeOwnedSharedSpaceCountSql(creatorUserId)} < ${maxSpaces}
          and exists (
            select 1 from ${users} creating_owner
            where creating_owner.id = ${creatorUserId}
              and creating_owner.deletion_started_at is null
          )`;

  const [
    spaceInsertResult,
    memberInsertResult,
    meetingLinkInsertResult,
    defaultLinkInsertResult,
    inviteInsertResult,
  ] = await db.batch([
    db.insert(spaces).select(
      db
        .select({
          id: sql`${spaceId}`.as("id"),
          kind: sql`'shared'`.as("kind"),
          name: sql`${name}`.as("name"),
          description: sql`${description}`.as("description"),
          ownerUserId: sql`${ownerUserId}`.as("owner_user_id"),
          organizationId: sql`${organizationId}`.as("organization_id"),
          slug: sql`${slug}`.as("slug"),
          timeZone: sql`${timeZone}`.as("time_zone"),
          archivedAt: sql`null`.as("archived_at"),
          createdAt: sql`${nowSeconds}`.as("created_at"),
          updatedAt: sql`${nowSeconds}`.as("updated_at"),
        })
        .from(one)
        .where(creationAllowed),
    ),
    db.insert(spaceMembers).select(
      db
        .select({
          id: sql`${memberId}`.as("id"),
          spaceId: sql`${spaceId}`.as("space_id"),
          userId: sql`${creatorUserId}`.as("user_id"),
          // The creator manages the Space; a user-paid Space also names them owner.
          role: sql`'admin'`.as("role"),
          joinedAt: sql`${nowSeconds}`.as("joined_at"),
        })
        .from(one)
        .where(sql`exists (select 1 from spaces where id = ${spaceId})`),
    ),
    db.insert(meetingLinks).select(
      db
        .select({
          id: sql`${meetingLinkId}`.as("id"),
          code: sql`${meetingLinkCode}`.as("code"),
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
        .from(one)
        .where(sql`exists (select 1 from spaces where id = ${spaceId})`),
    ),
    db.insert(spaceDefaultMeetingLinks).select(
      db
        .select({
          spaceId: sql`${spaceId}`.as("space_id"),
          spaceKind: sql`'shared'`.as("space_kind"),
          meetingLinkId: sql`${meetingLinkId}`.as("meeting_link_id"),
          linkReusePolicy: sql`'reusable'`.as("link_reuse_policy"),
        })
        .from(one)
        .where(sql`exists (select 1 from meeting_links where id = ${meetingLinkId})`),
    ),
    db.insert(spaceInvites).select(
      db
        .select({
          id: sql`${inviteId}`.as("id"),
          spaceId: sql`${spaceId}`.as("space_id"),
          token: sql`${inviteToken}`.as("token"),
          createdByUserId: sql`${creatorUserId}`.as("created_by_id"),
          createdAt: sql`${nowSeconds}`.as("created_at"),
        })
        .from(one)
        .where(sql`exists (select 1 from spaces where id = ${spaceId})`),
    ),
  ]);

  const spaceInserted = getRunChanges(spaceInsertResult) > 0;
  const memberInserted = getRunChanges(memberInsertResult) > 0;
  const meetingLinkInserted = getRunChanges(meetingLinkInsertResult) > 0;
  const defaultLinkInserted = getRunChanges(defaultLinkInsertResult) > 0;
  const inviteInserted = getRunChanges(inviteInsertResult) > 0;

  if (!spaceInserted) return false;
  if (!memberInserted || !meetingLinkInserted || !defaultLinkInserted || !inviteInserted) {
    throw Errors.VALIDATION("Failed to create space, please try again");
  }
  return true;
}

export async function updateSpaceProfile(
  db: Database,
  spaceId: string,
  actorUserId: string,
  data: {
    name?: string;
    description?: string | null;
    timeZone?: string;
    expected: { name: string; description: string | null; timeZone: string };
  },
  now = new Date(),
): Promise<boolean> {
  const updates: Pick<typeof spaces.$inferInsert, "updatedAt"> &
    Partial<Pick<typeof spaces.$inferInsert, "name" | "description" | "timeZone">> = {
    updatedAt: now,
  };
  if (data.name !== undefined) updates.name = data.name;
  if (data.description !== undefined) updates.description = data.description || null;
  if (data.timeZone !== undefined) updates.timeZone = data.timeZone;

  const result = await db
    .update(spaces)
    .set(updates)
    .where(
      and(
        eq(spaces.id, spaceId),
        retainsSpaceManagerSql(spaceId, actorUserId),
        data.name === undefined ? undefined : eq(spaces.name, data.expected.name),
        data.description === undefined
          ? undefined
          : data.expected.description === null
            ? isNull(spaces.description)
            : eq(spaces.description, data.expected.description),
        data.timeZone === undefined ? undefined : eq(spaces.timeZone, data.expected.timeZone),
      ),
    );
  return getRunChanges(result) > 0;
}

export async function createSpaceImpl({
  data,
  context: { user, env, db },
}: {
  data: v.InferOutput<typeof createSpaceSchema>;
  context: AuthFnContext;
}) {
  await enforceRateLimit(env, `space:create:${user.id}`);

  let organizationId: string | null = null;
  let maxSpaces: number | null;
  if (data.organizationId) {
    await assertOrganizationRole(db, data.organizationId, user.id, "admin");
    const organization = await db.query.organizations.findFirst({
      where: { id: data.organizationId },
      columns: { plan: true },
    });
    if (organization?.plan !== "organization") {
      throw Errors.PLAN_LIMIT_REACHED("Organization billing is required to create funded Spaces");
    }
    organizationId = data.organizationId;
    maxSpaces = null;
  } else {
    const plan = user.plan ?? "free";
    maxSpaces = getPlanLimits(plan).maxSpaces;
  }

  const now = new Date();
  const spaceId = generateId("SPACE");
  const memberId = generateId("MEMBER");
  const inviteId = generateId("INVITE");
  const baseSlug = slugify(data.name);
  let created = false;
  let resolvedSlug = baseSlug;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // On slug collision, append a random 4-char suffix. The invite code is
    // regenerated per attempt too, so a UNIQUE collision on its column (a small
    // keyspace) is resolved by the same retry.
    const suffix = attempt === 0 ? "" : `-${Math.random().toString(36).slice(2, 6)}`;
    resolvedSlug = `${baseSlug.slice(0, 200 - suffix.length)}${suffix}`;
    try {
      created = await insertSpaceWithInitialMembership(db, {
        spaceId,
        slug: resolvedSlug,
        memberId,
        meetingLinkId: generateId("MEETING_LINK"),
        meetingLinkCode: generateMeetingCode(),
        inviteId,
        inviteToken: generateInviteCode(),
        creatorUserId: user.id,
        name: data.name,
        description: data.description ?? null,
        now,
        maxSpaces,
        organizationId,
        timeZone: data.timeZone,
      });
      break;
    } catch (err) {
      if (!isUniqueConstraintError(err) || attempt === 2) throw err;
    }
  }
  if (!created) {
    if (organizationId) {
      throw Errors.FORBIDDEN("Your Organization role changed before the Space was created.");
    }
    throw Errors.PLAN_LIMIT_REACHED(`Maximum ${maxSpaces} space(s) on your plan`);
  }

  return { spaceId, slug: resolvedSlug };
}

export async function updateSpaceImpl({
  data,
  context: { user, env, db },
}: {
  data: v.InferOutput<typeof updateSpaceSchema>;
  context: AuthFnContext;
}) {
  // H4: rate-limit space updates
  await enforceRateLimit(env, `space:update:${user.id}`);

  await assertSpaceCapability(db, data.spaceId, user.id, "canManage");

  if (!(await updateSpaceProfile(db, data.spaceId, user.id, data))) {
    const current = await db.query.spaces.findFirst({
      where: { id: data.spaceId },
      columns: { name: true, description: true, timeZone: true },
    });
    const conflicted =
      current &&
      ((data.name !== undefined && current.name !== data.expected.name) ||
        (data.description !== undefined && current.description !== data.expected.description) ||
        (data.timeZone !== undefined && current.timeZone !== data.expected.timeZone));
    if (conflicted) {
      throw Errors.CONFLICT(
        "These Space details changed elsewhere. Review the latest values and try again.",
      );
    }
    throw Errors.FORBIDDEN("Your Space role changed before the update completed.");
  }

  return { success: true };
}


type SpaceDetailAccess = NonNullable<Awaited<ReturnType<typeof getSpaceAccess>>>;

// Shared by getSpace and getSpaceBySlug so both endpoints return the identical
// space-detail payload from a single request. `access` must already be
// capability-checked for canView by the caller.
async function selectSpaceDetail(
  db: Database,
  spaceId: string,
  viewerId: string,
  access: SpaceDetailAccess,
) {
  // L6/M2: member records are fetched separately via listSpaceMembers so this
  // endpoint stays O(1) regardless of space size — we only need the counts here.
  const [
    space,
    [{ value: memberCount } = { value: 0 }],
    [{ value: activeMeetingCount } = { value: 0 }],
  ] = await Promise.all([
    db
      .select({
        id: spaces.id,
        kind: spaces.kind,
        name: spaces.name,
        description: spaces.description,
        slug: spaces.slug,
        timeZone: spaces.timeZone,
        ownerUserId: spaces.ownerUserId,
        organizationId: spaces.organizationId,
        organizationName: organizations.name,
        createdAt: spaces.createdAt,
        updatedAt: spaces.updatedAt,
      })
      .from(spaces)
      .leftJoin(organizations, eq(organizations.id, spaces.organizationId))
      .where(eq(spaces.id, spaceId))
      .then((rows) => rows[0]),
    db.select({ value: count() }).from(spaceMembers).where(eq(spaceMembers.spaceId, spaceId)),
    db
      .select({ value: count() })
      .from(meetings)
      .where(and(eq(meetings.spaceId, spaceId), eq(meetings.status, "open"))),
  ]);
  // Defensive: a membership without its space shouldn't exist (FK cascade), but
  // guard rather than return a half-populated payload. Personal spaces are not
  // addressable as spaces — the UI surfaces them as "your" views instead.
  if (!space || space.kind === "personal") throw Errors.NOT_FOUND("Space");
  const canonicalSpace = { ...space, slug: requireSpaceSlug(space.slug) };

  return {
    space: canonicalSpace,
    directRole: access.directRole,
    organizationRole: access.organizationRole,
    capabilities: access.capabilities,
    memberCount,
    // Live-meeting count drives the "N live" badge on the Meetings tab without
    // the client having to load the full meetings list up front.
    activeMeetingCount,
    // Expose the viewer's own userId so the client can identify their own row
    // (needed for the Remove / role-change button guards in MembersList).
    viewerId,
    canTransferOwnership: access.capabilities.canTransferOwnership,
    canLeaveSpace: access.capabilities.canLeave,
  };
}

export async function getSpaceImpl({
  data,
  context: { user, env: _env, db },
}: {
  data: v.InferOutput<typeof getSpaceSchema>;
  context: AuthFnContext;
}) {
  // Resolve the caller's membership first. This both gates access and avoids a
  // space-existence oracle: non-members get FORBIDDEN before any space lookup,
  // so the endpoint never reveals whether an arbitrary spaceId exists.
  const access = await assertSpaceCapability(db, data.spaceId, user.id, "canView");
  return selectSpaceDetail(db, data.spaceId, user.id, access);
}

export async function getMySpacesImpl({ context: { user, db } }: { context: AuthFnContext }) {
  return { spaces: await selectSpacesForUser(db, user.id) };
}

/** Resolve a slug only when it belongs to a Space the viewer can read. */
export async function findViewableSpaceIdBySlug(
  db: Database,
  slug: string,
  viewerId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: spaces.id })
    .from(spaces)
    .innerJoin(
      spaceMembers,
      and(eq(spaceMembers.spaceId, spaces.id), eq(spaceMembers.userId, viewerId)),
    )
    .where(and(eq(spaces.slug, slug), isNull(spaces.archivedAt)))
    .limit(1);
  return row?.id ?? null;
}

// Returns the same detail payload as getSpace so the space route resolves a
// slug and loads the page surface in one round trip instead of two.
export async function getSpaceBySlugImpl({
  data,
  context: { user, db },
}: {
  data: GetSpaceBySlugInput;
  context: AuthFnContext;
}) {
  const spaceId = await findViewableSpaceIdBySlug(db, data.slug, user.id);
  if (!spaceId) throw Errors.NOT_FOUND("Space");
  const access = await getSpaceAccess(db, spaceId, user.id);
  // The joined lookup above makes missing and inaccessible slugs identical.
  // Keep this defensive check normalized too in case membership changes
  // between lookup and detail selection.
  if (!access?.capabilities.canView) throw Errors.NOT_FOUND("Space");
  return selectSpaceDetail(db, spaceId, user.id, access);
}
