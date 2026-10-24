import "@tanstack/react-start/server-only";
import type { Database } from "@orbmeet/db";
import {
  meetingArtifacts,
  meetingWhiteboards,
  meetings,
  files,
  whiteboardAssetReferences,
  whiteboardAssets,
  whiteboards,
} from "@orbmeet/db/schema";
import { and, eq, inArray, ne } from "drizzle-orm";
import { boundedStatements, chunkArray } from "@/platform/database/db-batching";
import {
  internalMeetingPrefix,
  internalWhiteboardPrefix,
  meetingPrefix,
  spacePrefix,
  whiteboardPrefix,
} from "@/platform/storage/r2-keys";
import { withD1Retry } from "@/platform/database/db-utils";
import type { JobStep, JobStepConfig } from "@/platform/jobs/jobs";
import {
  consumeR2CleanupOperation,
  createR2CleanupBudget,
  deleteR2Prefix,
  referencedWhiteboardAssetKeys,
  type R2CleanupBudget,
} from "@/modules/assets/server/r2-cleanup.server";

const R2_DELETE_BATCH_SIZE = 1000;

/** A prefix is paged in budgeted steps; one that runs out resumes from its cursor. */
const PREFIX_STEP: JobStepConfig = {
  retries: { limit: 20, delay: 60_000, backoff: "exponential" },
  timeout: 10 * 60_000,
};
export const ACCOUNT_UPLOAD_URL_GRACE_MS = 65 * 60_000;

interface AccountMeeting {
  id: string;
}

async function loadAccountMeetings(
  db: Database,
  meetingLinkIds: string[],
): Promise<AccountMeeting[]> {
  if (meetingLinkIds.length === 0) return [];

  const rows = new Map<string, AccountMeeting>();
  for (const lookup of boundedStatements(meetingLinkIds, (ids) =>
    db.select({ id: meetings.id }).from(meetings).where(inArray(meetings.meetingLinkId, ids)))) {
    for (const meeting of await lookup) rows.set(meeting.id, meeting);
  }
  return [...rows.values()];
}

async function deleteR2Keys(
  bucket: R2Bucket,
  keys: Iterable<string>,
  budget: R2CleanupBudget,
): Promise<void> {
  const uniqueKeys = [...new Set(keys)];
  for (const chunk of chunkArray(uniqueKeys, R2_DELETE_BATCH_SIZE)) {
    consumeR2CleanupOperation(budget);
    await bucket.delete(chunk);
  }
}

/**
 * Delete all R2 data that account deletion intentionally removes while the
 * relational ownership metadata still exists. Any failure aborts account
 * deletion so a later attempt can discover and retry every object.
 */
export async function cleanupAccountR2Objects(
  db: Database,
  env: Pick<Env, "R2_BUCKET">,
  userId: string,
  scope: { meetingLinkIds: string[]; personalSpaceId: string | null },
): Promise<{ meetingIds: string[]; whiteboardIds: string[] }> {
  const { meetingLinkIds, personalSpaceId } = scope;
  const accountMeetings = await loadAccountMeetings(db, meetingLinkIds);
  const meetingIds = accountMeetings.map((meeting) => meeting.id);
  const artifactKeys = new Set<string>();
  const personalWhiteboards = personalSpaceId
    ? await db
        .select({ id: whiteboards.id })
        .from(whiteboards)
        .where(eq(whiteboards.spaceId, personalSpaceId))
    : [];
  if (personalWhiteboards.length > 0 && personalSpaceId) {
    const usageLookups = boundedStatements(personalWhiteboards.map((board) => board.id), (whiteboardIds) =>
      db
        .select({ id: meetingWhiteboards.id })
        .from(meetingWhiteboards)
        .innerJoin(meetings, eq(meetings.id, meetingWhiteboards.meetingId))
        .where(and(
          inArray(meetingWhiteboards.whiteboardId, whiteboardIds),
          ne(meetings.spaceId, personalSpaceId),
        ))
        .limit(1));
    for (const lookup of usageLookups) {
      const [foreignUsage] = await lookup;
      if (foreignUsage) {
        throw new Error(
          "Whiteboard ownership invariant violated: refusing to delete R2 data referenced by another Space",
        );
      }
    }
  }

  const uploadedFiles = personalSpaceId
    ? await db
      .select({ r2Key: files.r2Key })
      .from(files)
      .where(and(
        eq(files.uploadedByUserId, userId),
        eq(files.spaceId, personalSpaceId),
      ))
    : [];
  for (const asset of uploadedFiles) {
    artifactKeys.add(asset.r2Key);
  }
  // Recordings not yet registered live under the meeting's own prefix, which
  // is deleted with it.
  for (const lookup of boundedStatements(meetingIds, (ids) =>
    db.select({ r2Key: meetingArtifacts.r2Key }).from(meetingArtifacts).where(inArray(meetingArtifacts.meetingId, ids)))) {
    for (const artifact of await lookup) artifactKeys.add(artifact.r2Key);
  }

  const pendingWhiteboardAssets = await db
    .select({ id: whiteboardAssets.id, r2Key: whiteboardAssets.r2Key })
    .from(whiteboardAssets)
    .where(and(
      eq(whiteboardAssets.uploadedByUserId, userId),
      eq(whiteboardAssets.status, "pending"),
    ));
  for (const asset of pendingWhiteboardAssets) artifactKeys.add(asset.r2Key);

  // Each prefix normally costs one list plus one batch delete. Size the shared
  // budget to the account being deleted so several meetings cannot exhaust the
  // fixed maintenance-job default before cleanup reaches their namespaces.
  const prefixCount =
    (meetingIds.length + personalWhiteboards.length) * 2;
  const keyDeleteCount = Math.ceil(artifactKeys.size / R2_DELETE_BATCH_SIZE);
  const r2Budget = createR2CleanupBudget(
    Math.max(16, keyDeleteCount + prefixCount * 2),
  );
  await deleteR2Keys(env.R2_BUCKET, artifactKeys, r2Budget);
  for (const meetingId of meetingIds) {
    await deleteR2Prefix(db, env.R2_BUCKET, meetingPrefix(meetingId), r2Budget);
    await deleteR2Prefix(db, env.R2_BUCKET, internalMeetingPrefix(meetingId), r2Budget);
  }
  for (const whiteboard of personalWhiteboards) {
    await deleteR2Prefix(
      db,
      env.R2_BUCKET,
      internalWhiteboardPrefix(whiteboard.id),
      r2Budget,
    );
    const retainedAssets = await db
      .select({ r2Key: whiteboardAssetReferences.r2Key })
      .from(whiteboardAssetReferences)
      .innerJoin(whiteboards, eq(whiteboards.id, whiteboardAssetReferences.whiteboardId))
      .where(and(
        eq(whiteboardAssetReferences.sourceWhiteboardId, whiteboard.id),
        ne(whiteboards.spaceId, personalSpaceId!),
      ));
    await deleteR2Prefix(
      db,
      env.R2_BUCKET,
      whiteboardPrefix(whiteboard.id),
      r2Budget,
      new Set(retainedAssets.map((asset) => asset.r2Key)),
    );
  }
  for (const deletion of boundedStatements(pendingWhiteboardAssets.map((asset) => asset.id), (ids) =>
    db.delete(whiteboardAssets).where(inArray(whiteboardAssets.id, ids)))) {
    await withD1Retry(() => deletion, { idempotent: true });
  }

  for (const deletion of boundedStatements(meetingIds, (ids) =>
    db.delete(meetingArtifacts).where(inArray(meetingArtifacts.meetingId, ids)))) {
    await withD1Retry(() => deletion, { idempotent: true });
  }
  if (personalSpaceId) {
    await withD1Retry(
      () => db.delete(whiteboards).where(eq(whiteboards.spaceId, personalSpaceId)),
      { idempotent: true },
    );
  }
  // Meeting links are origin lineage, not history owners. Remove the Meetings
  // explicitly after their objects are gone; the caller may delete the now-
  // unreferenced personal Links afterward without relying on an FK cascade.
  for (const deletion of boundedStatements(meetingIds, (ids) => db.delete(meetings).where(inArray(meetings.id, ids)))) {
    await withD1Retry(() => deletion, { idempotent: true });
  }
  return {
    meetingIds,
    whiteboardIds: personalWhiteboards.map((whiteboard) => whiteboard.id),
  };
}

/**
 * The most steps the prefix deletion takes, however large the account: far
 * below a Workflow's step limit (10,000 by default), whatever the plan allows.
 */
const MAX_PREFIX_STEPS = 1_000;
/** Prefixes per step for an ordinary account: most prefixes hold a few objects. */
const MIN_PREFIXES_PER_STEP = 50;

/**
 * Delete what a deleted account's upload URLs could still write, once they
 * have all expired: its personal Space's, meetings' and whiteboards' R2
 * prefixes. Prefixes are deleted in batches, one step each. A step that runs
 * out of budget is retried: a finished prefix lists empty at once, and an
 * unfinished one resumes from its saved cursor.
 */
export async function runAccountCleanup(
  step: JobStep,
  db: Database,
  env: Pick<Env, "R2_BUCKET">,
  input: {
    personalSpaceId: string | null;
    meetingIds: string[];
    whiteboardIds: string[];
    requestedAt: number;
  },
  /** Delete a board's room database on the whiteboard node (the board itself). */
  purgeWhiteboardRoom: (whiteboardId: string) => Promise<void>,
): Promise<void> {
  await step.sleepUntil("let upload URLs expire", input.requestedAt + ACCOUNT_UPLOAD_URL_GRACE_MS);

  for (const [index, batch] of chunkArray([...new Set(input.whiteboardIds)], 50).entries()) {
    await step.do(`whiteboard rooms, batch ${index + 1}`, PREFIX_STEP, async () => {
      for (const whiteboardId of batch) await purgeWhiteboardRoom(whiteboardId);
      return null;
    });
  }

  const prefixes: Array<{ key: string; whiteboardId?: string }> = [];
  if (input.personalSpaceId) prefixes.push({ key: spacePrefix(input.personalSpaceId) });
  for (const meetingId of new Set(input.meetingIds)) {
    prefixes.push({ key: meetingPrefix(meetingId) }, { key: internalMeetingPrefix(meetingId) });
  }
  for (const whiteboardId of new Set(input.whiteboardIds)) {
    // Assets another Space's copy still references stay.
    prefixes.push({ key: internalWhiteboardPrefix(whiteboardId) }, { key: whiteboardPrefix(whiteboardId), whiteboardId });
  }

  const perStep = Math.max(MIN_PREFIXES_PER_STEP, Math.ceil(prefixes.length / MAX_PREFIX_STEPS));
  for (const [index, batch] of chunkArray(prefixes, perStep).entries()) {
    await step.do(`R2 prefixes, batch ${index + 1}`, PREFIX_STEP, async () => {
      for (const prefix of batch) {
        const retained = prefix.whiteboardId ? await referencedWhiteboardAssetKeys(db, prefix.whiteboardId) : undefined;
        await deleteR2Prefix(db, env.R2_BUCKET, prefix.key, createR2CleanupBudget(), retained);
      }
      return null;
    });
  }
}

