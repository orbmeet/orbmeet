import type { TLRecord } from "@tldraw/tlschema";

import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import {
  addWhiteboardPageInTransaction,
  insertImportedPagesInTransaction,
  PdfImportPartiallyAppliedError,
  PdfImportAnchorMissingError,
  PdfImportPlacementAbortedError,
  type ImportedPdfPageSpec,
  type MutableRecordTransaction,
} from "./room-page-mutations.ts";
import { isPageFrameRecord } from "@orbmeet/whiteboard-core/page-frame-model";
import { assertValidRoomRecord } from "./record-rules.ts";
import type { ShapeAuthor } from "@orbmeet/whiteboard-core/shape-author";
import {
  ROOM_NAVIGATION_ID,
  type RoomNavigationRecord,
} from "@orbmeet/whiteboard-core/room-navigation";
import {
  syncCommandFailure,
  type PageTarget,
  type SyncCommandFailure,
} from "@orbmeet/whiteboard-core/sync-commands";
import { Reply } from "../http/reply.ts";
import { logError, logWarn } from "../lib/log.ts";

export type { ImportedPdfPageSpec } from "./room-page-mutations.ts";

/** Adding a page, or establishing a new board's first one. */
export type PageCreateResult =
  | {
      ok: true;
      status: "initialized" | "page_added";
      page: PageTarget;
    }
  | { ok: true; status: "already_initialized" }
  | SyncCommandFailure;

/**
 * The outcome of applying a PDF import to the authoritative document.
 *
 * `placedPageIndices` is the room's answer to "which of these pages are now on
 * the canvas", and it is deliberately independent of the reply's status. A partial
 * apply is rejected with a 409 whose whole meaning is that *some* of the pages
 * are already in the document, so those pages' objects are referenced by live
 * shapes and their ownership has to transfer even though the request failed.
 */
export interface ImportedPagesApplyResult {
  reply: Reply;
  placedPageIndices: number[];
}

/** A rejection that transferred no page ownership. */
function rejected(reply: Reply): ImportedPagesApplyResult {
  return { reply, placedPageIndices: [] };
}

interface RoomPageCommandHost {
  runTransaction(operation: (transaction: MutableRecordTransaction) => unknown): unknown;
  canAddPages(userId: string): boolean;
  /**
   * Whether the caller may mutate an *existing* page frame, not just append new
   * ones. Reusing a frame for a PDF import resizes it, shifts everything below,
   * and rewrites its page provenance — the same structural page-frame mutation
   * the CRDT path reserves for managers (see classifyIncomingDiff →
   * requires-manager). Adding pages stays open to any editor; replacing one does
   * not.
   */
  canReplaceExistingPage(userId: string): boolean;
  /**
   * The navigation to write with a page `userId` added, moving everyone
   * there, or null when they do not drive the room's navigation.
   */
  navigationForPageMutation(
    current: RoomNavigationRecord | undefined,
    target: PageTarget,
    userId: string,
  ): RoomNavigationRecord | null;
  /** `userId`'s page mutation moved the room's navigation. */
  navigated(userId: string): void;
  notePageFramesChanged(): void;
  /** Running upper bound on the room's serialized size. */
  getEstimatedRoomBytes(): number;
  /** Refresh a stale-high estimate before an over-limit rejection. */
  verifyRoomSizeEstimate(): boolean;
  /** Fold a committed server write into that estimate. */
  noteMutationBytes(byteLength: number): void;
}

class ServerMutationTooLargeError extends Error {
  readonly byteLength: number;

  constructor(byteLength: number) {
    super("Server-side whiteboard mutation would exceed the room size limit");
    this.byteLength = byteLength;
  }
}

/**
 * Wraps the storage transaction to total the bytes a mutation writes.
 *
 * Serializing the whole document on every page add and PDF import would be a
 * multi-megabyte synchronous `JSON.stringify` on the event loop that every room
 * and socket on this host shares. RoomMessageGuard already maintains a running
 * size estimate precisely so the CRDT path never pays that; these commands size
 * against the same estimate and only serialize what they themselves wrote.
 *
 * A `set` that replaces a record already in the document is counted as a pure
 * addition. That over-counts, never under-counts, which keeps the check
 * conservative in the same direction as the guard's own estimate: it can reject
 * early, never admit something oversized.
 *
 * Rewrites *within* one transaction are a different matter and are not counted
 * repeatedly. A PDF import sets each frame up to three times (reuse shift,
 * insert shift, renumber) and each loose shape twice, so summing every `set`
 * charged one mutation three times over — and the same total is what
 * `noteMutationBytes` feeds back into the running room estimate, where the
 * error persists past this call.
 */
class BufferedMeasuredTransaction implements MutableRecordTransaction {
  // Last write per record id wins, which is what the transaction actually
  // commits.
  private readonly bytesByRecordId = new Map<TLRecord["id"], number>();
  private readonly records = new Map<TLRecord["id"], TLRecord>();
  private readonly pendingRecords = new Map<TLRecord["id"], TLRecord>();

  get writtenBytes(): number {
    let total = 0;
    for (const bytes of this.bytesByRecordId.values()) total += bytes;
    return total;
  }

  private readonly inner: MutableRecordTransaction;

  constructor(inner: MutableRecordTransaction) {
    this.inner = inner;
    for (const record of inner.values()) this.records.set(record.id, record);
  }

  values(): Iterable<TLRecord> {
    return this.records.values();
  }

  get(id: TLRecord["id"]): TLRecord | undefined {
    return this.records.get(id);
  }

  set(id: TLRecord["id"], record: TLRecord): void {
    this.bytesByRecordId.set(id, Buffer.byteLength(JSON.stringify(record), "utf8"));
    this.records.set(id, record);
    this.pendingRecords.set(id, record);
  }

  /** Write everything set, once every record has passed the schema (see `assertValidRoomRecord`). */
  commit(): void {
    for (const record of this.pendingRecords.values()) assertValidRoomRecord(record);
    for (const [id, record] of this.pendingRecords) this.inner.set(id, record);
  }
}

function assertMutationWithinRoomSize(
  host: Pick<RoomPageCommandHost, "getEstimatedRoomBytes" | "verifyRoomSizeEstimate">,
  writtenBytes: number,
): void {
  // A transaction that wrote nothing cannot have grown the room, so there is no
  // growth to refuse. Without this gate the check degrades into "is the room
  // already over the cap", which fails two mutations that are not the problem:
  // an idempotent PDF-import retry whose pages are all present already returns
  // non-null having written zero bytes, and the room may legitimately sit above
  // the cap — `getEstimatedRoomBytes` is a deliberate upper bound, and the
  // may-shrink headroom admits pushes that leave it there. The client then
  // cannot complete an import that has, in fact, already been applied.
  if (writtenBytes === 0) return;
  let projectedBytes = host.getEstimatedRoomBytes() + writtenBytes;
  if (
    projectedBytes > WHITEBOARD_CONFIG.MAX_ROOM_WRITE_BYTES &&
    host.verifyRoomSizeEstimate()
  ) {
    projectedBytes = host.getEstimatedRoomBytes() + writtenBytes;
  }
  if (projectedBytes > WHITEBOARD_CONFIG.MAX_ROOM_WRITE_BYTES) {
    throw new ServerMutationTooLargeError(projectedBytes);
  }
}

function logRoomSizeLimit(
  whiteboardRoomId: string,
  operation: "server page add" | "PDF import",
  error: ServerMutationTooLargeError,
): void {
  logWarn(
    `[Room ${whiteboardRoomId}] Rejected ${operation} above the ${WHITEBOARD_CONFIG.MAX_ROOM_WRITE_BYTES}-byte room limit (${error.byteLength} bytes)`,
  );
}

function roomSizeLimitReply(
  whiteboardRoomId: string,
  operation: "server page add" | "PDF import",
  error: ServerMutationTooLargeError,
): Reply {
  logRoomSizeLimit(whiteboardRoomId, operation, error);
  return Reply.json(
    {
      error: "Whiteboard room size limit reached",
      maxBytes: WHITEBOARD_CONFIG.MAX_ROOM_WRITE_BYTES,
    },
    413,
  );
}

function pageLimitReply(): Reply {
  return Reply.json(
    {
      error: `Maximum page limit (${WHITEBOARD_CONFIG.MAX_PAGES}) reached or room is not ready`,
    },
    409,
  );
}


/**
 * Move the room's navigation to `target` in the same transaction as the page
 * it names, when `userId` drives it: the page and the navigation that points
 * at it then reach every client in one change. Returns whether it did.
 */
function writeNavigation(
  host: RoomPageCommandHost,
  transaction: BufferedMeasuredTransaction,
  target: PageTarget,
  userId: string,
): boolean {
  const current = transaction.get(ROOM_NAVIGATION_ID) as RoomNavigationRecord | undefined;
  const next = host.navigationForPageMutation(current, target, userId);
  if (!next) return false;
  transaction.set(next.id, next);
  return true;
}

export class RoomPageCommands {
  private readonly whiteboardRoomId: string;
  private readonly host: RoomPageCommandHost;

  constructor(
    whiteboardRoomId: string,
    host: RoomPageCommandHost,
  ) {
    this.whiteboardRoomId = whiteboardRoomId;
    this.host = host;
  }

  addPage(userId: string, afterPageNumber?: number): PageCreateResult {
    if (!this.host.canAddPages(userId)) {
      return syncCommandFailure("forbidden", "Only whiteboard editors can add pages");
    }
    return this.createPage(userId, afterPageNumber, false);
  }

  /**
   * Establish the invariant that every writable Whiteboard has at least one
   * page frame. This is an application lifecycle operation, not authority
   * borrowed from an arbitrary connected user, and is deliberately idempotent
   * so creation retries and old blank documents are both safe.
   */
  ensureInitialPage(): PageCreateResult {
    return this.createPage(null, undefined, true);
  }

  private createPage(
    userId: string | null,
    afterPageNumber: number | undefined,
    initializeOnly: boolean,
  ): PageCreateResult {
    let createdPage: ReturnType<typeof addWhiteboardPageInTransaction>;
    let alreadyInitialized = false;
    let movedNavigation = false;
    let writtenBytes = 0;
    try {
      createdPage = this.host.runTransaction((transaction) => {
        const measured = new BufferedMeasuredTransaction(transaction);
        if (initializeOnly && [...measured.values()].some(isPageFrameRecord)) {
          alreadyInitialized = true;
          return null;
        }
        const result = addWhiteboardPageInTransaction(measured, afterPageNumber);
        if (result && userId !== null) {
          movedNavigation = writeNavigation(
            this.host,
            measured,
            { pageId: result.pageId, pageNumber: result.pageNumber },
            userId,
          );
        }
        if (result) {
          assertMutationWithinRoomSize(
            this.host,
            measured.writtenBytes,
          );
        }
        measured.commit();
        writtenBytes = measured.writtenBytes;
        return result;
      }) as ReturnType<typeof addWhiteboardPageInTransaction>;
    } catch (error) {
      if (error instanceof ServerMutationTooLargeError) {
        logRoomSizeLimit(this.whiteboardRoomId, "server page add", error);
        return syncCommandFailure("too_large", "Whiteboard room size limit reached", {
          maxBytes: WHITEBOARD_CONFIG.MAX_ROOM_WRITE_BYTES,
        });
      }
      throw error;
    }

    if (alreadyInitialized) return { ok: true, status: "already_initialized" };
    if (!createdPage) {
      return syncCommandFailure(
        "conflict",
        `Maximum page limit (${WHITEBOARD_CONFIG.MAX_PAGES}) reached or room is not ready`,
      );
    }
    this.host.noteMutationBytes(writtenBytes);
    this.host.notePageFramesChanged();
    if (movedNavigation && userId !== null) this.host.navigated(userId);
    return {
      ok: true,
      status: initializeOnly ? "initialized" : "page_added",
      page: { pageId: createdPage.pageId, pageNumber: createdPage.pageNumber },
    };
  }

  insertImportedPages(
    userId: string,
    spec: {
      importId: string;
      insertIndex: number;
      pages: ImportedPdfPageSpec[];
      reuse?: { frameId: string; height: number };
      after?: { pageIndex: number };
      author?: ShapeAuthor | null;
    },
  ): ImportedPagesApplyResult {
    if (!this.host.canAddPages(userId)) {
      return rejected(
        Reply.json(
          { error: "Only whiteboard editors can add pages" },
          403,
        ),
      );
    }

    // Reusing a frame replaces an existing page rather than adding one, so it
    // carries the manager-only authority the CRDT page-frame guard enforces.
    // Without this an editor could resize, shift, and repurpose any page frame —
    // including a manager's content-bearing page — through a path whose direct
    // socket equivalent is refused.
    if (spec.reuse && !this.host.canReplaceExistingPage(userId)) {
      return rejected(
        Reply.json(
          { error: "Only whiteboard managers can replace an existing page" },
          403,
        ),
      );
    }

    let placement: ReturnType<typeof insertImportedPagesInTransaction>;
    let movedNavigation = false;
    let writtenBytes = 0;
    try {
      placement = this.host.runTransaction((transaction) => {
        const measured = new BufferedMeasuredTransaction(transaction);
        const result = insertImportedPagesInTransaction(measured, spec);
        if (result) {
          movedNavigation = writeNavigation(
            this.host,
            measured,
            { pageId: result.firstPageId, pageNumber: result.firstPageNumber },
            userId,
          );
          assertMutationWithinRoomSize(
            this.host,
            measured.writtenBytes,
          );
        }
        measured.commit();
        writtenBytes = measured.writtenBytes;
        return result;
      }) as ReturnType<typeof insertImportedPagesInTransaction>;
    } catch (error) {
      if (error instanceof PdfImportPlacementAbortedError) {
        return rejected(
          Reply.json(
            { error: "Whiteboard pages changed while the PDF import was being applied" },
            409,
          ),
        );
      }
      if (error instanceof PdfImportAnchorMissingError) {
        // The pages this batch was told to follow are gone, so there is no
        // position left that preserves the document's order. Retrying resolves
        // it only if the anchor comes back, which it will not — report it as
        // the concurrent change it is rather than placing the batch anywhere.
        logWarn(
          `[Room ${this.whiteboardRoomId}] Rejected PDF import ${spec.importId}: ${error.message}`,
        );
        return rejected(
          Reply.json(
            { error: "Whiteboard pages changed while the PDF import was being applied" },
            409,
          ),
        );
      }
      if (error instanceof PdfImportPartiallyAppliedError) {
        // Retrying cannot clear this: the idempotency check will keep seeing the
        // same partial set. Say what is actually wrong instead of reporting it as
        // a page-limit rejection.
        logWarn(
          `[Room ${this.whiteboardRoomId}] Rejected PDF import ${spec.importId}: ${error.message}`,
        );
        return {
          reply: Reply.json(
            {
              error:
                "This PDF import is only partly present on the whiteboard. Remove the imported pages and import again.",
              appliedPageCount: error.appliedPageCount,
              requestedPageCount: error.requestedPageCount,
            },
            409,
          ),
          // The rejection is itself the statement that these pages are on the
          // canvas. Hand them over so the import stops treating them as staged
          // bytes it may still delete.
          placedPageIndices: [...error.appliedPageIndices],
        };
      }
      if (error instanceof ServerMutationTooLargeError) {
        return rejected(
          roomSizeLimitReply(this.whiteboardRoomId, "PDF import", error),
        );
      }
      throw error;
    }

    if (!placement) return rejected(pageLimitReply());
    const placedPageIndices = placement.placed.map((page) => page.pageIndex);
    try {
      this.host.noteMutationBytes(writtenBytes);
      this.host.notePageFramesChanged();
      if (movedNavigation) this.host.navigated(userId);
      return {
        reply: Reply.json({
          status: "pages_imported",
          placed: placement.placed,
          page: { pageId: placement.firstPageId, pageNumber: placement.firstPageNumber } satisfies PageTarget,
        }),
        placedPageIndices,
      };
    } catch (error) {
      // The storage transaction has committed: these R2 objects now belong to
      // live canvas records even if cache refresh failed. Return that ownership explicitly so every cleanup path keeps
      // them, while still surfacing the post-commit failure to the client.
      logError(
        `[Room ${this.whiteboardRoomId}] PDF import ${spec.importId} committed but post-commit reconciliation failed:`,
        error,
      );
      return {
        reply: Reply.json(
          { error: "PDF pages were imported, but whiteboard reconciliation failed" },
          500,
        ),
        placedPageIndices,
      };
    }
  }
}
