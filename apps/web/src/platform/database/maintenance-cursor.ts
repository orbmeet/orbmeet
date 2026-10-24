import type { Database } from "@orbmeet/db";
import { maintenanceCursors } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { withD1Retry } from "./db-utils";

/**
 * Where a maintenance scan left off, so the next run resumes past it and one
 * row that keeps failing cannot hold back everything ordered after it.
 */
export async function readMaintenanceCursor(db: Database, job: string): Promise<string | null> {
  const saved = await db.query.maintenanceCursors.findFirst({
    where: { job },
    columns: { cursorId: true },
  });
  return saved?.cursorId ?? null;
}

/** Remember the scan's position, or forget it (null) once the scan wrapped. */
export async function writeMaintenanceCursor(
  db: Database,
  job: string,
  cursor: string | null,
): Promise<void> {
  if (cursor === null) {
    await withD1Retry(() => db.delete(maintenanceCursors).where(eq(maintenanceCursors.job, job)), {
      idempotent: true,
    });
    return;
  }
  // `cursor_at` only satisfies the table's shape check; the position is the id.
  const row = { cursorAt: new Date(0), cursorId: cursor, updatedAt: new Date() };
  await withD1Retry(
    () =>
      db
        .insert(maintenanceCursors)
        .values({ job, ...row })
        .onConflictDoUpdate({ target: maintenanceCursors.job, set: row }),
    { idempotent: true },
  );
}
