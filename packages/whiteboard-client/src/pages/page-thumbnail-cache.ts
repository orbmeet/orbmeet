/**
 * A thumbnail store that outlives the tab.
 *
 * Rasterising a page is the expensive half of the rail, and the rail's worst
 * moment is the one right after the board opens: twenty-four empty cards, a
 * render queue that can only run one page at a time, and a person already
 * scrolling. Nothing about that first paint needs to be recomputed — the
 * document is the same document it was when they closed the tab.
 *
 * So a raster is kept as a blob under `(boardId, pageId)` and handed back on
 * the next open. It can be *stale*, and that is fine: a stale thumbnail is a
 * picture of the page as it was, which is a far better answer to "which one is
 * the one I want" than a blank rectangle. The render loop replaces it as soon
 * as it has something newer, and the stored `revision` is what tells it
 * whether it needs to bother.
 *
 * Everything here degrades to a no-op. Safari in a private window, a browser
 * with site data blocked, a quota that is already full — each of those throws
 * somewhere different, and none of them is a reason for the rail not to work.
 */

const DB_NAME = "orbmeet-whiteboard-thumbnails";
const DB_VERSION = 1;
const STORE = "thumbnails";

/** How long a raster nobody has used (written, or confirmed current) is kept before the next open drops it. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;

/** Rasters kept per board. A board past this loses its least-recently-used. */
const MAX_ENTRIES_PER_BOARD = 120;

export interface CachedThumbnail {
  blob: Blob;
  width: number;
  height: number;
  /**
   * The content hash the raster was drawn from. The render loop compares this
   * against the page's current hash to decide whether a restored thumbnail is
   * already current — a document reopened unchanged then never re-renders at
   * all.
   */
  hash: string;
}

interface StoredRow extends CachedThumbnail {
  key: string;
  boardId: string;
  touchedAt: number;
}

/**
 * `null` once we know the environment has no usable IndexedDB, so a board that
 * fails to open the database does not retry on every single page.
 */
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDatabase(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      // Site data blocked outright. Accessing the API is itself the throw.
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(STORE)) return;
      const store = db.createObjectStore(STORE, { keyPath: "key" });
      store.createIndex("boardId", "boardId");
      store.createIndex("touchedAt", "touchedAt");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });

  return dbPromise;
}

function transact(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, mode);
    } catch {
      resolve();
      return;
    }
    // Resolving on *any* terminal state, success or not: a caller that cannot
    // read its cache renders the page instead, which is the same thing it does
    // on a miss. There is nothing here worth propagating as an error.
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
    try {
      run(tx.objectStore(STORE));
    } catch {
      resolve();
    }
  });
}

function rowKey(boardId: string, pageId: string): string {
  return `${boardId}\u0000${pageId}`;
}

/**
 * Every stored raster for one board, keyed by page id.
 *
 * Read as a set rather than page by page: the rail wants all of them in the
 * same frame it first paints, and twenty-four separate transactions to answer
 * one question is how a cache ends up slower than the thing it caches.
 */
export async function readCachedThumbnails(
  boardId: string,
): Promise<Map<string, CachedThumbnail>> {
  const result = new Map<string, CachedThumbnail>();
  if (!boardId) return result;

  const db = await openDatabase();
  if (!db) return result;

  const rows: StoredRow[] = [];
  await transact(db, "readonly", (store) => {
    const index = store.index("boardId");
    const cursorRequest = index.openCursor(IDBKeyRange.only(boardId));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      rows.push(cursor.value as StoredRow);
      cursor.continue();
    };
  });

  const expiredBefore = Date.now() - MAX_AGE_MS;
  for (const row of rows) {
    if (row.touchedAt < expiredBefore) continue;
    if (!(row.blob instanceof Blob)) continue;
    result.set(row.key.slice(boardId.length + 1), {
      blob: row.blob,
      width: row.width,
      height: row.height,
      hash: row.hash,
    });
  }
  return result;
}

export async function writeCachedThumbnail(
  boardId: string,
  pageId: string,
  thumbnail: CachedThumbnail,
): Promise<void> {
  if (!boardId) return;
  const db = await openDatabase();
  if (!db) return;

  const row: StoredRow = {
    key: rowKey(boardId, pageId),
    boardId,
    touchedAt: Date.now(),
    ...thumbnail,
  };
  await transact(db, "readwrite", (store) => {
    store.put(row);
  });
}

/**
 * Record that a stored raster is still in use without rewriting it.
 *
 * A page that has not changed is never rendered again, so its row is never
 * rewritten either; `touchedAt` has to move on use, not only on write, or a
 * board opened every day loses every unchanged page's raster once it passes
 * MAX_AGE_MS, and the per-board cap evicts the oldest written rather than the
 * least recently used.
 */
export async function touchCachedThumbnail(boardId: string, pageId: string): Promise<void> {
  if (!boardId) return;
  const db = await openDatabase();
  if (!db) return;
  await transact(db, "readwrite", (store) => {
    const request = store.get(rowKey(boardId, pageId));
    request.onsuccess = () => {
      const row = request.result as StoredRow | undefined;
      if (row) store.put({ ...row, touchedAt: Date.now() });
    };
  });
}

export async function deleteCachedThumbnails(
  boardId: string,
  pageIds: Iterable<string>,
): Promise<void> {
  if (!boardId) return;
  const keys = [...pageIds].map((pageId) => rowKey(boardId, pageId));
  if (keys.length === 0) return;
  const db = await openDatabase();
  if (!db) return;
  await transact(db, "readwrite", (store) => {
    for (const key of keys) store.delete(key);
  });
}

/**
 * Drop what a board no longer needs: rasters for pages that are gone, anything
 * past its age, and the oldest rows of a board that has outgrown its budget.
 *
 * Run once per board open, off the back of the first read, so the cost lands
 * where nobody is waiting on it.
 */
export async function pruneCachedThumbnails(
  boardId: string,
  livePageIds: ReadonlySet<string>,
): Promise<void> {
  if (!boardId) return;
  const db = await openDatabase();
  if (!db) return;

  const expiredBefore = Date.now() - MAX_AGE_MS;

  // Sweep expired rows across *every* board before pruning this one.
  //
  // A board id is derived from the sync URL and the document id, so anything
  // that changes its shape — as adding the document suffix did — orphans the
  // rows written under the old id. Nothing ever asks for those rows again, and a
  // prune scoped to the board being opened cannot see them, so they sat in the
  // store forever holding blobs for a board that no longer exists under that
  // name. `touchedAt` indexes the whole store, so one cursor over its expired
  // range reclaims them along with any board nobody has opened in MAX_AGE_MS.
  await transact(db, "readwrite", (store) => {
    const cursorRequest = store.index("touchedAt")
      .openCursor(IDBKeyRange.upperBound(expiredBefore, true));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
  });

  const rows: StoredRow[] = [];
  await transact(db, "readonly", (store) => {
    const index = store.index("boardId");
    const cursorRequest = index.openCursor(IDBKeyRange.only(boardId));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      rows.push(cursor.value as StoredRow);
      cursor.continue();
    };
  });
  if (rows.length === 0) return;

  const doomed = new Set<string>();
  const survivors: StoredRow[] = [];

  for (const row of rows) {
    const pageId = row.key.slice(boardId.length + 1);
    if (row.touchedAt < expiredBefore || !livePageIds.has(pageId)) {
      doomed.add(row.key);
      continue;
    }
    survivors.push(row);
  }

  if (survivors.length > MAX_ENTRIES_PER_BOARD) {
    survivors.sort((a, b) => a.touchedAt - b.touchedAt);
    for (const row of survivors.slice(0, survivors.length - MAX_ENTRIES_PER_BOARD)) {
      doomed.add(row.key);
    }
  }

  if (doomed.size === 0) return;
  await transact(db, "readwrite", (store) => {
    for (const key of doomed) store.delete(key);
  });
}
