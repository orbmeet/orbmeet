import type { Database } from "@orbmeet/db";
import {
  whiteboardFileReferences,
  meetingArtifacts,
  meetings,
  files,
  spaces,
  uploadReservations,
} from "@orbmeet/db/schema";
import { isMeetingArtifactR2Key } from "@/platform/storage/r2-keys";
import { and, eq, sql } from "drizzle-orm";
import { generateId } from "@/lib/ids";
import { getRunChanges, withD1Retry } from "@/platform/database/db-utils";

type FileType = (typeof files.$inferInsert)["type"];
type MeetingArtifactType = (typeof meetingArtifacts.$inferInsert)["type"];

interface RegisterFileInput {
  /**
   * Supply this when the caller derived the R2 key from the same id, so the
   * stored row and its object agree on what the file is called. Omitted, one is
   * minted here.
   */
  id?: string;
  // Personal Files use the owner's hidden personal Space; shared Files use the
  // visible Space. The physical ownership key is therefore always space_id.
  spaceId: string;
  type: FileType;
  r2Key: string;
  filename: string;
  mimeType: string;
  size: number;
  uploadedByUserId: string | null;
  createdAt?: Date;
}

interface RegisterMeetingArtifactInput {
  meetingId: string;
  revisionId?: string | null;
  type: MeetingArtifactType;
  r2Key: string;
  filename: string;
  mimeType: string;
  size: number;
  uploadedByUserId: string | null;
  createdAt?: Date;
  overwriteOnConflict: boolean;
}

/**
 * Atomically turn an upload reservation into committed Space asset metadata.
 *
 * The reservation is both the quota hold and the capability minted by the
 * presign endpoint. Committing and releasing it in one D1 batch prevents a
 * successful asset insert from leaving bytes double-counted until TTL, while
 * the exact byte predicate prevents a different object from consuming the hold.
 */
export async function commitReservedFileMetadata(
  db: Database,
  input: RegisterFileInput & {
    id: string;
    whiteboardId?: string;
    reservationPrincipal: string;
    reservationScope: string;
  },
): Promise<void> {
  const createdAt = input.createdAt ?? new Date();
  const createdAtSeconds = Math.floor(createdAt.getTime() / 1000);
  const nowSeconds = Math.floor(Date.now() / 1000);

  const results = await withD1Retry(
    () =>
      db.batch([
        db.run(sql`
        INSERT INTO ${files} (
          id,
          space_id,
          type,
          status,
          r2_key,
          filename,
          mime_type,
          size,
          uploaded_by_id,
          committed_at,
          created_at
        )
        SELECT
          ${input.id},
          ${input.spaceId},
          ${input.type},
          'committed',
          ${input.r2Key},
          ${input.filename},
          ${input.mimeType},
          reservation.bytes,
          ${input.uploadedByUserId},
          ${createdAtSeconds},
          ${createdAtSeconds}
        FROM ${uploadReservations} AS reservation
        WHERE reservation.id = ${input.id}
          AND reservation.principal = ${input.reservationPrincipal}
          AND reservation.scope = ${input.reservationScope}
          AND reservation.bytes = ${input.size}
          AND reservation.expires_at > ${nowSeconds}
          AND EXISTS (
            SELECT 1
            FROM ${spaces}
            WHERE ${spaces.id} = ${input.spaceId}
              AND ${spaces.archivedAt} IS NULL
          )
        ON CONFLICT DO NOTHING
      `),
        ...(input.whiteboardId
          ? [
              db
                .insert(whiteboardFileReferences)
                .values({
                  whiteboardId: input.whiteboardId,
                  fileId: input.id,
                  spaceId: input.spaceId,
                  role: "source",
                  createdAt,
                })
                .onConflictDoNothing(),
            ]
          : []),
        db.run(sql`
        DELETE FROM ${uploadReservations}
        WHERE ${uploadReservations.id} = ${input.id}
          AND ${uploadReservations.principal} = ${input.reservationPrincipal}
          AND ${uploadReservations.scope} = ${input.reservationScope}
          AND EXISTS (
            SELECT 1
            FROM ${files}
            WHERE ${files.id} = ${input.id}
              AND ${files.r2Key} = ${input.r2Key}
              AND ${files.size} = ${input.size}
              AND ${files.uploadedByUserId} IS ${input.uploadedByUserId}
          )
      `),
      ]),
    { idempotent: true },
  );
  const insertResult = results[0];

  if (getRunChanges(insertResult) > 0) return;
  const existing = await db.query.files.findFirst({
    where: { id: input.id },
    columns: {
      spaceId: true,
      type: true,
      r2Key: true,
      size: true,
      uploadedByUserId: true,
    },
  });
  if (
    existing?.spaceId !== input.spaceId ||
    existing.type !== input.type ||
    existing.r2Key !== input.r2Key ||
    existing.size !== input.size ||
    existing.uploadedByUserId !== input.uploadedByUserId
  ) {
    throw new Error(`Failed to commit reserved asset ${input.id}`);
  }
}

export async function registerMeetingArtifactMetadata(
  db: Database,
  input: RegisterMeetingArtifactInput,
): Promise<void> {
  if (!isMeetingArtifactR2Key(input.type, { meetingId: input.meetingId }, input.r2Key)) {
    throw new Error(
      `Meeting artifact key does not match type ${input.type} and meeting ${input.meetingId}`,
    );
  }

  const createdAt = input.createdAt ?? new Date();
  const createdAtSeconds = Math.floor(createdAt.getTime() / 1000);
  const { meetingId } = input;
  const { overwriteOnConflict } = input;

  const result = overwriteOnConflict
    ? await db.run(sql`
          insert into ${meetingArtifacts} (
            id,
            meeting_id,
            space_id,
            revision_id,
            type,
            r2_key,
            filename,
            mime_type,
            size,
            uploaded_by_id,
            created_at
          )
            select
              ${generateId("MEETING_ARTIFACT")},
              ${meetings.id},
              ${meetings.spaceId},
              ${input.revisionId ?? null},
              ${input.type},
              ${input.r2Key},
              ${input.filename},
              ${input.mimeType},
              ${input.size},
              ${input.uploadedByUserId},
              ${createdAtSeconds}
            from ${meetings}
            where ${meetings.id} = ${meetingId}
          on conflict(r2_key) do update set
            meeting_id = excluded.meeting_id,
            space_id = excluded.space_id,
            revision_id = excluded.revision_id,
            type = excluded.type,
            filename = excluded.filename,
            mime_type = excluded.mime_type,
            size = excluded.size,
            uploaded_by_id = excluded.uploaded_by_id,
            created_at = excluded.created_at
        `)
    : await db.run(sql`
          insert into ${meetingArtifacts} (
            id,
            meeting_id,
            space_id,
            revision_id,
            type,
            r2_key,
            filename,
            mime_type,
            size,
            uploaded_by_id,
            created_at
          )
            select
              ${generateId("MEETING_ARTIFACT")},
              ${meetings.id},
              ${meetings.spaceId},
              ${input.revisionId ?? null},
              ${input.type},
              ${input.r2Key},
              ${input.filename},
              ${input.mimeType},
              ${input.size},
              ${input.uploadedByUserId},
              ${createdAtSeconds}
            from ${meetings}
            where ${meetings.id} = ${meetingId}
          on conflict(r2_key) do nothing
        `);

  if (getRunChanges(result) === 0) {
    const existing = await db.query.meetingArtifacts.findFirst({
      where: { r2Key: input.r2Key },
      columns: { id: true },
    });
    if (!existing) {
      throw new Error(`Failed to register meeting artifact metadata for key: ${input.r2Key}`);
    }
  }
}

export async function replaceMeetingWhiteboardPdfMetadata(
  db: Database,
  input: Omit<RegisterMeetingArtifactInput, "overwriteOnConflict" | "type"> & {
    type: "whiteboard_pdf";
  },
): Promise<string | null> {
  if (!isMeetingArtifactR2Key(input.type, { meetingId: input.meetingId }, input.r2Key)) {
    throw new Error(`Meeting artifact key does not match meeting ${input.meetingId}`);
  }

  const previous = await db.query.meetingArtifacts.findFirst({
    where: { meetingId: input.meetingId, type: "whiteboard_pdf" },
    columns: { id: true, r2Key: true },
    orderBy: { createdAt: "desc" },
  });
  if (!previous) {
    await registerMeetingArtifactMetadata(db, { ...input, overwriteOnConflict: false });
    return null;
  }

  const result = await db
    .update(meetingArtifacts)
    .set({
      revisionId: input.revisionId ?? null,
      r2Key: input.r2Key,
      filename: input.filename,
      mimeType: input.mimeType,
      size: input.size,
      uploadedByUserId: input.uploadedByUserId,
      createdAt: input.createdAt ?? new Date(),
    })
    .where(and(eq(meetingArtifacts.id, previous.id), eq(meetingArtifacts.r2Key, previous.r2Key)));
  if (getRunChanges(result) !== 1) {
    throw new Error(`Meeting handout changed while publishing: ${input.meetingId}`);
  }
  return previous.r2Key;
}
