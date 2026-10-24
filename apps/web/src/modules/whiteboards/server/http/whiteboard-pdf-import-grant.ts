import { createDb, type Database } from "@orbmeet/db";
import { files, whiteboardFileReferences } from "@orbmeet/db/schema";
import { sql } from "drizzle-orm";
import * as v from "valibot";
import { idSchema, integerSchema } from "@orbmeet/public-api-contract/fields";
import { readSignedRequest } from "@/platform/http/internal-auth";
import { whiteboardCallbackKeyring, whiteboardCallbackNodeId } from "@/platform/realtime/nodes";
import {
  getActiveWhiteboardParticipantAccess,
  resolveSoloWhiteboardEditor,
} from "@/modules/whiteboards/server/meeting/access";
import {
  releaseUploadReservation,
  reserveUploadBytes,
} from "@/modules/assets/server/upload-reservations";
import {
  buildWhiteboardPdfImportAssetKey,
  whiteboardPdfImportPrefix,
} from "@orbmeet/whiteboard-core/whiteboard-asset-key";
import {
  findWhiteboardIdForSyncRoom,
  resolveMeetingIdForWhiteboardConnection,
} from "@/modules/whiteboards/server/documents";
import {
  commitPdfImportAssets,
  retireUnplacedPdfImportAssets,
  type WhiteboardAssetUploader,
} from "@/modules/whiteboards/server/assets";
import { loadSpaceEntitlement } from "@/modules/billing/server/entitlements.server";
import { assertSpaceCapability } from "@/modules/spaces/server/helpers";
import {
  estimatePdfImportReserveBytes,
  isPdfSourceFileId,
  PDF_MAX_IMPORT_SIZE,
} from "@orbmeet/whiteboard-core/pdf-geometry";

const MAX_GUEST_WHITEBOARD_PARTICIPANT_BYTES = 50 * 1024 * 1024;
const MAX_GRANT_BODY_BYTES = 16 * 1024;

const importGrantBaseEntries = {
  meetingId: v.pipe(v.string(), v.regex(/^meet-[a-zA-Z0-9_-]+$/)),
  connectionId: idSchema,
  participantIdentity: idSchema,
  importId: v.pipe(v.string(), v.uuid()),
};
const byteCountSchema = integerSchema(1, 500 * 1024 * 1024);
const sourceFileIdSchema = v.custom<string>(isPdfSourceFileId, "Invalid PDF source file id");

const MAX_PDF_IMPORT_PAGES = 100;
const pageKeySchema = v.pipe(v.string(), v.nonEmpty(), v.maxLength(512));

/**
 * The PDF import grant: the whiteboard server's callback for one import, which
 * it runs on its node (whiteboard-server pdf-import.ts). Three phases:
 *
 * - `preflight` reserves storage quota for the import (an estimate from the
 *   PDF's size), resolves a stored Space file it may read, and names the key
 *   prefix its pages go under;
 * - `commit` registers a batch of uploaded pages as the board's committed
 *   assets, after reserving quota for their actual size. The server shows a
 *   page only after this, so nothing on the board is outside the registry;
 * - `release` retires the import's registered pages the board does not hold,
 *   records the Space file the board's pages came from, and frees the
 *   reservation.
 */
// Two preflight shapes share a phase: a variant tries both and keeps the one
// that fits.
const importGrantSchema = v.variant("phase", [
  v.strictObject({
    ...importGrantBaseEntries,
    phase: v.literal("preflight"),
    reserveBytes: byteCountSchema,
  }),
  v.strictObject({
    ...importGrantBaseEntries,
    phase: v.literal("preflight"),
    sourceFileId: sourceFileIdSchema,
  }),
  v.strictObject({
    ...importGrantBaseEntries,
    phase: v.literal("commit"),
    pages: v.pipe(
      v.array(v.strictObject({ r2Key: pageKeySchema, size: integerSchema(1, 25 * 1024 * 1024) })),
      v.minLength(1),
      v.maxLength(MAX_PDF_IMPORT_PAGES),
    ),
  }),
  v.strictObject({
    ...importGrantBaseEntries,
    phase: v.literal("release"),
    placedKeys: v.pipe(v.array(pageKeySchema), v.maxLength(MAX_PDF_IMPORT_PAGES)),
    sourceFileId: v.optional(sourceFileIdSchema),
  }),
]);

/** The quota reservation one import holds. Spelled once so the phases that
 * reserve and release it cannot disagree about which row they mean. */
function pdfImportReservationScope(whiteboardId: string, importId: string): string {
  return `whiteboard:${whiteboardId}:pdf-import:${importId}`;
}

type PdfImportParticipantAccess = {
  participantIdentity: string;
  userId: string | null;
  admissionId: string | null;
  canEditWhiteboard: boolean;
};

export async function resolvePdfImportParticipantAccess(
  db: Database,
  input: {
    whiteboardId: string;
    syncRoomId: string;
    connectionId: string;
    participantIdentity: string;
  },
): Promise<PdfImportParticipantAccess | null> {
  if (input.connectionId === "solo") {
    const board = await resolveSoloWhiteboardEditor(
      db,
      input.syncRoomId,
      input.participantIdentity,
    );
    return board?.whiteboardId === input.whiteboardId
      ? {
          userId: input.participantIdentity,
          admissionId: null,
          participantIdentity: input.participantIdentity,
          // A solo session is a Space member editing its own board.
          canEditWhiteboard: true,
        }
      : null;
  }

  const meetingId = await resolveMeetingIdForWhiteboardConnection(
    db,
    input.syncRoomId,
    input.connectionId,
  );
  return meetingId
    ? getActiveWhiteboardParticipantAccess(db, meetingId, input.connectionId)
    : null;
}

async function resolveStoredPdfSource(
  db: Database,
  input: { spaceId: string; fileId: string },
): Promise<{ r2Key: string; size: number } | null> {
  const file = await db.query.files.findFirst({
    where: {
      id: input.fileId,
      spaceId: input.spaceId,
      type: "pdf",
      status: "committed",
    },
    columns: { id: true, r2Key: true, size: true },
  });
  if (!file || file.size <= 0 || file.size > PDF_MAX_IMPORT_SIZE) return null;

  return { r2Key: file.r2Key, size: file.size };
}

export async function resolveStoredPdfSourceForMember(
  db: Database,
  input: { spaceId: string; userId: string | null; fileId: string },
): Promise<{ r2Key: string; size: number } | null> {
  if (!input.userId) return null;
  try {
    await assertSpaceCapability(db, input.spaceId, input.userId, "canView");
  } catch {
    return null;
  }
  return resolveStoredPdfSource(db, input);
}

export async function recordStoredPdfSource(
  db: Database,
  input: { whiteboardId: string; spaceId: string; fileId: string },
): Promise<void> {
  await db.run(sql`
    INSERT INTO ${whiteboardFileReferences}
      (whiteboard_id, file_id, space_id, role, created_at)
    SELECT ${input.whiteboardId}, ${files.id}, ${files.spaceId}, 'source', unixepoch()
    FROM ${files}
    WHERE ${files.id} = ${input.fileId}
      AND ${files.spaceId} = ${input.spaceId}
      AND ${files.type} = 'pdf'
      AND ${files.status} = 'committed'
      AND ${files.size} > 0
      AND ${files.size} <= ${PDF_MAX_IMPORT_SIZE}
    ON CONFLICT DO NOTHING
  `);
}

/**
 * Every key names a page of this import on this Whiteboard, within the import
 * cap. This binds what the callback can touch without a live participant.
 */
function hasOnlyExpectedImportPageKeys(
  whiteboardId: string,
  importId: string,
  keys: readonly string[],
): boolean {
  const expectedKeys = new Set(
    Array.from({ length: MAX_PDF_IMPORT_PAGES }, (_, index) =>
      buildWhiteboardPdfImportAssetKey(whiteboardId, importId, index + 1)),
  );
  return keys.every((key) => expectedKeys.has(key));
}

export async function handlePdfImportGrant(request: Request, env: Env): Promise<Response> {
  let keyring: ReturnType<typeof whiteboardCallbackKeyring> | null;
  try {
    keyring = whiteboardCallbackKeyring(env);
  } catch {
    keyring = null;
  }
  const signed = await readSignedRequest(request, keyring, MAX_GRANT_BODY_BYTES);
  if (!signed.ok) return signed.response;

  let body: unknown;
  try {
    body = JSON.parse(signed.body);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const parsed = v.safeParse(importGrantSchema, body);
  if (!parsed.success) {
    return new Response("Invalid body", { status: 400 });
  }

  const {
    meetingId: meetingSid,
    connectionId,
    participantIdentity,
    importId,
  } = parsed.output;
  const syncRoomId = meetingSid.slice("meet-".length);
  const db = createDb(env.DB);
  const whiteboardId = await findWhiteboardIdForSyncRoom(db, syncRoomId);
  if (!whiteboardId) {
    return new Response("Whiteboard not found", { status: 403 });
  }
  const whiteboard = await db.query.whiteboards.findFirst({
    where: { id: whiteboardId },
    columns: { spaceId: true, syncNodeId: true },
  });
  if (!whiteboard) return new Response("Whiteboard not found", { status: 403 });
  // Only the node holding the board may add to it. Releasing gives back, and
  // may come from a node the board moved away from while the import ran.
  if (parsed.output.phase !== "release" && whiteboard.syncNodeId !== whiteboardCallbackNodeId(env, signed.keyId)) {
    return new Response("Whiteboard is on another node", { status: 403 });
  }
  const scope = pdfImportReservationScope(whiteboardId, importId);

  // Release only gives back: it retires this import's own unplaced pages and
  // frees its reservation. It runs when an import ends, which may be after
  // its participant left, so the signature and the key binding authorize it
  // rather than a live connection.
  if (parsed.output.phase === "release") {
    const { placedKeys, sourceFileId } = parsed.output;
    if (!hasOnlyExpectedImportPageKeys(whiteboardId, importId, placedKeys)) {
      return new Response("Invalid PDF import page", { status: 400 });
    }
    await retireUnplacedPdfImportAssets(db, { whiteboardId, importId, placedKeys });
    if (placedKeys.length > 0 && sourceFileId) {
      await recordStoredPdfSource(db, { whiteboardId, spaceId: whiteboard.spaceId, fileId: sourceFileId });
    }
    // `(id, scope)` identifies exactly this import's reservation.
    await releaseUploadReservation(db, { id: importId, scope });
    return Response.json({ ok: true });
  }

  const access = await resolvePdfImportParticipantAccess(db, {
    whiteboardId,
    syncRoomId,
    connectionId,
    participantIdentity,
  });
  if (!access || access.participantIdentity !== participantIdentity) {
    return new Response("Participant not found", { status: 403 });
  }
  // A participant revoked mid-import cannot add another page to the board.
  if (!access.canEditWhiteboard) {
    return new Response("Whiteboard edit access is required", { status: 403 });
  }
  if (parsed.output.phase === "commit"
    && !hasOnlyExpectedImportPageKeys(whiteboardId, importId, parsed.output.pages.map((page) => page.r2Key))) {
    return new Response("Invalid PDF import page", { status: 400 });
  }

  let source: { r2Key: string; size: number } | null = null;
  let reserveBytes: number;
  if (parsed.output.phase === "preflight" && "sourceFileId" in parsed.output) {
    source = await resolveStoredPdfSourceForMember(db, {
      spaceId: whiteboard.spaceId,
      userId: access.userId,
      fileId: parsed.output.sourceFileId,
    });
    if (!source) {
      return new Response("PDF source not found or Space membership is required", { status: 403 });
    }
    reserveBytes = estimatePdfImportReserveBytes(source.size);
  } else if (parsed.output.phase === "preflight") {
    reserveBytes = parsed.output.reserveBytes;
  } else {
    reserveBytes = parsed.output.pages.reduce((total, page) => total + page.size, 0);
  }

  let uploader: WhiteboardAssetUploader;
  if (access.userId) {
    const user = await db.query.users.findFirst({
      where: { id: access.userId },
      columns: { id: true },
    });
    if (!user) return new Response("User not found", { status: 403 });
    uploader = { uploadedByUserId: user.id, guestAdmissionId: null };
  } else {
    if (!access.admissionId) return new Response("Participant not found", { status: 403 });
    if (reserveBytes > MAX_GUEST_WHITEBOARD_PARTICIPANT_BYTES) {
      return new Response("Guest Whiteboard import quota exceeded", { status: 403 });
    }
    uploader = { uploadedByUserId: null, guestAdmissionId: access.admissionId };
  }

  // A commit replaces the preflight's estimate with the batch's real size;
  // earlier batches already count as stored bytes.
  const entitlement = await loadSpaceEntitlement(db, whiteboard.spaceId);
  try {
    await reserveUploadBytes(db, {
      id: importId,
      principal: entitlement.billingPrincipal,
      scope,
      bytes: reserveBytes,
      limitBytes: entitlement.limits.maxStorageBytes,
    });
  } catch (reservationError) {
    if (reservationError instanceof Error && reservationError.message === "upload_quota_exceeded") {
      return new Response("Storage quota exceeded", { status: 403 });
    }
    throw reservationError;
  }

  if (parsed.output.phase === "preflight") {
    return Response.json({
      uploadPrefix: whiteboardPdfImportPrefix(whiteboardId, importId),
      ...(source ? { source } : {}),
    });
  }

  await commitPdfImportAssets(db, {
    whiteboardId,
    spaceId: whiteboard.spaceId,
    importId,
    pages: parsed.output.pages,
    uploader,
  });
  return Response.json({ ok: true });
}
