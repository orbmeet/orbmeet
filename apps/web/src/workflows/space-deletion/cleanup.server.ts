import "@tanstack/react-start/server-only";

import type { Database } from "@orbmeet/db";
import {
  whiteboardFileReferences,
  meetingAdmissions,
  meetingArtifacts,
  meetingWhiteboards,
  meetings,
  files,
  spaces,
  whiteboardAssetReferences,
  whiteboards,
} from "@orbmeet/db/schema";
import { and, asc, eq, inArray, isNotNull, lte, ne, or, sql } from "drizzle-orm";
import { internalWhiteboardPrefix, whiteboardPrefix } from "@/platform/storage/r2-keys";
import { getRunChanges } from "@/platform/database/db-utils";
import {
  consumeR2CleanupOperation,
  createR2CleanupBudget,
  deleteMeetingR2Namespaces,
  deleteR2Prefix,
  enqueueR2ObjectCleanup,
  type R2CleanupBudget,
} from "@/modules/assets/server/r2-cleanup.server";
import { callCoordinator } from "@/modules/meetings/server/runtime/client.server";
import { logError } from "@/lib/logger";
import { whiteboardCapturesSettled } from "@/modules/whiteboards/server/meeting/capture";
import { purgeWhiteboardRoom } from "@/modules/whiteboards/server/purge.server";
import { startJob, type Job, type JobStep } from "@/platform/jobs/jobs";
import { runSerially } from "@/app/serial/serial";

const METADATA_BATCH_LIMIT = 90;
/** How long a purge waits for an ended meeting's coordinator to drain. */
const DRAIN_GIVE_UP_MS = 7 * 24 * 60 * 60_000;

function drainGiveUpCutoff(now: Date): Date {
  return new Date(now.getTime() - DRAIN_GIVE_UP_MS);
}
const ADMISSION_BATCH_LIMIT = 10;
const SESSION_BATCH_LIMIT = 3;


/** What one pass did: finished, removed something and can go on, or must wait. */
export type CleanupPass = "done" | "progress" | "waiting";

async function cleanupMeeting(
  db: Database,
  env: Env,
  meeting: typeof meetings.$inferSelect,
  r2Budget: R2CleanupBudget,
): Promise<CleanupPass> {
  const current = meeting;
  if (current.status === "open") {
    // The coordinator ends it and tears down its room; the purge resumes once
    // it has drained.
    await callCoordinator(env, {
      kind: "command",
      meetingId: current.id,
      command: { kind: "end", subject: { kind: "system" }, reason: "system" },
    }).catch((error: unknown) => logError("[spaces] Could not end a meeting", { meetingId: current.id }, error));
    return "waiting";
  }
  // A recording may still be uploading after the end. A media plane that has
  // been unreachable for the whole give-up window must not block deletion.
  if (!current.drainedAt && current.endedAt && current.endedAt > drainGiveUpCutoff(new Date())) {
    await callCoordinator(env, { kind: "wake", meetingId: current.id }).catch(() => undefined);
    return "waiting";
  }

  // The meeting's capture job pins the history of the Whiteboards it
  // presented; a purge waits for it, within the same give-up window.
  if (
    current.endedAt && current.endedAt > drainGiveUpCutoff(new Date())
    && !(await whiteboardCapturesSettled(db, current.id))
  ) return "waiting";

  const artifacts = await db
    .select({ id: meetingArtifacts.id, r2Key: meetingArtifacts.r2Key })
    .from(meetingArtifacts)
    .where(eq(meetingArtifacts.meetingId, current.id))
    .limit(METADATA_BATCH_LIMIT);
  if (artifacts.length > 0) {
    consumeR2CleanupOperation(r2Budget);
    await env.R2_BUCKET.delete(artifacts.map((artifact) => artifact.r2Key));
    await db.delete(meetingArtifacts).where(
      inArray(
        meetingArtifacts.id,
        artifacts.map((artifact) => artifact.id),
      ),
    );
    return "progress";
  }

  const admissions = await db
    .select({ id: meetingAdmissions.id })
    .from(meetingAdmissions)
    .where(eq(meetingAdmissions.meetingId, current.id))
    .limit(ADMISSION_BATCH_LIMIT);
  if (admissions.length > 0) {
    await db.delete(meetingAdmissions).where(
      inArray(
        meetingAdmissions.id,
        admissions.map((item) => item.id),
      ),
    );
    return "progress";
  }

  // Delete the whole per-Meeting namespace so unregistered recorder output and
  // internal Whiteboard state cannot be orphaned after the Meeting row is gone.
  // Whiteboards belong to the Space and may be used by other Meetings. A
  // Meeting purge removes only Meeting-scoped objects; Space deletion later
  // purges each durable board aggregate explicitly.
  await deleteMeetingR2Namespaces(db, env.R2_BUCKET, current.id, null, r2Budget);
  const deleted = await db.delete(meetings).where(
    and(
      eq(meetings.id, current.id),
      eq(meetings.status, "ended"),
      or(isNotNull(meetings.drainedAt), lte(meetings.endedAt, drainGiveUpCutoff(new Date()))),
    ),
  );
  return getRunChanges(deleted) > 0 ? "done" : "waiting";
}

export async function cleanupArchivedSpace(
  db: Database,
  env: Env,
  spaceId: string,
): Promise<CleanupPass> {
  const r2Budget = createR2CleanupBudget();
  const archived = await db.query.spaces.findFirst({
    where: { RAW: (row) => and(eq(row.id, spaceId), isNotNull(row.archivedAt))! },
    columns: { id: true },
  });
  if (!archived) return "done";

  for (let index = 0; index < SESSION_BATCH_LIMIT; index += 1) {
    const meeting = await db.query.meetings.findFirst({
      where: { spaceId: spaceId },
    });
    if (!meeting) break;
    const pass = await cleanupMeeting(db, env, meeting, r2Budget);
    if (pass !== "done") return pass;
  }

  const remainingMeeting = await db.query.meetings.findFirst({
    where: { spaceId: spaceId },
    columns: { id: true },
  });
  if (remainingMeeting) return "progress";

  await db.run(sql`
    delete from ${whiteboardFileReferences}
    where ${whiteboardFileReferences.spaceId} = ${spaceId}
  `);

  const assets = await db
    .select({ id: files.id, r2Key: files.r2Key })
    .from(files)
    .where(eq(files.spaceId, spaceId))
    .limit(METADATA_BATCH_LIMIT);
  if (assets.length > 0) {
    consumeR2CleanupOperation(r2Budget);
    await env.R2_BUCKET.delete(assets.map((asset) => asset.r2Key));
    await db.delete(files).where(
      inArray(
        files.id,
        assets.map((asset) => asset.id),
      ),
    );
    return "progress";
  }

  const boards = await db
    .select({ id: whiteboards.id })
    .from(whiteboards)
    .where(eq(whiteboards.spaceId, spaceId))
    .orderBy(asc(whiteboards.id))
    .limit(METADATA_BATCH_LIMIT);
  if (boards.length > 0) {
    for (const board of boards) {
      // Reserve enough capacity for the normal one-page case before starting
      // another board. Larger prefixes persist their own cursor and resume.
      if (r2Budget.remainingOperations < 4) break;
      const { remainingOperations } = await runSerially(env, {
        kind: "purgeSpaceWhiteboard",
        spaceId,
        whiteboardId: board.id,
        r2Operations: r2Budget.remainingOperations,
      });
      r2Budget.remainingOperations = remainingOperations;
    }
    return "progress";
  }

  const deleted = await db.delete(spaces).where(
    and(
      eq(spaces.id, spaceId),
      isNotNull(spaces.archivedAt),
      sql`not exists (
          select 1 from ${meetings}
          where ${meetings.spaceId} = ${spaceId}
        )`,
      sql`not exists (
          select 1 from ${meetingArtifacts}
          where ${meetingArtifacts.spaceId} = ${spaceId}
        )`,
      sql`not exists (
          select 1 from ${files}
          where ${files.spaceId} = ${spaceId}
        )`,
      sql`not exists (
          select 1 from ${whiteboards}
          where ${whiteboards.spaceId} = ${spaceId}
        )`,
    ),
  );
  // Something still references the Space (an artifact whose meeting is gone
  // waits on its own cleanup); look again later rather than spin.
  return getRunChanges(deleted) > 0 ? "done" : "waiting";
}

/**
 * Remove one of a deleted Space's boards: its room, its R2 namespace (less
 * what other Spaces' copies still reference) and its row. Runs in the board's
 * serial scope, so no copy of it is in progress; the R2 operation budget
 * comes in and goes back as a count.
 */
export async function purgeSpaceWhiteboard(
  db: Database,
  env: Env,
  { spaceId, whiteboardId, r2Operations }: { spaceId: string; whiteboardId: string; r2Operations: number },
): Promise<{ remainingOperations: number }> {
  const r2Budget = createR2CleanupBudget(r2Operations);
  const current = await db
    .select({ id: whiteboards.id })
    .from(whiteboards)
    .where(and(eq(whiteboards.id, whiteboardId), eq(whiteboards.spaceId, spaceId)))
    .get();
  if (!current) return { remainingOperations: r2Budget.remainingOperations };

  const [foreignUsage] = await db
    .select({ id: meetingWhiteboards.id })
    .from(meetingWhiteboards)
    .innerJoin(meetings, eq(meetings.id, meetingWhiteboards.meetingId))
    .where(and(eq(meetingWhiteboards.whiteboardId, whiteboardId), ne(meetings.spaceId, spaceId)))
    .limit(1);
  if (foreignUsage) {
    throw new Error(
      "Whiteboard ownership invariant violated: refusing to delete R2 data referenced by another Space",
    );
  }

  // Queue assets this board borrowed before its outgoing references
  // disappear through the board cascade. If no other owner remains, the
  // central cleanup worker will remove the physical source object.
  const borrowedAssets = await db
    .select({ r2Key: whiteboardAssetReferences.r2Key })
    .from(whiteboardAssetReferences)
    .where(eq(whiteboardAssetReferences.whiteboardId, whiteboardId));
  await enqueueR2ObjectCleanup(
    db,
    borrowedAssets.map((row) => row.r2Key),
  );

  // Incoming references are stable here: duplication runs in this same
  // serial scope before it reads the source.
  const retainedAssets = await db
    .select({ r2Key: whiteboardAssetReferences.r2Key })
    .from(whiteboardAssetReferences)
    .innerJoin(whiteboards, eq(whiteboards.id, whiteboardAssetReferences.whiteboardId))
    .where(
      and(
        eq(whiteboardAssetReferences.sourceWhiteboardId, whiteboardId),
        ne(whiteboards.spaceId, spaceId),
      ),
    );
  await purgeWhiteboardRoom(env, whiteboardId);
  await deleteR2Prefix(db, env.R2_BUCKET, internalWhiteboardPrefix(whiteboardId), r2Budget);
  await deleteR2Prefix(
    db,
    env.R2_BUCKET,
    whiteboardPrefix(whiteboardId),
    r2Budget,
    new Set(retainedAssets.map((row) => row.r2Key)),
  );
  await db
    .delete(whiteboards)
    .where(and(eq(whiteboards.id, whiteboardId), eq(whiteboards.spaceId, spaceId)));
  return { remainingOperations: r2Budget.remainingOperations };
}

type SpacePurge = Extract<Job, { kind: "purgeSpace" }>;

const WAIT_MIN_MS = 60_000;
const WAIT_MAX_MS = 60 * 60_000;

/**
 * Remove an archived Space and everything in it, a bounded pass per step.
 * A pass that removed something is followed at once; one that must wait (a
 * meeting draining, a capture pending) sleeps, backing off from a minute to
 * an hour. Sleeps do not count toward the Workflow's step limit.
 */
export async function purgeSpace(step: JobStep, db: Database, env: Env, job: SpacePurge): Promise<void> {
  let wait = WAIT_MIN_MS;
  for (let pass = 1; ; pass += 1) {
    const result = await step.do(`pass ${pass}`, () => cleanupArchivedSpace(db, env, job.spaceId));
    if (result === "done") return;
    if (result === "progress") {
      wait = WAIT_MIN_MS;
      continue;
    }
    await step.sleepUntil(`wait ${pass}`, Date.now() + wait);
    wait = Math.min(wait * 2, WAIT_MAX_MS);
  }
}

/** A purge normally starts with the deletion request; see resumeStrandedSpacePurges. */
const STRANDED_PURGE_GRACE_MS = 60 * 60_000;
const STRANDED_PURGE_BATCH_LIMIT = 25;

/**
 * Start again the purges that failed for good or never started: archived
 * Spaces past the grace period. Starting is idempotent (the job id names the
 * Space), so a purge still running is left alone.
 */
export async function resumeStrandedSpacePurges(
  db: Database,
  env: Pick<Env, "JOBS">,
  now = new Date(),
): Promise<number> {
  const stranded = await db
    .select({ id: spaces.id, archivedAt: spaces.archivedAt })
    .from(spaces)
    .where(and(
      isNotNull(spaces.archivedAt),
      lte(spaces.archivedAt, new Date(now.getTime() - STRANDED_PURGE_GRACE_MS)),
    ))
    .orderBy(asc(spaces.archivedAt), asc(spaces.id))
    .limit(STRANDED_PURGE_BATCH_LIMIT);
  for (const space of stranded) {
    await startJob(env, {
      kind: "purgeSpace",
      spaceId: space.id,
      requestedAt: space.archivedAt!.getTime(),
    }, { restartFailed: true });
  }
  return stranded.length;
}
