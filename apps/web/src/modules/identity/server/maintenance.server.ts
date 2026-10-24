import "@tanstack/react-start/server-only";

import { createDb, type Database } from "@orbmeet/db";
import { devices, sessions, verifications } from "@orbmeet/db/schema";
import { sql } from "drizzle-orm";
import { getRunChanges, withD1Retry } from "@/platform/database/db-utils";

const AUTH_CLEANUP_BATCH_LIMIT = 500;


export interface AuthenticationCleanupResult {
  sessions: number;
  devices: number;
  verifications: number;
}

/**
 * Delete expired authentication material in bounded indexed batches. The
 * subqueries keep each table to one D1 statement and let a later daily run
 * continue naturally when a backlog is larger than the batch limit.
 */
export async function cleanupExpiredAuthenticationData(
  db: Database,
  now = new Date(),
): Promise<AuthenticationCleanupResult> {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const [sessionResult, deviceResult, verificationResult] = await Promise.all([
    withD1Retry(
      () =>
        db.run(sql`
          delete from ${sessions}
          where ${sessions.id} in (
            select ${sessions.id} from ${sessions}
            where ${sessions.expiresAt} <= ${nowSeconds}
               or ${sessions.absoluteExpiresAt} <= ${nowSeconds}
            order by ${sessions.expiresAt}, ${sessions.id}
            limit ${AUTH_CLEANUP_BATCH_LIMIT}
          )
        `),
      { idempotent: true },
    ),
    withD1Retry(
      () =>
        db.run(sql`
          delete from ${devices}
          where ${devices.id} in (
            select ${devices.id} from ${devices}
            where ${devices.expiresAt} <= ${nowSeconds}
            order by ${devices.expiresAt}, ${devices.id}
            limit ${AUTH_CLEANUP_BATCH_LIMIT}
          )
        `),
      { idempotent: true },
    ),
    withD1Retry(
      () =>
        db.run(sql`
          delete from ${verifications}
          where ${verifications.id} in (
            select ${verifications.id} from ${verifications}
            where ${verifications.expiresAt} <= ${nowSeconds}
            order by ${verifications.expiresAt}, ${verifications.id}
            limit ${AUTH_CLEANUP_BATCH_LIMIT}
          )
        `),
      { idempotent: true },
    ),
  ]);

  return {
    sessions: getRunChanges(sessionResult),
    devices: getRunChanges(deviceResult),
    verifications: getRunChanges(verificationResult),
  };
}

export async function runAuthenticationMaintenance(
  env: Env,
  now = new Date(),
): Promise<AuthenticationCleanupResult> {
  return cleanupExpiredAuthenticationData(createDb(env.DB), now);
}
