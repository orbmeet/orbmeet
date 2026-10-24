/**
 * Server implementations behind the RPC declarations in this directory.
 * Split from the sibling RPC file so the declaration file carries no
 * DB/Drizzle imports and stays safe to include in client route graphs.
 */

import type { Database } from "@orbmeet/db";
import { meetingLinks, meetingWhiteboardPages, meetingWhiteboards, meetings, whiteboardRevisions, whiteboards } from "@orbmeet/db/schema";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Errors } from "@/lib/app-errors";
import { boundedStatements } from "@/platform/database/db-batching";
import type { TLStoreSnapshot } from "tldraw";
import { canAccessMeetingHistory } from "@/modules/meetings/server/access/resource-access";
import { buildAttachmentContentDisposition } from "@/modules/assets/server/content-disposition";
import { readStoredSnapshot } from "@/modules/whiteboards/server/sync-commands.server";
import { duplicateWhiteboard } from "@/modules/whiteboards/server/document-revisions";
import { currentNodeLatencies } from "@/platform/realtime/node-latency.server";
import { filterCapturedHandoutPageIds } from "@/modules/whiteboards/server/handout-pages";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import type { SaveMeetingCopyInput } from "./export.functions";
import type { HistoryRequestInput } from "./export.functions";
import type { GetMeetingWhiteboardSnapshotsInput } from "./export.functions";
import { ensurePersonalSpace } from "@/modules/spaces/server/personal";
import { buildR2Client } from "@/modules/assets/server/r2-client.server";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface WhiteboardSnapshotExport {
  schema: TLStoreSnapshot["schema"];
  documents: Array<{
    state: Record<string, JsonValue>;
    lastChangedClock?: number;
  }>;
}

async function assertExportAccess(db: Database, meetingId: string, userId: string) {
  if (!(await canAccessMeetingHistory(db, meetingId, userId))) {
    throw Errors.FORBIDDEN();
  }
}

/**
 * How many bytes of captured snapshot one combined export response may hold.
 *
 * Deliberately far below the isolate's memory: these are parsed into objects
 * and held simultaneously, and the request shares its isolate with every other
 * request on the same worker.
 */
const MAX_EXPORT_SNAPSHOT_TOTAL_BYTES = 16 * 1024 * 1024;

async function findCapturedWhiteboardRevisions(
  db: Database,
  meetingId: string,
  whiteboardId?: string,
) {
  return db
    .select({
      meetingWhiteboardId: meetingWhiteboards.id,
      whiteboardId: whiteboards.id,
      title: sql<string>`coalesce(${meetingWhiteboards.titleAtEnd}, ${whiteboards.title}, 'Whiteboard')`,
      revisionId: whiteboardRevisions.id,
      capturedAt: meetingWhiteboards.capturedAt,
      r2Key: whiteboardRevisions.snapshotR2Key,
      snapshotSize: whiteboardRevisions.snapshotSize,
      allowParticipantCopy: meetingWhiteboards.allowParticipantCopy,
      attachedAt: meetingWhiteboards.attachedAt,
    })
    .from(meetingWhiteboards)
    .innerJoin(whiteboards, eq(whiteboards.id, meetingWhiteboards.whiteboardId))
    .innerJoin(
      whiteboardRevisions,
      eq(whiteboardRevisions.id, meetingWhiteboards.capturedRevisionId),
    )
    .where(
      and(
        eq(meetingWhiteboards.meetingId, meetingId),
        whiteboardId ? eq(meetingWhiteboards.whiteboardId, whiteboardId) : undefined,
      ),
    )
    .orderBy(asc(meetingWhiteboards.attachedAt), asc(meetingWhiteboards.id));
}

/** Save an independent living Whiteboard from the exact Meeting capture. */
export async function saveMeetingWhiteboardCopyImpl({
  data,
  context: { user, db, env },
}: {
  data: SaveMeetingCopyInput;
  context: AuthFnContext;
}) {
  await assertExportAccess(db, data.meetingId, user.id);
  const [captured] = await db
    .select({
      whiteboardId: meetingWhiteboards.whiteboardId,
      revisionId: meetingWhiteboards.capturedRevisionId,
      allowParticipantCopy: meetingWhiteboards.allowParticipantCopy,
    })
    .from(meetingWhiteboards)
    .where(
      and(
        eq(meetingWhiteboards.meetingId, data.meetingId),
        eq(meetingWhiteboards.whiteboardId, data.whiteboardId),
      ),
    )
    .limit(1);
  if (!captured?.revisionId) throw Errors.NOT_FOUND("Meeting Whiteboard version");
  if (!captured.allowParticipantCopy) throw Errors.FORBIDDEN();

  const personalSpaceId = await ensurePersonalSpace(db, user);
  return duplicateWhiteboard(env, {
    whiteboardId: captured.whiteboardId,
    revisionId: captured.revisionId,
    destinationSpaceId: personalSpaceId,
    userId: user.id,
    nodeLatencies: await currentNodeLatencies(env),
  });
}

async function findHandoutPages(
  db: Database,
  meetingWhiteboardIds: string[],
): Promise<Map<string, string[]>> {
  if (meetingWhiteboardIds.length === 0) return new Map();
  const lookups = boundedStatements(meetingWhiteboardIds, (ids) =>
    db
      .select({
        meetingWhiteboardId: meetingWhiteboardPages.meetingWhiteboardId,
        pageId: meetingWhiteboardPages.pageId,
      })
      .from(meetingWhiteboardPages)
      .where(inArray(meetingWhiteboardPages.meetingWhiteboardId, ids))
      .orderBy(
        asc(meetingWhiteboardPages.meetingWhiteboardId),
        asc(meetingWhiteboardPages.handoutOrder),
        asc(meetingWhiteboardPages.firstPresentedAt),
        asc(meetingWhiteboardPages.firstEditedAt),
        asc(meetingWhiteboardPages.pageId),
      ));
  const rows = (await Promise.all(lookups)).flat();
  const pages = new Map<string, string[]>();
  for (const row of rows) {
    const ids = pages.get(row.meetingWhiteboardId) ?? [];
    ids.push(row.pageId);
    pages.set(row.meetingWhiteboardId, ids);
  }
  return pages;
}

export async function getWhiteboardSnapshotImpl({
  data,
  context: { user, db, env },
}: {
  data: HistoryRequestInput;
  context: AuthFnContext;
}) {
  await assertExportAccess(db, data.meetingId, user.id);
  const [captured] = await findCapturedWhiteboardRevisions(db, data.meetingId, data.whiteboardId);
  if (!captured) return { snapshot: null, whiteboard: null, pageIds: [] };
  const snapshot = await readStoredSnapshot<WhiteboardSnapshotExport>(env, captured.r2Key);
  if (!snapshot) return { snapshot: null, whiteboard: null, pageIds: [] };
  const recordedPageIds =
    (await findHandoutPages(db, [captured.meetingWhiteboardId])).get(
      captured.meetingWhiteboardId,
    ) ?? [];
  const pageIds = filterCapturedHandoutPageIds(snapshot, recordedPageIds);
  return {
    snapshot,
    whiteboard: {
      ...captured,
      capturedAt: captured.capturedAt?.toISOString() ?? null,
      attachedAt: captured.attachedAt.toISOString(),
    },
    pageIds,
  };
}

export async function getMeetingWhiteboardSnapshotsImpl({
  data,
  context: { user, db, env },
}: {
  data: GetMeetingWhiteboardSnapshotsInput;
  context: AuthFnContext;
}) {
  await assertExportAccess(db, data.meetingId, user.id);
  const captured = await findCapturedWhiteboardRevisions(db, data.meetingId);
  const pages = await findHandoutPages(
    db,
    captured.map((item) => item.meetingWhiteboardId),
  );
  // One response used to hold every captured board at once: fetched with
  // Promise.all and retained together, with no bound but the number of
  // Whiteboards a meeting happened to present. Each capture may be up to
  // MAX_SNAPSHOT_BYTES, and parsed JSON costs several times its encoded size,
  // so a meeting with a handful of large boards could exhaust the isolate —
  // taking unrelated requests sharing it down too.
  //
  // The recorded size is known before anything is read, so the budget is
  // spent up front and sequentially. A board that does not fit comes back
  // with a null snapshot, exactly like one whose object is missing, and the
  // caller can still fetch it on its own through
  // `getMeetingWhiteboardSnapshot`.
  let remainingBytes = MAX_EXPORT_SNAPSHOT_TOTAL_BYTES;
  let omittedForSize = 0;
  const snapshots = [];
  for (const item of captured) {
    const withinBudget = item.snapshotSize <= remainingBytes;
    if (!withinBudget) omittedForSize += 1;
    const snapshot = withinBudget
      ? await readStoredSnapshot<WhiteboardSnapshotExport>(env, item.r2Key)
      : null;
    if (snapshot) remainingBytes -= item.snapshotSize;
    snapshots.push({
      whiteboard: {
        ...item,
        capturedAt: item.capturedAt?.toISOString() ?? null,
        attachedAt: item.attachedAt.toISOString(),
      },
      pageIds: snapshot
        ? filterCapturedHandoutPageIds(snapshot, pages.get(item.meetingWhiteboardId) ?? [])
        : [],
      snapshot,
    });
  }
  return { whiteboards: snapshots, omittedForSize };
}

export async function getMeetingWhiteboardHistoryImpl({
  data,
  context: { user, db },
}: {
  data: HistoryRequestInput;
  context: AuthFnContext;
}) {
  await assertExportAccess(db, data.meetingId, user.id);
  const captured = await findCapturedWhiteboardRevisions(db, data.meetingId);
  if (captured.length === 0) {
    return { whiteboard: null, whiteboards: [], hasCapturedWhiteboards: false };
  }
  const pdf = await db.query.meetingArtifacts.findFirst({
    where: {
      RAW: (row) => and(eq(row.meetingId, data.meetingId), eq(row.type, "whiteboard_pdf"))!,
    },
    columns: { id: true },
  });
  return {
    whiteboard: {
      ...captured[0],
      capturedAt: captured[0].capturedAt?.toISOString() ?? null,
      attachedAt: captured[0].attachedAt.toISOString(),
      hasPdf: Boolean(pdf),
    },
    whiteboards: captured.map((item) => ({
      ...item,
      capturedAt: item.capturedAt?.toISOString() ?? null,
      attachedAt: item.attachedAt.toISOString(),
      hasPdf: Boolean(pdf),
    })),
    // Meeting captures are readable without granting access to the living
    // Whiteboard they came from, so this is not an access flag despite its
    // former name — it says only whether this Meeting captured anything.
    hasCapturedWhiteboards: true,
  };
}

export async function getWhiteboardPdfDownloadUrlImpl({
  data,
  context: { user, db, env },
}: {
  data: HistoryRequestInput;
  context: AuthFnContext;
}) {
  await assertExportAccess(db, data.meetingId, user.id);

  const artifact = await db.query.meetingArtifacts.findFirst({
    where: {
      RAW: (row) => and(eq(row.meetingId, data.meetingId), eq(row.type, "whiteboard_pdf"))!,
    },
    columns: { r2Key: true },
    orderBy: (row) => [desc(row.createdAt), desc(row.id)],
  });
  const meeting = await db
    .select({ title: meetings.title, code: meetingLinks.code })
    .from(meetings)
    .innerJoin(meetingLinks, eq(meetings.meetingLinkId, meetingLinks.id))
    .where(eq(meetings.id, data.meetingId))
    .get();
  if (!artifact || !meeting) throw Errors.NOT_FOUND("Whiteboard PDF");
  if (!env.R2_BUCKET_NAME) throw Errors.CONFIG_ERROR("Storage not configured");

  const { r2, endpoint } = buildR2Client(env);
  const url = new URL(`/${env.R2_BUCKET_NAME}/${artifact.r2Key}`, endpoint);
  url.searchParams.set("X-Amz-Expires", "300");
  url.searchParams.set(
    "response-content-disposition",
    buildAttachmentContentDisposition(`whiteboard-${meeting.title ?? meeting.code}.pdf`),
  );
  const signed = await r2.sign(new Request(url.toString(), { method: "GET" }), {
    aws: { signQuery: true },
  });
  return { downloadUrl: signed.url };
}
