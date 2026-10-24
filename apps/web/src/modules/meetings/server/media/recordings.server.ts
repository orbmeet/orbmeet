import { createDb, type Database } from "@orbmeet/db";
import { meetingArtifacts, meetings, uploadReservations } from "@orbmeet/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import * as v from "valibot";
import { generateId } from "@/lib/ids";
import { logError, logWarn } from "@/lib/logger";
import { principalStoredBytesSql } from "@/modules/assets/server/storage";
import { r2KeyBeingDeletedSql } from "@/modules/assets/server/r2-cleanup.server";
import { resolveMeetingEntitlement } from "@/modules/billing/server/entitlements.server";
import { boundedStatements } from "@/platform/database/db-batching";
import { readMaintenanceCursor, writeMaintenanceCursor } from "@/platform/database/maintenance-cursor";
import { meetingIdOfRecordingKey } from "@/platform/storage/r2-keys";
import { RECORDING_UPLOAD_MAX_RETRIES, recordingRetryDelaySeconds } from "./recordings-queue";

/**
 * Recordings are registered from R2 itself: every object LiveKit uploads under
 * a meeting's recordings prefix raises an `object-create` event notification
 * on the recordings queue (recordings-queue.ts). A recording exists exactly
 * when its object does, so registration does not depend on the meeting still
 * following its egress, nor on LiveKit still remembering it.
 *
 * The notification is the prompt way, not the only one. Its rule lives on the
 * bucket, outside this repository's configuration, and a message is dropped
 * once its retries run out; `registerUnregisteredRecordings` walks the
 * recordings themselves and registers whatever the queue did not. Both paths
 * register through `registerRecordingObject`, which is idempotent.
 */

/** What R2 sends for an `object-create` event; only what is used here is checked. */
const objectCreatedSchema = v.object({
  object: v.object({ key: v.string(), size: v.pipe(v.number(), v.safeInteger(), v.minValue(0)) }),
});

export async function registerUploadedRecordings(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const db = createDb(env.DB);
  for (const message of batch.messages) {
    try {
      await registerUploadedRecording(db, env.R2_BUCKET, message.body);
      message.ack();
    } catch (error) {
      if (message.attempts > RECORDING_UPLOAD_MAX_RETRIES) {
        // The daily sweep (`registerUnregisteredRecordings`) registers it.
        logError("[recordings] Leaving an uploaded recording to the sweep", { attempts: message.attempts, event: message.body }, error);
        message.ack();
      } else {
        logWarn("[recordings] Could not register an uploaded recording", { attempt: message.attempts }, error);
        message.retry({ delaySeconds: recordingRetryDelaySeconds(message.attempts) });
      }
    }
  }
}

/** Register one uploaded recording, or delete it when it may not be kept. */
export async function registerUploadedRecording(db: Database, bucket: R2Bucket, body: unknown): Promise<void> {
  const event = v.safeParse(objectCreatedSchema, body);
  if (!event.success) {
    // Never valid however often it is retried.
    logError("[recordings] Ignoring a malformed R2 event notification:", body);
    return;
  }
  await registerRecordingObject(db, bucket, event.output.object, new Date());
}

/**
 * Register an object in R2 as its meeting's recording, or delete it when it
 * may not be kept. Any other object is left alone.
 */
async function registerRecordingObject(
  db: Database,
  bucket: R2Bucket,
  object: { key: string; size: number },
  now: Date,
): Promise<void> {
  const meetingId = meetingIdOfRecordingKey(object.key);
  if (meetingId === null) return;

  const committed = await commitRecordingArtifact(db, bucket, { meetingId, r2Key: object.key, bytes: object.size, now });
  if (!committed) {
    // Its meeting is gone, it does not fit the quota, or it is already being
    // deleted: nothing may keep it.
    logWarn("[recordings] Deleting a recording that cannot be registered", { key: object.key });
    await bucket.delete(object.key);
  }
}

/** Where the walk over every meeting's objects resumes. */
const UNREGISTERED_RECORDINGS_CURSOR = "recordings:unregistered";
/** Longer than the queue takes to deliver and retry an upload's first attempts. */
const UNREGISTERED_RECORDING_MIN_AGE_MS = 6 * 60 * 60_000;
const UNREGISTERED_RECORDINGS_PAGE_SIZE = 1_000;
const UNREGISTERED_RECORDINGS_PAGES_PER_RUN = 20;

/**
 * Register every uploaded recording the queue has not, some pages of the
 * bucket's meetings at a time, resuming where the last run stopped. An upload
 * younger than {@link UNREGISTERED_RECORDING_MIN_AGE_MS} is left to its
 * notification. Each one found is an error worth reading: either the bucket's
 * notification rule is missing, or the queue gave up on a delivery.
 */
export async function registerUnregisteredRecordings(
  db: Database,
  bucket: R2Bucket,
  now: Date,
): Promise<{ registered: number }> {
  let cursor = (await readMaintenanceCursor(db, UNREGISTERED_RECORDINGS_CURSOR)) ?? undefined;
  let registered = 0;
  for (let page = 0; page < UNREGISTERED_RECORDINGS_PAGES_PER_RUN; page += 1) {
    const listed = await bucket.list({ prefix: "meetings/", limit: UNREGISTERED_RECORDINGS_PAGE_SIZE, ...(cursor && { cursor }) });
    const recordings = listed.objects.filter((object) =>
      meetingIdOfRecordingKey(object.key) !== null
      && now.getTime() - object.uploaded.getTime() >= UNREGISTERED_RECORDING_MIN_AGE_MS);
    const known = new Set<string>();
    for (const lookup of boundedStatements(recordings.map((object) => object.key), (keys) =>
      db.select({ r2Key: meetingArtifacts.r2Key }).from(meetingArtifacts).where(inArray(meetingArtifacts.r2Key, keys)))) {
      for (const row of await lookup) known.add(row.r2Key);
    }
    for (const object of recordings) {
      if (known.has(object.key)) continue;
      logError("[recordings] Registering a recording its upload notification did not", { key: object.key });
      await registerRecordingObject(db, bucket, object, now);
      registered += 1;
    }
    if (listed.truncated && !listed.cursor) throw new Error("R2 returned a truncated page without a cursor for meetings/");
    cursor = listed.truncated ? listed.cursor : undefined;
    await writeMaintenanceCursor(db, UNREGISTERED_RECORDINGS_CURSOR, cursor ?? null);
    if (!cursor) break;
  }
  return { registered };
}

/**
 * Register a recording if it fits the billing principal's storage quota. The
 * artifact row is its own quota claim: one statement checks current usage
 * (committed storage plus live upload reservations) and inserts, so nothing is
 * counted twice and no reservation outlives the check.
 *
 * A new reference to an object, so it follows the cleanup queue's rule (see
 * `r2KeyBeingDeletedSql`): refused while the object is being deleted, and kept
 * only if the object outlived the insert. That is also what keeps a late or
 * repeated event from registering a recording that was deleted meanwhile.
 *
 * Idempotent on `r2Key`. Resolves whether the recording is registered.
 */
export async function commitRecordingArtifact(
  db: Database,
  bucket: R2Bucket,
  input: { meetingId: string; r2Key: string; bytes: number; now: Date },
): Promise<boolean> {
  if (meetingIdOfRecordingKey(input.r2Key) !== input.meetingId) {
    throw new Error(`Recording key is outside meeting ${input.meetingId}'s recording prefix`);
  }
  const meeting = await db.query.meetings.findFirst({
    where: { id: input.meetingId },
    columns: {
      id: true,
      spaceId: true,
      startedByUserId: true,
      billingPrincipalType: true,
      billingPrincipalId: true,
      billingPlan: true,
    },
  });
  if (!meeting) return false;
  const { limits, billingPrincipal } = await resolveMeetingEntitlement(db, meeting);
  const principalKey = `${billingPrincipal.type}:${billingPrincipal.id}`;
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  const withinQuota = limits.maxStorageBytes === null
    ? sql`1 = 1`
    : sql`${principalStoredBytesSql(billingPrincipal)}
        + coalesce((
          select sum(${uploadReservations.bytes}) from ${uploadReservations}
          where ${uploadReservations.principal} = ${principalKey}
            and ${uploadReservations.expiresAt} > ${nowSeconds}
        ), 0)
        + ${input.bytes} <= ${limits.maxStorageBytes}`;

  const id = generateId("MEETING_ARTIFACT");
  await db.run(sql`
    insert into ${meetingArtifacts}
      (id, meeting_id, space_id, revision_id, type, r2_key, filename, mime_type, size, uploaded_by_id, created_at)
    select
      ${id}, ${meetings.id}, ${meetings.spaceId}, null, 'recording',
      ${input.r2Key}, ${input.r2Key.split("/").pop() ?? input.r2Key}, 'video/mp4', ${input.bytes}, null, ${nowSeconds}
    from ${meetings}
    where ${meetings.id} = ${input.meetingId} and ${withinQuota}
      and not ${r2KeyBeingDeletedSql(input.r2Key)}
    on conflict (r2_key) do nothing
  `);
  const registered = await db.query.meetingArtifacts.findFirst({
    where: { RAW: (row) => eq(row.r2Key, input.r2Key) },
    columns: { id: true },
  });
  if (!registered) return false;
  if (await bucket.head(input.r2Key)) return true;
  await db.delete(meetingArtifacts).where(and(eq(meetingArtifacts.id, registered.id), eq(meetingArtifacts.r2Key, input.r2Key)));
  return false;
}
