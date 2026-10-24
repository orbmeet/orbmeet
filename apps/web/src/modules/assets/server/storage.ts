import type { Database } from "@orbmeet/db";
import {
  meetingArtifacts,
  meetings,
  files,
  whiteboardAssets,
  spaces,
} from "@orbmeet/db/schema";
import { sql } from "drizzle-orm";

export type StoragePrincipal = { type: "user" | "organization"; id: string };

export function storagePrincipalKey(principal: StoragePrincipal): string {
  return `${principal.type}:${principal.id}`;
}

/**
 * Authoritative committed usage expression for one billing user.
 *
 * Keep this as SQL rather than four application-side reads so quota reservation
 * can evaluate committed bytes and in-flight reservations in the same SQLite
 * write statement. That closes the finalize-between-read-and-reserve race.
 */
export function principalStoredBytesSql(principal: StoragePrincipal) {
  const ownsSpace = principal.type === "organization"
    ? sql`${spaces.organizationId} = ${principal.id}`
    : sql`${spaces.ownerUserId} = ${principal.id}`;
  return sql<number>`
    COALESCE((
      SELECT SUM(${files.size})
      FROM ${files}
      INNER JOIN ${spaces} ON ${spaces.id} = ${files.spaceId}
      WHERE ${files.status} = 'committed'
        AND ${ownsSpace}
    ), 0)
    + COALESCE((
      SELECT SUM(${meetingArtifacts.size})
      FROM ${meetingArtifacts}
      INNER JOIN ${meetings}
        ON ${meetings.id} = ${meetingArtifacts.meetingId}
      WHERE ${meetings.billingPrincipalType} = ${principal.type}
        AND ${meetings.billingPrincipalId} = ${principal.id}
    ), 0)
    + COALESCE((
      SELECT SUM(${whiteboardAssets.size})
      FROM ${whiteboardAssets}
      INNER JOIN ${spaces} ON ${spaces.id} = ${whiteboardAssets.spaceId}
      WHERE ${whiteboardAssets.status} = 'committed'
        AND ${ownsSpace}
    ), 0)
  `;
}

export async function getPrincipalStoredBytes(
  db: Database,
  principal: StoragePrincipal,
): Promise<number> {
  const result = await db.get<{ total: number }>(
    sql`SELECT ${principalStoredBytesSql(principal)} AS total`,
  );
  return result?.total ?? 0;
}

export async function getUserStoredBytes(db: Database, userId: string): Promise<number> {
  return getPrincipalStoredBytes(db, { type: "user", id: userId });
}
