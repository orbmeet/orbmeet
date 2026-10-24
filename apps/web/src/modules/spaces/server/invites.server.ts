/**
 * Server implementations behind the RPC declarations in this directory.
 * Split from the sibling RPC file so the declaration file carries no
 * DB/Drizzle imports and stays safe to include in client route graphs.
 */

import type { Database } from "@orbmeet/db";
import { organizationMembers, spaces, spaceMembers, spaceInvites } from "@orbmeet/db/schema";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import {
  getSpaceInviteSchema,
  rotateSpaceInviteSchema,
  joinViaInviteSchema,
} from "@/modules/spaces/contract/schemas";
import { generateId } from "@/lib/ids";
import { Errors } from "@/lib/app-errors";
import { enforceIpRateLimit, enforceRateLimit } from "@/platform/http/rate-limit.server";
import {
  assertSpaceCapability,
  findSpaceMembership,
  retainsSpaceManagerSql,
  resolveSpaceMemberCap,
  spaceHasMemberRoomSql,
} from "./helpers";
import { recordSpaceAuditEvent } from "./audit.server";
import { getRunChanges, isUniqueConstraintError } from "@/platform/database/db-utils";
import { generateInviteCode } from "@/platform/crypto/tokens.server";
import type * as v from "valibot";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { hasOrganizationLicense } from "@/modules/organizations/server/authority.server";
import { requireSpaceSlug } from "@/modules/spaces/contract/slug";

// The invite code lives in a UNIQUE column and is drawn from a small enough
// keyspace that a collision, while rare, is possible — retry generation a few
// times before surfacing the error rather than failing a create/rotate.
const INVITE_CODE_ATTEMPTS = 5;

function isUniqueViolation(error: unknown): boolean {
  return isUniqueConstraintError(error);
}

type InviteIdentity = { id: string; spaceId: string };

export async function replaceSpaceInviteRecord(
  db: Database,
  params: {
    spaceId: string;
    currentInviteId: string;
    actorUserId: string;
    now?: Date;
  },
) {
  const inviteId = generateId("INVITE");
  const createdAt = params.now ?? new Date();
  for (let attempt = 0; attempt < INVITE_CODE_ATTEMPTS; attempt += 1) {
    const token = generateInviteCode();
    try {
      const result = await db
        .update(spaceInvites)
        .set({
          id: inviteId,
          token,
          createdByUserId: params.actorUserId,
          createdAt,
        })
        .where(
          and(
            eq(spaceInvites.id, params.currentInviteId),
            eq(spaceInvites.spaceId, params.spaceId),
            retainsSpaceManagerSql(params.spaceId, params.actorUserId),
          ),
        );
      if (getRunChanges(result) === 0) return null;
      return { inviteId, token, createdAt: createdAt.toISOString() };
    } catch (error) {
      if (isUniqueViolation(error) && attempt < INVITE_CODE_ATTEMPTS - 1) continue;
      throw error;
    }
  }
  return null;
}

/** Add a member only while the exact invitation and active Space still exist. */
export async function applyInviteMembership(
  db: Database,
  params: {
    invite: InviteIdentity;
    userId: string;
    memberId: string;
    now: Date;
  },
): Promise<boolean> {
  const { invite, userId, memberId, now } = params;
  const nowSeconds = Math.floor(now.getTime() / 1000);

  const [memberInsertResult] = await db.batch([
    db.insert(spaceMembers).select(
      db
        .select({
          id: sql`${memberId}`.as("id"),
          spaceId: sql`${invite.spaceId}`.as("space_id"),
          userId: sql`${userId}`.as("user_id"),
          role: sql`'member'`.as("role"),
          joinedAt: sql`${nowSeconds}`.as("joined_at"),
        })
        .from(sql`(select 1)`).where(sql`exists (
            select 1 from ${spaceInvites}
            where ${spaceInvites.id} = ${invite.id}
              and ${spaceInvites.spaceId} = ${invite.spaceId}
          )
            and exists (
              select 1 from ${spaces}
              where ${spaces.id} = ${invite.spaceId} and ${spaces.archivedAt} is null
            )
            and (
              not exists (
                select 1 from ${spaces}
                where ${spaces.id} = ${invite.spaceId}
                  and ${spaces.organizationId} is not null
              )
              or exists (
                select 1
                from ${spaces} licensed_space
                inner join ${organizationMembers} license
                  on license.organization_id = licensed_space.organization_id
                where licensed_space.id = ${invite.spaceId}
                  and license.user_id = ${userId}
              )
            )
            and ${spaceHasMemberRoomSql(invite.spaceId)}`),
    ),
    db
      .update(spaces)
      .set({ updatedAt: now })
      .where(
        and(
          eq(spaces.id, invite.spaceId),
          sql`exists (select 1 from ${spaceMembers} where ${spaceMembers.id} = ${memberId})`,
        ),
      ),
  ]);
  return getRunChanges(memberInsertResult) > 0;
}

function invitationResult(invite: { id: string; token: string; createdAt: Date }) {
  return {
    inviteId: invite.id,
    token: invite.token,
    createdAt: invite.createdAt.toISOString(),
  };
}

export async function getSpaceInviteImpl({
  data,
  context: { user, db },
}: {
  data: v.InferOutput<typeof getSpaceInviteSchema>;
  context: AuthFnContext;
}) {
  await assertSpaceCapability(db, data.spaceId, user.id, "canManageMembers");
  const invite = await db.query.spaceInvites.findFirst({
    where: { spaceId: data.spaceId },
    columns: { id: true, token: true, createdAt: true },
  });
  if (!invite) throw Errors.CONFIG_ERROR("Space is missing its invitation URL");
  return invitationResult(invite);
}

/** Invalidate the previous URL and return its durable replacement. */
export async function rotateSpaceInviteImpl({
  data,
  context: { user, env, db },
}: {
  data: v.InferOutput<typeof rotateSpaceInviteSchema>;
  context: AuthFnContext;
}) {
  await enforceRateLimit(env, `invite:rotate:${user.id}`);
  await assertSpaceCapability(db, data.spaceId, user.id, "canManageMembers");

  const current = await db.query.spaceInvites.findFirst({
    where: { spaceId: data.spaceId },
    columns: { id: true },
  });
  if (!current) throw Errors.NOT_FOUND("Space invitation URL");

  const now = new Date();
  const replacement = await replaceSpaceInviteRecord(db, {
    spaceId: data.spaceId,
    currentInviteId: current.id,
    actorUserId: user.id,
    now,
  });
  if (!replacement) {
    throw Errors.VALIDATION(
      "The invitation URL changed before it could be replaced. Please retry.",
    );
  }

  await recordSpaceAuditEvent(db, {
    spaceId: data.spaceId,
    actorUserId: user.id,
    action: "invite_rotated",
    metadata: { previousInviteId: current.id, inviteId: replacement.inviteId },
  });
  return replacement;
}

async function findSpaceInviteByToken(db: Database, token: string) {
  // Codes are stored verbatim and looked up by exact match. (The token column's
  // length CHECK now forbids the 64-char hashes older builds stored, so no hash
  // fallback is possible or needed.)
  return (
    (await db.query.spaceInvites.findFirst({
      where: { token: token },
      columns: { id: true, spaceId: true },
    })) ?? null
  );
}

export async function previewInviteImpl({
  data,
  context: { env, db },
}: {
  data: v.InferOutput<typeof joinViaInviteSchema>;
  context: AuthFnContext;
}) {
  await enforceIpRateLimit(env, "preview-invite");
  const invite = await findSpaceInviteByToken(db, data.token);
  if (!invite) throw Errors.NOT_FOUND("Invite");
  const space = await db.query.spaces.findFirst({
    where: { RAW: (row) => and(eq(row.id, invite.spaceId), isNull(row.archivedAt))! },
    columns: { name: true },
  });
  if (!space) throw Errors.NOT_FOUND("Space");
  return { spaceName: space.name };
}

export async function joinViaInviteImpl({
  data,
  context: { user, env, db },
}: {
  data: v.InferOutput<typeof joinViaInviteSchema>;
  context: AuthFnContext;
}) {
  await enforceIpRateLimit(env, "join-invite");
  const invite = await findSpaceInviteByToken(db, data.token);
  if (!invite) throw Errors.NOT_FOUND("Invite");

  const inviteSpace = await db.query.spaces.findFirst({
    where: { RAW: (row) => and(eq(row.id, invite.spaceId), isNull(row.archivedAt))! },
    columns: { id: true, slug: true, ownerUserId: true, organizationId: true },
  });
  if (!inviteSpace) throw Errors.NOT_FOUND("Space");
  const slug = requireSpaceSlug(inviteSpace.slug);
  const existing = await findSpaceMembership(db, invite.spaceId, user.id);
  if (existing) return { spaceId: invite.spaceId, slug, alreadyMember: true };

  if (inviteSpace.organizationId) {
    if (!(await hasOrganizationLicense(db, inviteSpace.organizationId, user.id))) {
      throw Errors.FORBIDDEN(
        "Ask an Organization administrator to assign you a license before joining this Space.",
      );
    }
  }

  // A clear answer for the common case; the insert below enforces the cap
  // against the plan funding the Space as it runs.
  const memberCap = await resolveSpaceMemberCap(
    db,
    inviteSpace.ownerUserId,
    inviteSpace.organizationId,
  );
  if (memberCap !== null) {
    const [{ value: memberCount } = { value: 0 }] = await db
      .select({ value: count() })
      .from(spaceMembers)
      .where(eq(spaceMembers.spaceId, invite.spaceId));
    if (memberCount >= memberCap) throw Errors.PLAN_LIMIT_REACHED("This Space is full");
  }

  try {
    const added = await applyInviteMembership(db, {
      invite,
      userId: user.id,
      memberId: generateId("MEMBER"),
      now: new Date(),
    });
    if (!added) {
      const [currentInvite, room] = await Promise.all([
        db.query.spaceInvites.findFirst({
          where: { RAW: (row) => and(eq(row.id, invite.id), eq(row.spaceId, invite.spaceId))! },
          columns: { id: true },
        }),
        db.get<{ hasRoom: number }>(
          sql`select ${spaceHasMemberRoomSql(invite.spaceId)} as hasRoom`,
        ),
      ]);
      if (currentInvite && !room?.hasRoom) {
        throw Errors.PLAN_LIMIT_REACHED("This Space is full");
      }
      throw Errors.VALIDATION("This invitation URL is no longer valid");
    }
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return { spaceId: invite.spaceId, slug, alreadyMember: true };
    }
    throw error;
  }

  await recordSpaceAuditEvent(db, {
    spaceId: invite.spaceId,
    actorUserId: user.id,
    action: "member_added",
    targetUserId: user.id,
    metadata: { role: "member", via: "invite" },
  });
  return { spaceId: invite.spaceId, slug, alreadyMember: false };
}
