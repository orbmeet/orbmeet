import { describe, expect, it, vi } from "vitest";

import { RoomPageCommands } from "./room-page-commands.ts";
import {
  PdfImportPartiallyAppliedError,
  PdfImportPlacementAbortedError,
} from "./room-page-mutations.ts";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import { WHITEBOARD_PAGE_SHAPE_TYPE } from "@orbmeet/whiteboard-core/page-shape-schema";
import { createShapeId, type TLRecord } from "@tldraw/tlschema";
import { createRoomNavigation, ROOM_NAVIGATION_ID } from "@orbmeet/whiteboard-core/room-navigation";
import { getIndexAbove, type IndexKey } from "@tldraw/utils";

function pageFrame(index: number, indexKey: IndexKey): TLRecord {
  return {
    id: `shape:page-${index}`,
    typeName: "shape",
    type: WHITEBOARD_PAGE_SHAPE_TYPE,
    parentId: "page:page",
    index: indexKey,
    x: 0,
    y: index * 940,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    props: { w: 1200, h: 900, name: `Page ${index + 1}`, background: "white" },
    meta: {},
  } as TLRecord;
}

/**
 * Enough of a document for `addWhiteboardPageInTransaction` to do real work, so
 * the size gate sees genuine written bytes rather than an empty mutation.
 */
function createLiveTransaction() {
  const records = new Map<string, TLRecord>([
    ["page:main", { id: "page:main", typeName: "page" } as unknown as TLRecord],
  ]);
  return {
    values: () => records.values(),
    set: (id: TLRecord["id"], record: TLRecord) => {
      records.set(id, record);
    },
    size: () => records.size,
  };
}

/** The navigation host of a room in which `activeNavigator` says whether the caller drives. */
function navigationHost(activeNavigator: boolean) {
  return {
    navigationForPageMutation: vi.fn(
      (_current: unknown, target: { pageId: string; pageNumber: number }, userId: string) =>
        activeNavigator
          ? createRoomNavigation({ pageId: target.pageId, pageNumber: target.pageNumber, presenterId: userId })
          : null,
    ),
    navigated: vi.fn(),
  };
}

function createHost(transactionResult: unknown, options?: {
  canAddPages?: boolean;
  canReplaceExistingPage?: boolean;
  activeNavigator?: boolean;
  estimatedRoomBytes?: number;
}) {
  return {
    runTransaction: vi.fn(
      (operation: (transaction: {
        values: () => Iterable<never>;
        set: (id: unknown, record: unknown) => void;
      }) => unknown) =>
        // Drive the operation so the size check and write measurement run,
        // then substitute the fixture result the assertions care about.
        (operation({ values: () => [], set: () => {} }), transactionResult),
    ),
    canAddPages: vi.fn(() => options?.canAddPages ?? true),
    canReplaceExistingPage: vi.fn(() => options?.canReplaceExistingPage ?? true),
    ...navigationHost(options?.activeNavigator ?? false),
    getEstimatedRoomBytes: vi.fn(() => options?.estimatedRoomBytes ?? 0),
    verifyRoomSizeEstimate: vi.fn(() => true),
    noteMutationBytes: vi.fn(),
    notePageFramesChanged: vi.fn(),
  };
}

describe("RoomPageCommands", () => {
  it("initializes a blank document exactly once without borrowing user authority", async () => {
    const transaction = createLiveTransaction();
    const host = createHost(null);
    host.runTransaction = vi.fn((operation) => operation(transaction as never));
    const commands = new RoomPageCommands("room-1", host);

    const first = commands.ensureInitialPage();
    expect(first).toMatchObject({
      ok: true,
      status: "initialized",
      page: { pageNumber: 1 },
    });
    expect(host.notePageFramesChanged).toHaveBeenCalledTimes(1);

    const second = commands.ensureInitialPage();
    expect(second).toEqual({ ok: true, status: "already_initialized" });
    expect(host.notePageFramesChanged).toHaveBeenCalledTimes(1);
  });

  it("transfers ownership of already-present pages when rejecting a partial import", async () => {
    // A 409 whose whole meaning is "some of these pages are already in the
    // document". Keying ownership on success left those pages in the job's
    // `committedPages`, so the client's whole-job rollback deleted objects that
    // live image shapes reference — broken images, permanently.
    const host = createHost(null);
    host.runTransaction = vi.fn(() => {
      throw new PdfImportPartiallyAppliedError(2, 3, [0, 2]);
    });
    const commands = new RoomPageCommands("room-1", host);

    const { reply, placedPageIndices } = commands.insertImportedPages("manager-1", {
      importId: "import-1",
      insertIndex: 0,
      pages: [],
    });

    expect(reply.status).toBe(409);
    expect(placedPageIndices).toEqual([0, 2]);
    expect(reply.json).toMatchObject({
      appliedPageCount: 2,
      requestedPageCount: 3,
    });
  });

  it("transfers no ownership when the placement was aborted", async () => {
    const host = createHost(null);
    host.runTransaction = vi.fn(() => {
      throw new PdfImportPlacementAbortedError();
    });
    const commands = new RoomPageCommands("room-1", host);

    const { reply, placedPageIndices } = commands.insertImportedPages("manager-1", {
      importId: "import-1",
      insertIndex: 0,
      pages: [],
    });

    expect(reply.status).toBe(409);
    // Nothing was written, so the staged objects are still the import's to
    // clean up.
    expect(placedPageIndices).toEqual([]);
  });

  it("transfers ownership when post-commit reconciliation throws", async () => {
    const host = createHost({
      placed: [{ pageIndex: 4 }],
      firstPageId: "shape:page-4",
      firstPageNumber: 5,
      pageCount: 5,
    });
    host.notePageFramesChanged.mockImplementation(() => {
      throw new Error("snapshot failed");
    });
    const commands = new RoomPageCommands("room-1", host);

    const { reply, placedPageIndices } = commands.insertImportedPages("manager-1", {
      importId: "import-1",
      insertIndex: 4,
      pages: [],
    });

    expect(reply.status).toBe(500);
    expect(placedPageIndices).toEqual([4]);
    expect(reply.json).toMatchObject({
      error: expect.stringContaining("reconciliation failed"),
    });
  });

  it("rejects page mutation before opening a storage transaction", async () => {
    const host = createHost(null, { canAddPages: false });
    const commands = new RoomPageCommands("room-1", host);

    const response = commands.addPage("viewer-1");

    expect(response).toEqual({
      ok: false,
      reason: "forbidden",
      message: "Only whiteboard editors can add pages",
    });
    expect(host.runTransaction).not.toHaveBeenCalled();
  });

  it("refuses to reuse an existing page frame for a non-manager editor", async () => {
    // Reusing a frame resizes it, shifts everything below, and rewrites its page
    // provenance — the manager-only structural mutation the CRDT guard enforces.
    // An editor may add pages but not replace one through the import path.
    const host = createHost(null, {
      canAddPages: true,
      canReplaceExistingPage: false,
    });
    const commands = new RoomPageCommands("room-1", host);

    const { reply, placedPageIndices } = commands.insertImportedPages("editor-1", {
      importId: "import-1",
      insertIndex: 0,
      reuse: { frameId: "shape:page-0", height: 600 },
      pages: [],
    });

    expect(reply.status).toBe(403);
    expect(reply.json).toEqual({
      error: "Only whiteboard managers can replace an existing page",
    });
    expect(placedPageIndices).toEqual([]);
    expect(host.runTransaction).not.toHaveBeenCalled();
  });

  it("still lets a non-manager editor append imported pages without reuse", async () => {
    const host = createHost({
      placed: [],
      firstPageId: null,
      firstPageNumber: 1,
      pageCount: 1,
    }, { canAddPages: true, canReplaceExistingPage: false });
    const commands = new RoomPageCommands("room-1", host);

    const { reply } = commands.insertImportedPages("editor-1", {
      importId: "import-1",
      insertIndex: 0,
      pages: [],
    });

    expect(reply.status).toBe(200);
    expect(host.runTransaction).toHaveBeenCalledTimes(1);
  });

  it("adds a page for an editor who does not drive navigation without moving the room", async () => {
    const host = createHost({
      pageId: "shape:page-2",
      pageNumber: 2,
      pageCount: 3,
    });
    const commands = new RoomPageCommands("room-1", host);

    const response = commands.addPage("editor-1", 1);

    expect(response).toEqual({
      ok: true,
      status: "page_added",
      page: { pageId: "shape:page-2", pageNumber: 2 },
    });
    expect(host.notePageFramesChanged).toHaveBeenCalledTimes(1);
    expect(host.navigated).not.toHaveBeenCalled();
  });

  it("moves the room with a page its navigator adds, in the page's own write", async () => {
    const transaction = createLiveTransaction();
    const host = createHost(null, { activeNavigator: true });
    host.runTransaction = vi.fn((operation) => operation(transaction as never));
    const commands = new RoomPageCommands("room-1", host);

    const response = commands.addPage("manager-1");

    expect(response.ok).toBe(true);
    const page = response.ok && "page" in response ? response.page : null;
    const navigation = [...transaction.values()].find((record) => record.id === ROOM_NAVIGATION_ID);
    expect(navigation).toMatchObject({ pageId: page?.pageId, pageNumber: page?.pageNumber, presenterId: "manager-1" });
    expect(host.navigated).toHaveBeenCalledWith("manager-1");
  });

  it("writes no navigation the schema refuses", async () => {
    const transaction = createLiveTransaction();
    const host = createHost(null, { activeNavigator: true });
    host.navigationForPageMutation = vi.fn(() => ({ ...createRoomNavigation(), pageNumber: 0 }));
    host.runTransaction = vi.fn((operation) => operation(transaction as never));
    const commands = new RoomPageCommands("room-1", host);
    const before = transaction.size();

    expect(() => commands.addPage("manager-1")).toThrow();
    expect(transaction.size()).toBe(before);
  });

  it("answers an import with the first page it placed", async () => {
    const placed = [{
      id: "shape:page-2",
      pageIndex: 0,
      x: 0,
      y: 100,
      w: 800,
      h: 1_000,
    }];
    const host = createHost({
      placed,
      firstPageId: "shape:page-2",
      firstPageNumber: 2,
      pageCount: 3,
    }, { activeNavigator: true });
    const commands = new RoomPageCommands("room-1", host);

    const { reply, placedPageIndices } = commands.insertImportedPages("manager-1", {
      importId: "import-1",
      insertIndex: 1,
      pages: [],
    });

    expect(reply.status).toBe(200);
    // Ownership of every placed page transfers to the room.
    expect(placedPageIndices).toEqual([0]);
    expect(reply.json).toEqual({
      status: "pages_imported",
      placed,
      page: { pageId: "shape:page-2", pageNumber: 2 },
    });
  });

  it("reports a page-limit conflict without moving the room", async () => {
    const host = createHost(null, { activeNavigator: true });
    const commands = new RoomPageCommands("room-1", host);

    const response = commands.addPage("manager-1");

    expect(response).toMatchObject({ ok: false, reason: "conflict" });
    expect(response.ok ? "" : response.message).toContain("Maximum page limit");
    expect(host.notePageFramesChanged).not.toHaveBeenCalled();
    expect(host.navigated).not.toHaveBeenCalled();
  });

  describe("room size gate", () => {
    function createSizedHost(estimatedRoomBytes: number) {
      const transaction = createLiveTransaction();
      const host = {
        runTransaction: vi.fn((operation: (t: typeof transaction) => unknown) =>
          operation(transaction),
        ),
        canAddPages: vi.fn(() => true),
        canReplaceExistingPage: vi.fn(() => true),
        ...navigationHost(false),
        getEstimatedRoomBytes: vi.fn(() => estimatedRoomBytes),
        verifyRoomSizeEstimate: vi.fn(() => true),
        noteMutationBytes: vi.fn(),
        notePageFramesChanged: vi.fn(),
      };
      return { host, transaction };
    }

    it("sizes the mutation against the running estimate, not a fresh serialization", async () => {
      const { host, transaction } = createSizedHost(1024);
      const commands = new RoomPageCommands("room-1", host);

      const response = commands.addPage("editor-1");

      expect(response.ok).toBe(true);
      // A frame was actually written, so the measurement is of real bytes.
      expect(transaction.size()).toBe(2);
      expect(host.getEstimatedRoomBytes).toHaveBeenCalled();
      const [notedBytes] = host.noteMutationBytes.mock.calls[0] ?? [];
      expect(notedBytes).toBeGreaterThan(0);
    });

    it("rejects when the estimate plus the mutation crosses the write cap", async () => {
      const { host, transaction } = createSizedHost(WHITEBOARD_CONFIG.MAX_ROOM_WRITE_BYTES);
      host.verifyRoomSizeEstimate.mockImplementation(() => {
        // Verification measures the committed room, not the speculative frame.
        expect(transaction.size()).toBe(1);
        return true;
      });
      const commands = new RoomPageCommands("room-1", host);

      const response = commands.addPage("editor-1");

      expect(response).toMatchObject({
        ok: false,
        reason: "too_large",
        message: "Whiteboard room size limit reached",
        details: { maxBytes: WHITEBOARD_CONFIG.MAX_ROOM_WRITE_BYTES },
      });
      // A rejected mutation must not advance the estimate.
      expect(host.noteMutationBytes).not.toHaveBeenCalled();
      expect(host.notePageFramesChanged).not.toHaveBeenCalled();
      expect(transaction.size()).toBe(1);
    });

    it("rechecks a stale-high estimate before rejecting the mutation", () => {
      const { host, transaction } = createSizedHost(0);
      host.getEstimatedRoomBytes
        .mockReturnValueOnce(WHITEBOARD_CONFIG.MAX_ROOM_WRITE_BYTES)
        .mockReturnValue(0);
      const commands = new RoomPageCommands("room-1", host);

      const response = commands.addPage("editor-1");

      expect(response.ok).toBe(true);
      expect(host.verifyRoomSizeEstimate).toHaveBeenCalledTimes(1);
      expect(host.getEstimatedRoomBytes).toHaveBeenCalledTimes(2);
      expect(transaction.size()).toBe(2);
      expect(host.noteMutationBytes).toHaveBeenCalledTimes(1);
    });

    it("lets an already-applied import retry through a room reading over the cap", async () => {
      // The idempotent branch returns a placement having written nothing, so
      // there is no growth to refuse — but the check summed zero into the
      // estimate and asked whether the *room* was over the cap. A room can sit
      // there legitimately: getEstimatedRoomBytes is an upper bound by design,
      // and the may-shrink headroom admits pushes that leave it above. The
      // client was then permanently unable to complete an import it had in fact
      // already applied.
      const records = new Map<string, TLRecord>([
        ["page:page", { id: "page:page", typeName: "page" } as unknown as TLRecord],
      ]);
      const frame = pageFrame(0, getIndexAbove(undefined));
      records.set(frame.id, frame);
      // Matches getPdfImportImageShapeId("import-1", 0), which is what marks the
      // page as already placed.
      records.set(createShapeId("pdf-page-import-1-0"), {
        id: createShapeId("pdf-page-import-1-0"),
        typeName: "shape",
        type: "image",
        parentId: frame.id,
      } as unknown as TLRecord);

      const transaction = {
        values: () => records.values(),
        set: (id: TLRecord["id"], record: TLRecord) => {
          records.set(id, record);
        },
      };
      const host = {
        runTransaction: vi.fn((operation: (t: typeof transaction) => unknown) =>
          operation(transaction),
        ),
        canAddPages: vi.fn(() => true),
        canReplaceExistingPage: vi.fn(() => true),
        ...navigationHost(false),
        // Strictly above the cap: the estimate is an upper bound, so a room
        // that has shrunk can read over it even though nothing is wrong.
        getEstimatedRoomBytes: vi.fn(() => WHITEBOARD_CONFIG.MAX_ROOM_WRITE_BYTES + 1),
        verifyRoomSizeEstimate: vi.fn(() => true),
        noteMutationBytes: vi.fn(),
        notePageFramesChanged: vi.fn(),
      };
      const commands = new RoomPageCommands("room-1", host);

      const { reply, placedPageIndices } = commands.insertImportedPages("manager-1", {
        importId: "import-1",
        insertIndex: 0,
        pages: [{
          pageIndex: 0,
          r2Key: "whiteboards/wb/assets/imports/import-1/page-1.png",
          size: 1024,
          sourceWidth: 1200,
          sourceHeight: 900,
          frameHeight: 900,
          fileName: "page-1.png",
        }],
      });

      expect(reply.status).toBe(200);
      expect(placedPageIndices).toEqual([0]);
    });

    it("charges a record rewritten inside one transaction once", () => {
      // A PDF import sets each frame up to three times (reuse shift, insert
      // shift, renumber) and each loose shape twice. Summing every `set`
      // charged one record several times over — and that inflated total is what
      // noteMutationBytes folds into the room's running estimate, so the error
      // outlives the call.
      const records = new Map<string, TLRecord>([
        ["page:page", { id: "page:page", typeName: "page", name: "Page 1", index: "a1", meta: {} } as unknown as TLRecord],
      ]);
      // Two existing pages plus a reuse, which is the shape that rewrites:
      // the reused frame is resized and then renumbered, and the frame below it
      // is shifted and then renumbered — two writes each, one call.
      let indexKey: IndexKey | undefined;
      for (const index of [0, 1]) {
        indexKey = getIndexAbove(indexKey);
        const frame = pageFrame(index, indexKey);
        records.set(frame.id, frame);
      }
      const written = new Set<string>();
      const transaction = {
        values: () => records.values(),
        set: (id: TLRecord["id"], record: TLRecord) => {
          written.add(id);
          records.set(id, record);
        },
      };
      const host = {
        runTransaction: vi.fn((operation: (t: typeof transaction) => unknown) =>
          operation(transaction),
        ),
        canAddPages: vi.fn(() => true),
        canReplaceExistingPage: vi.fn(() => true),
        ...navigationHost(false),
        getEstimatedRoomBytes: vi.fn(() => 0),
        verifyRoomSizeEstimate: vi.fn(() => true),
        noteMutationBytes: vi.fn(),
        notePageFramesChanged: vi.fn(),
      };
      const importId = "00000000-0000-4000-8000-000000000042";
      const commands = new RoomPageCommands("room-1", host);

      const result = commands.insertImportedPages("editor-1", {
        importId,
        insertIndex: 0,
        reuse: { frameId: "shape:page-0", height: 600 },
        pages: [0, 1].map((pageIndex) => ({
          pageIndex,
          r2Key: `whiteboards/whiteboard_1/assets/imports/${importId}/page-${pageIndex + 1}.png`,
          size: 100,
          sourceWidth: 600,
          sourceHeight: 300,
          frameHeight: 600,
          fileName: "import.pdf",
        })),
      });

      expect(result.reply.status).toBe(200);
      // The invariant: what the guard is told matches what the transaction
      // actually committed, so a rewritten record cannot be double-charged.
      const committedBytes = [...written].reduce(
        (total, id) => total + Buffer.byteLength(JSON.stringify(records.get(id)), "utf8"),
        0,
      );
      expect(host.noteMutationBytes).toHaveBeenCalledWith(committedBytes);
    });

    it("admits a mutation that lands exactly at the cap", async () => {
      // Boundary: the gate rejects strictly above the cap, so an estimate that
      // leaves room for the write must still succeed.
      const { host, transaction } = createSizedHost(0);
      const commands = new RoomPageCommands("room-1", host);

      expect(commands.addPage("editor-1").ok).toBe(true);
      expect(transaction.size()).toBe(2);
    });
  });
});
