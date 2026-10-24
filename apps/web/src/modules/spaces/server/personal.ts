import type { Database } from "@orbmeet/db";
import { spaceMembers, spaces, users } from "@orbmeet/db/schema";
import { sql } from "drizzle-orm";
import { Errors } from "@/lib/app-errors";
import { generateId } from "@/lib/ids";

/**
 * An account has at most one personal space: the reified context for the
 * user's own meetings, links, whiteboards, and files. It is created by the
 * first write that needs it, hidden from every space listing, and lives and
 * dies with the account. Domain code resolves it here instead of branching on
 * personal-versus-shared.
 */

/** The caller's personal space, or null before they have created anything. */
export async function findPersonalSpaceId(
  db: Database,
  userId: string,
): Promise<string | null> {
  const row = await db.query.spaces.findFirst({
    where: { kind: "personal", ownerUserId: userId },
    columns: { id: true },
  });
  return row?.id ?? null;
}

function personalSpaceName(displayName: string): string {
  const trimmed = displayName.trim().slice(0, 200).trim();
  return trimmed.length > 0 ? trimmed : "Personal";
}

/**
 * Idempotently provision the personal space and its owner membership. The
 * space insert relies on the partial unique index
 * (one personal space per owner) to lose races cleanly; the dependent inserts
 * are gated on this attempt's space id existing, so a losing attempt no-ops
 * and re-resolves the winner.
 */
export async function ensurePersonalSpace(
  db: Database,
  user: { id: string; name: string },
  now = new Date(),
): Promise<string> {
  const existing = await findPersonalSpaceId(db, user.id);
  if (existing) {
    const activeOwner = await db.query.users.findFirst({
      where: { id: user.id, deletionStartedAt: { isNull: true } },
      columns: { id: true },
    });
    if (!activeOwner) throw Errors.CONFLICT("Account deletion is already in progress.");
    return existing;
  }

  const spaceId = generateId("SPACE");
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const one = sql`(select 1)`;
  const spaceExists = sql`exists (select 1 from spaces where id = ${spaceId})`;

  await db.batch([
      db
        .insert(spaces)
        .select(db.select({
          id: sql`${spaceId}`.as("id"),
          kind: sql`'personal'`.as("kind"),
          name: sql`${personalSpaceName(user.name)}`.as("name"),
          description: sql`null`.as("description"),
          ownerUserId: users.id,
          organizationId: sql`null`.as("organization_id"),
          slug: sql`null`.as("slug"),
          timeZone: sql`'UTC'`.as("time_zone"),
          archivedAt: sql`null`.as("archived_at"),
          createdAt: sql`${nowSeconds}`.as("created_at"),
          updatedAt: sql`${nowSeconds}`.as("updated_at"),
        }).from(users).where(sql`${users.id} = ${user.id} and ${users.deletionStartedAt} is null`))
        .onConflictDoNothing(),
      db.insert(spaceMembers).select(
        db
          .select({
            id: sql`${generateId("MEMBER")}`.as("id"),
            spaceId: sql`${spaceId}`.as("space_id"),
            userId: sql`${user.id}`.as("user_id"),
            role: sql`'admin'`.as("role"),
            joinedAt: sql`${nowSeconds}`.as("joined_at"),
          })
          .from(one)
          .where(spaceExists),
      ),
  ]);

  const resolved = await findPersonalSpaceId(db, user.id);
  if (!resolved) {
    throw Errors.CONFIG_ERROR("Failed to provision the personal space");
  }
  return resolved;
}
