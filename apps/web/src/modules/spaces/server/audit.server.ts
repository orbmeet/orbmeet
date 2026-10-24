/**
 * Server implementations behind the RPC declarations in this directory.
 * Split from the sibling RPC file so the declaration file carries no
 * DB/Drizzle imports and stays safe to include in client route graphs.
 */

import type { Database } from "@orbmeet/db";
import { spaceAuditEvents, users } from "@orbmeet/db/schema";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { generateId } from "@/lib/ids";
import { listAuditEventsSchema } from "@/modules/spaces/contract/schemas";
import type { SpaceAuditAction } from "@/modules/spaces/contract/types";
import { alias } from "drizzle-orm/sqlite-core";
import { logError } from "@/lib/logger";
import { assertSpaceCapability } from "./helpers";
import type * as v from "valibot";
import type { AuthFnContext } from "@/app/bootstrap/middleware";

/**
 * Record a space governance event. Best-effort and non-throwing by design: it is
 * written *after* the governing mutation has already committed, so an audit hiccup
 * must never fail (or roll back) a real action. Failures are logged, not surfaced.
 *
 * Never call this inside the atomic seat/cap batches — those must stay minimal.
 */
export async function recordSpaceAuditEvent(
  db: Database,
  params: {
    spaceId: string;
    actorUserId: string | null;
    action: SpaceAuditAction;
    targetUserId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await db.insert(spaceAuditEvents).values({
      id: generateId("AUDIT"),
      spaceId: params.spaceId,
      actorUserId: params.actorUserId,
      action: params.action,
      targetUserId: params.targetUserId ?? null,
      metadata: params.metadata ? JSON.stringify(params.metadata) : null,
      createdAt: new Date(),
    });
  } catch (err) {
    logError(
      `[spaces] Failed to record audit event ${params.action} for space ${params.spaceId}:`,
      err,
    );
  }
}

// Admin-only governance feed for a space, newest first, keyset-paginated over
// (createdAt desc, id desc) so it stays stable as new events arrive.
export async function listSpaceAuditEventsImpl({
  data,
  context: { user, db },
}: {
  data: v.InferOutput<typeof listAuditEventsSchema>;
  context: AuthFnContext;
}) {
  await assertSpaceCapability(db, data.spaceId, user.id, "canManage");

  const actor = alias(users, "actor");
  const target = alias(users, "target");

  const cursorClause = data.cursor
    ? or(
        lt(spaceAuditEvents.createdAt, new Date(data.cursor.createdAt)),
        and(
          eq(spaceAuditEvents.createdAt, new Date(data.cursor.createdAt)),
          lt(spaceAuditEvents.id, data.cursor.id),
        ),
      )
    : undefined;

  const rows = await db
    .select({
      id: spaceAuditEvents.id,
      action: spaceAuditEvents.action,
      actorUserId: spaceAuditEvents.actorUserId,
      actorName: actor.name,
      targetUserId: spaceAuditEvents.targetUserId,
      targetName: target.name,
      metadata: spaceAuditEvents.metadata,
      createdAt: spaceAuditEvents.createdAt,
    })
    .from(spaceAuditEvents)
    .leftJoin(actor, eq(spaceAuditEvents.actorUserId, actor.id))
    .leftJoin(target, eq(spaceAuditEvents.targetUserId, target.id))
    .where(and(eq(spaceAuditEvents.spaceId, data.spaceId), cursorClause ?? sql`1 = 1`))
    .orderBy(desc(spaceAuditEvents.createdAt), desc(spaceAuditEvents.id))
    .limit(data.limit + 1);

  const hasMore = rows.length > data.limit;
  const page = hasMore ? rows.slice(0, data.limit) : rows;
  const last = page[page.length - 1];

  return {
    events: page,
    nextCursor: hasMore && last ? { createdAt: last.createdAt.getTime(), id: last.id } : null,
  };
}
