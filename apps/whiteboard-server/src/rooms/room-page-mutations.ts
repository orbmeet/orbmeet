import {
  AssetRecordType,
  createShapeId,
  type TLAsset,
  type TLParentId,
  type TLRecord,
  type TLShapeId,
} from "@tldraw/tlschema";
import { getIndexAbove, getIndexBelow, type IndexKey } from "@tldraw/utils";

import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import { DEFAULT_PAGE_BACKGROUND } from "@orbmeet/whiteboard-core/page-background";
import {
  INITIAL_PAGE_FRAME_ID,
  planPageFrameInsertion,
  type PageFrameShape,
} from "@orbmeet/whiteboard-core/page-frame-model";
import { WHITEBOARD_PAGE_SHAPE_TYPE } from "@orbmeet/whiteboard-core/page-shape-schema";
import { fitContained } from "@orbmeet/whiteboard-core/pdf-geometry";
import { pdfPageAssetName, pdfPageShapeKey } from "@orbmeet/whiteboard-core/pdf-page-asset";
import { withShapeAuthor, type ShapeAuthor } from "@orbmeet/whiteboard-core/shape-author";
import { buildWhiteboardAssetApiPath } from "@orbmeet/whiteboard-core/whiteboard-asset-key";
import { whiteboardTLSchema } from "@orbmeet/whiteboard-core/room-schema";
import {
  applyPageFrameUpdate,
  getPageFrameNameForNumber,
  getPageFrameRecords,
  getPageFrameRenumberUpdates,
  getPageFrameShiftUpdates,
  getRecordIndex,
  isPageFrameRecord,
  isPageRecord,
} from "@orbmeet/whiteboard-core/page-frame-model";

const { PAGE_WIDTH, PAGE_HEIGHT, PAGE_SPACING, MAX_PAGES } = WHITEBOARD_CONFIG;

export type MutableRecordTransaction = {
  values(): Iterable<TLRecord>;
  set(id: TLRecord["id"], record: TLRecord): void;
};

export interface ImportedPdfPageSpec {
  pageIndex: number;
  r2Key: string;
  size: number;
  sourceWidth: number;
  sourceHeight: number;
  frameHeight: number;
  fileName: string;
  /** The `space_assets` row this page was rendered from, when the host app
   *  files its PDFs. Absent for an import with no Files integration. */
  sourceFileId?: string;
  sourcePageNumber?: number;
}

/**
 * Provenance stamped on an imported page frame.
 *
 * This rides in tldraw `meta` rather than shape `props` deliberately. `props`
 * are schema-validated and versioned, so adding fields there means a document
 * migration on every existing board; `meta` is free-form per-shape data that
 * old and new clients both round-trip untouched. Nothing reads it yet — it is
 * the record that makes a later backing-layer render possible without having
 * to guess which flattened raster came from which page of which file.
 */
function importedPageMeta(page: ImportedPdfPageSpec): Record<string, string | number> {
  return page.sourceFileId && page.sourcePageNumber
    ? { sourceFileId: page.sourceFileId, sourcePageNumber: page.sourcePageNumber }
    : {};
}

interface AppliedImportedPage {
  id: TLShapeId;
  pageIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CreatedWhiteboardPage {
  pageId: TLShapeId;
  pageNumber: number;
  pageCount: number;
}

export interface ImportedPagesPlacement {
  placed: AppliedImportedPage[];
  pageCount: number;
  firstPageNumber: number;
  firstPageId: TLShapeId;
}

export class PdfImportPlacementAbortedError extends Error {
  constructor() {
    super("PDF import placement changed while the import was in progress");
    this.name = "PdfImportPlacementAbortedError";
  }
}

/**
 * A continuation batch named an anchor page that is not in the document.
 *
 * Only a batch after the first carries an anchor, and it names a page this same
 * import placed moments ago. Its absence means the document moved under the
 * import in a way the client's page ordering no longer describes (the anchor
 * frame was deleted, or the room was restored from an older snapshot), so there
 * is no position that can be called correct. Refuse rather than fall back to a
 * numeric index, which is exactly the guess that puts pages out of order.
 */
export class PdfImportAnchorMissingError extends Error {
  readonly anchorPageIndex: number;

  constructor(anchorPageIndex: number) {
    super(
      `PDF import anchor page ${anchorPageIndex} is no longer in the document`,
    );
    this.anchorPageIndex = anchorPageIndex;
    this.name = "PdfImportAnchorMissingError";
  }
}

/**
 * Some — but not all — of this import's pages are already in the document.
 *
 * Distinct from a placement abort: nothing has been written, and re-running the
 * same request cannot resolve it, because the idempotency check will keep seeing
 * the same partial set. It needs its own verdict so the caller does not report a
 * page-limit rejection the operator would chase instead.
 */
export class PdfImportPartiallyAppliedError extends Error {
  readonly appliedPageCount: number;
  readonly requestedPageCount: number;
  readonly appliedPageIndices: readonly number[];

  constructor(
    appliedPageCount: number,
    requestedPageCount: number,
    /**
     * Page indices whose image shape is already in the document. The verdict
     * itself means these pages exist on the canvas, so the import owns their
     * objects — reporting them lets the caller transfer ownership before the
     * rejection, instead of leaving a rollback free to delete objects live
     * shapes still reference.
     */
    appliedPageIndices: readonly number[],
  ) {
    super(
      `PDF import is partially applied (${appliedPageCount} of ${requestedPageCount} pages present)`,
    );
    this.appliedPageCount = appliedPageCount;
    this.requestedPageCount = requestedPageCount;
    this.appliedPageIndices = appliedPageIndices;
    this.name = "PdfImportPartiallyAppliedError";
  }
}

/** The asset record an imported PDF page is stored as. */
function getPdfImportAssetId(importId: string, pageIndex: number) {
  return AssetRecordType.createId(`pdf-${importId}-${pageIndex}`);
}

function getPdfImportImageShapeId(importId: string, pageIndex: number) {
  return createShapeId(pdfPageShapeKey(importId, pageIndex));
}

function getPdfImportFrameId(importId: string, pageIndex: number) {
  return createShapeId(`pdf-frame-${importId}-${pageIndex}`);
}

function buildImportedPdfAsset(
  importId: string,
  page: ImportedPdfPageSpec,
): TLAsset {
  return AssetRecordType.create({
    id: getPdfImportAssetId(importId, page.pageIndex),
    type: "image",
    props: {
      name: pdfPageAssetName(page.fileName, page.pageIndex),
      src: buildWhiteboardAssetApiPath(page.r2Key),
      w: page.sourceWidth,
      h: page.sourceHeight,
      mimeType: "image/png",
      isAnimated: false,
      fileSize: page.size,
    },
    meta: {},
  });
}

function getLowestChildIndex(records: readonly TLRecord[], parentId: TLShapeId): IndexKey | null {
  let lowest: IndexKey | null = null;
  for (const record of records) {
    if (
      record.typeName !== "shape" ||
      !("parentId" in record) ||
      record.parentId !== parentId
    ) {
      continue;
    }
    const index = getRecordIndex(record);
    if (!index) continue;
    if (!lowest || index < lowest) lowest = index;
  }
  return lowest;
}

/**
 * `lowestChildIndex` is the frame's current lowest child index, or null when it
 * has no children — which is always the case for a frame this import just
 * created. Passing it in (rather than re-deriving it from the record set) keeps
 * the per-page loop from materializing the whole document once per page to
 * compute a value that is known to be null for every page but a reused one.
 */
function buildImportedPdfImageShape(
  importId: string,
  page: ImportedPdfPageSpec,
  frame: PageFrameShape,
  lowestChildIndex: IndexKey | null,
  author: ShapeAuthor | null,
): TLRecord {
  const fit = fitContained(
    page.sourceWidth,
    page.sourceHeight,
    frame.props.w,
    frame.props.h,
  );
  return whiteboardTLSchema.types.shape.create({
    id: getPdfImportImageShapeId(importId, page.pageIndex),
    type: "image",
    parentId: frame.id as TLParentId,
    index: lowestChildIndex ? getIndexBelow(lowestChildIndex) : getIndexAbove(null),
    x: fit.x,
    y: fit.y,
    isLocked: true,
    // The page is the importer's, as anything a client creates is its creator's.
    meta: withShapeAuthor({}, author),
    props: {
      assetId: getPdfImportAssetId(importId, page.pageIndex),
      w: fit.width,
      h: fit.height,
      // PDF pages are static PNGs — never animated.
      playing: false,
      // No external URL; the image is served from our own R2 asset store.
      url: "",
      crop: null,
      flipX: false,
      flipY: false,
      altText: "",
    },
  });
}

function resolveAlreadyAppliedPdfImport(
  importId: string,
  pages: readonly ImportedPdfPageSpec[],
  records: readonly TLRecord[],
): AppliedImportedPage[] | { partial: number[] } | null {
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const placed: AppliedImportedPage[] = [];
  // Every page whose image shape is present, whether or not its frame resolved.
  // A shape on the canvas references its object regardless.
  const found: number[] = [];

  // Every page is looked at: the partial result must name every image
  // already on the canvas, not only those before the first unplaced one.
  for (const page of pages) {
    const image = recordsById.get(getPdfImportImageShapeId(importId, page.pageIndex));
    if (!image) continue;
    found.push(page.pageIndex);
    if (
      image.typeName !== "shape" ||
      !("parentId" in image) ||
      typeof image.parentId !== "string"
    ) {
      continue;
    }
    const frame = recordsById.get(image.parentId);
    if (!frame || !isPageFrameRecord(frame)) continue;
    placed.push({
      id: frame.id,
      pageIndex: page.pageIndex,
      x: frame.x,
      y: frame.y,
      w: frame.props.w,
      h: frame.props.h,
    });
  }

  if (found.length === 0) return null;
  return placed.length === pages.length ? placed : { partial: found };
}

export function addWhiteboardPageInTransaction(
  transaction: MutableRecordTransaction,
  afterPageNumber?: number,
): CreatedWhiteboardPage | null {
  const records = [...transaction.values()] as TLRecord[];
  const frames = getPageFrameRecords(records);
  const nativePage = records.find(isPageRecord);
  if (!nativePage) return null;

  const requestedIndex =
    typeof afterPageNumber === "number" && Number.isFinite(afterPageNumber)
      ? Math.min(frames.length, Math.max(0, Math.trunc(afterPageNumber)))
      : frames.length;
  const plan = planPageFrameInsertion(
    frames.map((frame) => ({ y: frame.y, height: frame.props.h })),
    requestedIndex,
    1,
  );
  if (plan.actualCount <= 0) return null;
  const pageNumber = plan.insertIndex + 1;
  const preferredFrameId =
    frames.length === 0 ? INITIAL_PAGE_FRAME_ID : createShapeId();
  const frameId = records.some((record) => record.id === preferredFrameId)
    ? createShapeId()
    : preferredFrameId;

  let highestIndex: IndexKey | null = null;
  for (const record of records) {
    if (
      record.typeName !== "shape" ||
      !("parentId" in record) ||
      record.parentId !== nativePage.id
    ) {
      continue;
    }
    const index = getRecordIndex(record);
    if (!index) continue;
    if (!highestIndex || index > highestIndex) highestIndex = index;
  }

  const updates: TLRecord[] = [];
  const framesById = new Map(frames.map((frame) => [frame.id, frame]));
  for (const update of getPageFrameShiftUpdates(frames, plan)) {
    const frame = framesById.get(update.id);
    if (frame) updates.push(applyPageFrameUpdate(frame, update));
  }

  const frame = whiteboardTLSchema.types.shape.create({
    id: frameId,
    type: WHITEBOARD_PAGE_SHAPE_TYPE,
    parentId: nativePage.id as TLParentId,
    index: getIndexAbove(highestIndex ?? undefined),
    x: 0,
    y: plan.insertionY,
    props: {
      w: PAGE_WIDTH,
      h: PAGE_HEIGHT,
      name: getPageFrameNameForNumber(pageNumber),
      background: DEFAULT_PAGE_BACKGROUND,
    },
  });

  for (const update of updates) {
    transaction.set(update.id, update);
  }
  transaction.set(frame.id, frame);

  return {
    pageId: frameId,
    pageNumber,
    pageCount: frames.length + plan.actualCount,
  };
}

/**
 * Where this batch goes, resolved against the document as it is right now.
 *
 * A pipelined import places its pages in several batches, each its own
 * transaction. Only the first can be positioned by number: it is chosen from
 * the board the user was looking at, and nothing of this import exists yet.
 * Every later batch instead names the page this import placed immediately
 * before it, and the position is read off that frame's live index here — so an
 * insert by someone else landing between two batches shifts the anchor and the
 * continuation with it, instead of leaving the batch at a stale offset that
 * drops it into the middle of the pages already placed.
 */
function resolveImportInsertIndex(
  spec: {
    importId: string;
    insertIndex: number;
    after?: { pageIndex: number };
  },
  frames: readonly PageFrameShape[],
  recordsById: ReadonlyMap<string, TLRecord>,
): number {
  if (!spec.after) return spec.insertIndex;
  const anchorImage = recordsById.get(
    getPdfImportImageShapeId(spec.importId, spec.after.pageIndex),
  );
  if (
    !anchorImage ||
    anchorImage.typeName !== "shape" ||
    !("parentId" in anchorImage) ||
    typeof anchorImage.parentId !== "string"
  ) {
    throw new PdfImportAnchorMissingError(spec.after.pageIndex);
  }
  const anchorPosition = frames.findIndex(
    (frame) => frame.id === anchorImage.parentId,
  );
  if (anchorPosition < 0) throw new PdfImportAnchorMissingError(spec.after.pageIndex);
  return anchorPosition + 1;
}

export function insertImportedPagesInTransaction(
  transaction: MutableRecordTransaction,
  spec: {
    importId: string;
    insertIndex: number;
    pages: ImportedPdfPageSpec[];
    reuse?: { frameId: string; height: number };
    /**
     * The page of this same import that this batch must follow. Absent on the
     * first batch, which has no predecessor and uses `insertIndex`.
     */
    after?: { pageIndex: number };
    /** Who asked for the import; null when the room no longer knows their name. */
    author?: ShapeAuthor | null;
  },
): ImportedPagesPlacement | null {
  const initialRecords = [...transaction.values()] as TLRecord[];
  const alreadyApplied = resolveAlreadyAppliedPdfImport(
    spec.importId,
    spec.pages,
    initialRecords,
  );
  if (alreadyApplied && "partial" in alreadyApplied) {
    throw new PdfImportPartiallyAppliedError(
      alreadyApplied.partial.length,
      spec.pages.length,
      alreadyApplied.partial,
    );
  }
  if (alreadyApplied) {
    const finalFrames = getPageFrameRecords(initialRecords);
    const firstPlaced = alreadyApplied[0];
    const firstPageNumber = finalFrames.findIndex((frame) => frame.id === firstPlaced.id) + 1;
    return {
      placed: alreadyApplied,
      pageCount: Math.min(MAX_PAGES, finalFrames.length),
      firstPageNumber: firstPageNumber > 0 ? firstPageNumber : 1,
      firstPageId: firstPlaced.id,
    };
  }

  // Nothing has been written yet, so `initialRecords` is still the live state.
  const nativePage = initialRecords.find(isPageRecord);
  if (!nativePage) return null;
  const pageParentId = nativePage.id as TLParentId;

  let frames = getPageFrameRecords(initialRecords);
  const placedFrames: {
    id: TLShapeId;
    x: number;
    y: number;
    w: number;
    h: number;
  }[] = [];

  const pagesForNewFrames = spec.reuse ? spec.pages.slice(1) : spec.pages;
  // Only a reused frame can already hold children; every frame created below is
  // new. Resolve it once here, against the pre-mutation records — the shifts
  // that follow move frames and loose top-level shapes, never frame children.
  let reuseFrameLowestChildIndex: IndexKey | null = null;

  if (spec.reuse) {
    if (spec.pages.length === 0) return null;
    const reuseFrame = frames.find((frame) => frame.id === spec.reuse?.frameId);
    if (!reuseFrame) return null;
    reuseFrameLowestChildIndex = getLowestChildIndex(initialRecords, reuseFrame.id);
    const oldHeight = reuseFrame.props.h;
    const delta = spec.reuse.height - oldHeight;
    const oldBottom = reuseFrame.y + oldHeight;

    // The reused frame takes the first page's provenance: after this it shows
    // that page of that file, whatever it held before.
    transaction.set(reuseFrame.id, {
      ...reuseFrame,
      props: { ...reuseFrame.props, h: spec.reuse.height },
      meta: { ...reuseFrame.meta, ...importedPageMeta(spec.pages[0]) },
    });
    placedFrames.push({
      id: reuseFrame.id,
      x: reuseFrame.x,
      y: reuseFrame.y,
      w: reuseFrame.props.w,
      h: spec.reuse.height,
    });

    if (delta !== 0) {
      for (const frame of frames) {
        if (frame.id === reuseFrame.id) continue;
        if (frame.y >= oldBottom) {
          transaction.set(frame.id, { ...frame, y: frame.y + delta });
        }
      }
    }

    // Frames *were* rewritten above, so this one must re-read.
    frames = getPageFrameRecords([...transaction.values()] as TLRecord[]);
  }

  if (pagesForNewFrames.length > 0) {
    const records = [...transaction.values()] as TLRecord[];
    // Resolved here, not at the top: the reuse branch above rewrites frames,
    // and the anchor's position must be read off the list this insertion will
    // actually plan against.
    const insertIndex = resolveImportInsertIndex(
      spec,
      frames,
      new Map(records.map((record) => [record.id, record])),
    );
    const plan = planPageFrameInsertion(
      frames.map((frame) => ({ y: frame.y, height: frame.props.h })),
      insertIndex,
      pagesForNewFrames.length,
    );
    // The reuse branch above has already resized and shifted records. Returning
    // normally here would make SQLiteSyncStorage commit those partial writes;
    // tldraw rolls the transaction back only when the callback throws.
    if (plan.actualCount !== pagesForNewFrames.length) {
      throw new PdfImportPlacementAbortedError();
    }
    const totalShift = pagesForNewFrames.reduce(
      (sum, page) => sum + page.frameHeight + PAGE_SPACING,
      0,
    );

    const framesById = new Map(frames.map((frame) => [frame.id, frame]));
    for (const update of getPageFrameShiftUpdates(frames, {
      ...plan,
      shiftAmount: totalShift,
    })) {
      const frame = framesById.get(update.id);
      if (frame) transaction.set(frame.id, applyPageFrameUpdate(frame, update));
    }

    let highestIndex: IndexKey | null = null;
    for (const record of records) {
      if (
        record.typeName !== "shape" ||
        !("parentId" in record) ||
        record.parentId !== pageParentId
      ) {
        continue;
      }
      const index = getRecordIndex(record);
      if (!index) continue;
      if (!highestIndex || index > highestIndex) highestIndex = index;
    }

    let cursorY = plan.insertionY;
    let prevIndex: IndexKey | undefined = highestIndex ?? undefined;
    for (const [indexOffset, page] of pagesForNewFrames.entries()) {
      const frameId = getPdfImportFrameId(spec.importId, page.pageIndex);
      const index = getIndexAbove(prevIndex);
      prevIndex = index;
      const frame = whiteboardTLSchema.types.shape.create({
        id: frameId,
        type: WHITEBOARD_PAGE_SHAPE_TYPE,
        parentId: pageParentId,
        index,
        x: 0,
        y: cursorY,
        props: {
          w: PAGE_WIDTH,
          h: page.frameHeight,
          name: getPageFrameNameForNumber(plan.insertIndex + indexOffset + 1),
          background: DEFAULT_PAGE_BACKGROUND,
        },
        meta: importedPageMeta(page),
      });
      transaction.set(frame.id, frame);
      placedFrames.push({
        id: frameId,
        x: 0,
        y: cursorY,
        w: PAGE_WIDTH,
        h: page.frameHeight,
      });
      cursorY += page.frameHeight + PAGE_SPACING;
    }
  }

  if (placedFrames.length !== spec.pages.length) {
    throw new PdfImportPlacementAbortedError();
  }

  const finalFrames = getPageFrameRecords([...transaction.values()] as TLRecord[]);
  const finalFramesById = new Map(finalFrames.map((frame) => [frame.id, frame]));
  for (const update of getPageFrameRenumberUpdates(finalFrames)) {
    const frame = finalFramesById.get(update.id);
    if (frame) transaction.set(frame.id, applyPageFrameUpdate(frame, update));
  }

  const finalFramesAfterRenumber = getPageFrameRecords([...transaction.values()] as TLRecord[]);
  const finalFramesAfterRenumberById = new Map(
    finalFramesAfterRenumber.map((frame) => [frame.id, frame]),
  );
  for (let i = 0; i < spec.pages.length; i += 1) {
    const page = spec.pages[i];
    const placedFrame = placedFrames[i];
    const frame = finalFramesAfterRenumberById.get(placedFrame.id);
    if (!frame) throw new PdfImportPlacementAbortedError();
    const asset = buildImportedPdfAsset(spec.importId, page);
    const image = buildImportedPdfImageShape(
      spec.importId,
      page,
      frame,
      // placedFrames[0] is the reused frame when spec.reuse is set; every other
      // entry is a frame created above and therefore childless.
      spec.reuse && i === 0 ? reuseFrameLowestChildIndex : null,
      spec.author ?? null,
    );
    transaction.set(asset.id, asset);
    transaction.set(image.id, image);
  }

  const firstPlaced = placedFrames[0];
  const firstPageNumber =
    finalFrames.findIndex((frame) => frame.id === firstPlaced.id) + 1;

  return {
    placed: placedFrames.map((frame, index) => ({
      ...frame,
      pageIndex: spec.pages[index].pageIndex,
    })),
    pageCount: Math.min(MAX_PAGES, finalFrames.length),
    firstPageNumber: firstPageNumber > 0 ? firstPageNumber : 1,
    firstPageId: firstPlaced.id,
  };
}
