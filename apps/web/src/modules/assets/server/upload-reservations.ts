import { uploadReservations, type Database } from "@orbmeet/db";
import { and, eq, lte, sql } from "drizzle-orm";
import { getRunChanges, withD1Retry } from "@/platform/database/db-utils";
import { principalStoredBytesSql, type StoragePrincipal } from "@/modules/assets/server/storage";

const RESERVATION_TTL_MS = 10 * 60 * 1000;

export interface UploadReservationIdentity {
  id: string;
  principal?: string;
  scope: string;
}

/** Build the scoped DELETE so callers can commit it in a larger D1 batch. */
export function releaseUploadReservationStatement(
  db: Database,
  input: UploadReservationIdentity,
) {
  const conditions = [
    eq(uploadReservations.id, input.id),
    eq(uploadReservations.scope, input.scope),
  ];
  if (input.principal !== undefined) {
    conditions.push(eq(uploadReservations.principal, input.principal));
  }
  return db.delete(uploadReservations).where(and(...conditions));
}

// Release a reservation early instead of waiting out RESERVATION_TTL_MS. Used
// when an upload/import is aborted (e.g. a failed PDF render) so the reserved
// bytes don't keep counting against the principal's quota for the full TTL.
// Idempotent: deleting an absent/expired row is a no-op.
//
// `principal` is optional because crash recovery has no participant left to
// resolve one from. It is extra scoping rather than authorization — `id` is the
// import/upload id and `scope` already names the owning resource, so the pair
// identifies exactly one row. Callers that *do* have a principal keep passing
// it, so an ordinary release still cannot touch another principal's row.
export async function releaseUploadReservation(
  db: Database,
  input: UploadReservationIdentity,
): Promise<void> {
  // Deleting an absent row is a no-op, so this is safe to retry — and worth
  // retrying: a transient failure here keeps the reserved bytes counting
  // against the principal's quota for the full 10-minute TTL.
  await withD1Retry(
    () => releaseUploadReservationStatement(db, input),
    { idempotent: true },
  );
}

export async function reserveUploadBytes(
  db: Database,
  input: {
    id?: string;
    principal: StoragePrincipal;
    scope: string;
    bytes: number;
    limitBytes: number | null;
    ttlMs?: number;
  },
): Promise<string> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? RESERVATION_TTL_MS));
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const expiresAtSeconds = Math.floor(expiresAt.getTime() / 1000);
  const id = input.id ?? crypto.randomUUID();
  const principalKey = `${input.principal.type}:${input.principal.id}`;

  await withD1Retry(
    () => db.delete(uploadReservations).where(lte(uploadReservations.expiresAt, now)),
    { idempotent: true },
  );

  const committedUsage = principalStoredBytesSql(input.principal);
  const withinLimit = input.limitBytes === null
    ? sql`1`
    : sql`
        ${committedUsage}
        + COALESCE((
          SELECT SUM(bytes)
          FROM upload_reservations
          WHERE principal = ${principalKey}
            AND expires_at > ${nowSeconds}
            AND id <> ${id}
        ), 0)
        + ${input.bytes}
        <= ${input.limitBytes}
      `;

  const result = await db.run(sql`
      INSERT INTO upload_reservations
        (id, principal, scope, bytes, expires_at, created_at)
      SELECT
        ${id},
        ${principalKey},
        ${input.scope},
        ${input.bytes},
        ${expiresAtSeconds},
        ${nowSeconds}
      WHERE ${withinLimit}
      ON CONFLICT(id) DO UPDATE SET
        bytes = excluded.bytes,
        expires_at = excluded.expires_at,
        created_at = excluded.created_at
      WHERE upload_reservations.principal = excluded.principal
        AND upload_reservations.scope = excluded.scope
    `);

  if (getRunChanges(result) === 0) {
    throw new Error("upload_quota_exceeded");
  }

  return id;
}
