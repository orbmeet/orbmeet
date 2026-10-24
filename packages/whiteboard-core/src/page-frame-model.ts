import { createShapeId } from "@tldraw/tlschema";
import type {
  TLPage,
  TLRecord,
  TLShape,
  TLShapeId,
} from "@tldraw/tlschema";
import { getIndexAbove, type IndexKey } from "@tldraw/utils";

import { WHITEBOARD_CONFIG } from "./config.ts";
import {
  WHITEBOARD_PAGE_SHAPE_TYPE,
  type WhiteboardPageShape,
} from "./page-shape-schema.ts";
import {
  computeFrameShift,
  computeInsertionY,
  findLooseShapeOwnerIndex,
  type FrameGeometry,
  type PageGeometryDimensions,
} from "./page-geometry.ts";

const { MAX_PAGES } = WHITEBOARD_CONFIG;

function compareCodeUnitStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const INITIAL_PAGE_FRAME_ID = createShapeId("page-1");

export type PageFrameShape = WhiteboardPageShape;

export interface PageFrame {
  id: TLShapeId;
  number: number;
  y: number;
  height: number;
  width: number;
}

export interface ResolvedPageNavigationTarget {
  pageId: TLShapeId | null;
  pageNumber: number;
  pageCount: number;
}

export interface InsertPageFramePlan {
  insertIndex: number;
  insertionY: number;
  shiftAmount: number;
  actualCount: number;
}

export interface PageFrameShapeUpdate {
  id: TLShapeId;
  type: typeof WHITEBOARD_PAGE_SHAPE_TYPE;
  y?: number;
  props?: Partial<WhiteboardPageShape["props"]>;
}

export function isPageFrameShape(record: { type?: unknown }): record is PageFrameShape {
  return record.type === WHITEBOARD_PAGE_SHAPE_TYPE;
}

export function comparePageFrames<T extends { id: string; y: number; index?: unknown }>(
  a: T,
  b: T
): number {
  const yDelta = a.y - b.y;
  if (yDelta !== 0) return yDelta;

  const aIndex = typeof a.index === "string" ? a.index : "";
  const bIndex = typeof b.index === "string" ? b.index : "";
  const indexOrder = compareCodeUnitStrings(aIndex, bIndex);
  if (indexOrder !== 0) return indexOrder;

  return compareCodeUnitStrings(a.id, b.id);
}

export function isPageRecord(record: TLRecord): record is TLPage {
  return record.typeName === "page";
}

export function isPageFrameRecord(record: TLRecord): record is PageFrameShape {
  return record.typeName === "shape" && isPageFrameShape(record);
}

/** A store change, as tldraw's listeners and history entries carry it. */
export interface RecordChanges {
  added: Record<string, TLRecord>;
  updated: Record<string, [TLRecord, TLRecord]>;
  removed: Record<string, TLRecord>;
}

/** Whether a store change adds, alters or removes a page frame. */
export function changeTouchesPageFrames(changes: RecordChanges): boolean {
  for (const record of Object.values(changes.added)) {
    if (isPageFrameRecord(record)) return true;
  }
  for (const [before, after] of Object.values(changes.updated)) {
    if (isPageFrameRecord(before) || isPageFrameRecord(after)) return true;
  }
  for (const record of Object.values(changes.removed)) {
    if (isPageFrameRecord(record)) return true;
  }
  return false;
}

export function getPageFrameRecords(records: readonly TLRecord[]): PageFrameShape[] {
  return records.filter(isPageFrameRecord).sort(comparePageFrames);
}

export function getRecordIndex(record: TLRecord): IndexKey | null {
  if (!("index" in record) || typeof record.index !== "string") return null;
  return record.index;
}

export function getPageFrameWidth(frame: PageFrameShape): number {
  return frame.props.w;
}

export function getPageFrameHeight(frame: PageFrameShape): number {
  return frame.props.h;
}

export function getPageFrameName(frame: PageFrameShape): string {
  return frame.props.name;
}

export function getPageFrameBackground(frame: PageFrameShape): unknown {
  return frame.props.background;
}

export function getPageFrameNameForNumber(pageNumber: number): string {
  return `Page ${pageNumber}`;
}

export function toPageFrames(frames: readonly PageFrameShape[]): PageFrame[] {
  return frames.map((frame, index) => ({
    id: frame.id,
    number: index + 1,
    y: frame.y,
    width: getPageFrameWidth(frame),
    height: getPageFrameHeight(frame),
  }));
}

export function getPageFrames(records: readonly TLRecord[]): PageFrame[] {
  return toPageFrames(getPageFrameRecords(records));
}

export function resolvePageNavigationTarget(
  records: readonly TLRecord[],
  requestedPageNumber: number,
  requestedPageId?: string | null
): ResolvedPageNavigationTarget {
  const frames = getPageFrameRecords(records);
  if (frames.length === 0) {
    return { pageId: null, pageNumber: 1, pageCount: 1 };
  }

  const pageCount = Math.min(MAX_PAGES, frames.length);

  if (requestedPageId) {
    const pageIdIndex = frames.findIndex((frame) => frame.id === requestedPageId);
    if (pageIdIndex >= 0 && pageIdIndex < pageCount) {
      return {
        pageId: frames[pageIdIndex].id,
        pageNumber: pageIdIndex + 1,
        pageCount,
      };
    }
  }

  const safePageNumber = Math.min(
    pageCount,
    Math.max(1, finiteTrunc(requestedPageNumber, 1))
  );
  const frame = frames[safePageNumber - 1];
  return {
    pageId: frame?.id ?? null,
    pageNumber: safePageNumber,
    pageCount,
  };
}

function finiteTrunc(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

export function planPageFrameInsertion(
  frames: readonly FrameGeometry[],
  requestedIndex: number,
  requestedCount: number,
  dims?: PageGeometryDimensions
): InsertPageFramePlan {
  const available = MAX_PAGES - frames.length;
  // Floored last: a board already past the limit has negative room left.
  const actualCount = Math.max(
    0,
    Math.min(finiteTrunc(requestedCount, 0), available)
  );
  const insertIndex = Math.max(
    0,
    Math.min(finiteTrunc(requestedIndex, frames.length), frames.length)
  );
  return {
    insertIndex,
    actualCount,
    insertionY: computeInsertionY(frames, insertIndex, dims),
    shiftAmount: computeFrameShift(actualCount, dims),
  };
}

function getExistingPageFrameName(frame: { props?: { name?: unknown } }): string | null {
  return typeof frame.props?.name === "string" ? frame.props.name : null;
}

export function getPageFrameShiftUpdates<
  T extends { id: TLShapeId; y: number; props?: { name?: unknown } },
>(
  frames: readonly T[],
  plan: InsertPageFramePlan
): PageFrameShapeUpdate[] {
  const sortedFrames = [...frames].sort(comparePageFrames);
  const updates: PageFrameShapeUpdate[] = [];

  for (let i = plan.insertIndex; i < sortedFrames.length; i += 1) {
    const frame = sortedFrames[i];
    const expectedName = getPageFrameNameForNumber(i + plan.actualCount + 1);
    const props =
      getExistingPageFrameName(frame) === expectedName
        ? undefined
        : { name: expectedName };

    updates.push({
      id: frame.id,
      type: WHITEBOARD_PAGE_SHAPE_TYPE,
      y: frame.y + plan.shiftAmount,
      ...(props ? { props } : null),
    });
  }

  return updates;
}

export function getPageFrameRenumberUpdates<
  T extends { id: TLShapeId; y: number; props?: { name?: unknown } },
>(
  frames: readonly T[]
): PageFrameShapeUpdate[] {
  const sortedFrames = [...frames].sort(comparePageFrames);
  const updates: PageFrameShapeUpdate[] = [];

  for (let i = 0; i < sortedFrames.length; i += 1) {
    const frame = sortedFrames[i];
    const expectedName = getPageFrameNameForNumber(i + 1);
    if (getExistingPageFrameName(frame) === expectedName) continue;

    updates.push({
      id: frame.id,
      type: WHITEBOARD_PAGE_SHAPE_TYPE,
      props: { name: expectedName },
    });
  }

  return updates;
}

export function applyPageFrameUpdate<T extends PageFrameShape>(
  frame: T,
  update: PageFrameShapeUpdate
): T {
  return {
    ...frame,
    ...(typeof update.y === "number" ? { y: update.y } : null),
    ...(update.props
      ? {
          props: {
            ...frame.props,
            ...update.props,
          },
        }
      : null),
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getPointY(point: unknown): number | null {
  if (!point || typeof point !== "object") return null;
  return finiteNumber((point as { y?: unknown }).y);
}

/**
 * Accumulates the vertical extent of every point in a shape's props.
 *
 * Tracks the running min/max rather than collecting the points, because a single
 * freehand stroke can carry tens of thousands of them and `Math.min(...points)`
 * throws RangeError once the array exceeds the engine's argument limit. This runs
 * server-side inside the page-insert storage transaction, where that throw would
 * fail every page add and PDF import for the room.
 */
interface VerticalExtent {
  min: number;
  max: number;
  found: boolean;
}

function collectPointYs(value: unknown, extent: VerticalExtent): void {
  const y = getPointY(value);
  if (y !== null) {
    if (!extent.found) {
      extent.min = y;
      extent.max = y;
      extent.found = true;
    } else {
      if (y < extent.min) extent.min = y;
      if (y > extent.max) extent.max = y;
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPointYs(item, extent);
    }
    return;
  }

  if (!value || typeof value !== "object") return;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    collectPointYs(nested, extent);
  }
}

export function getApproximateShapeCenterY(record: TLShape): number {
  const props = record.props as Record<string, unknown>;
  const h = finiteNumber(props.h);
  if (h !== null) return record.y + h / 2;

  const extent: VerticalExtent = { min: 0, max: 0, found: false };
  if ("segments" in props) collectPointYs(props.segments, extent);
  if ("points" in props) collectPointYs(props.points, extent);
  if ("handles" in props) collectPointYs(props.handles, extent);
  if ("start" in props) collectPointYs(props.start, extent);
  if ("end" in props) collectPointYs(props.end, extent);

  if (!extent.found) return record.y;

  return record.y + (extent.min + extent.max) / 2;
}

/**
 * The records that put every loose shape — one sitting on the canvas itself
 * rather than on a page — onto the page that owns it, or nothing when there
 * is none.
 *
 * Everything on the board belongs to a page: it is drawn on it, clipped by
 * it, and moves with it when pages are inserted, deleted or resized. New
 * content is put on its page as it is made; this brings content from before
 * that (an older board, a restored revision) into line, so nothing that moves
 * pages has to move loose content as well.
 *
 * The owner is the page under the shape's centre, as everywhere else
 * (`findLooseShapeOwnerIndex`); a shape above the first page goes to the
 * first. The shape keeps where it is on screen — its position becomes
 * relative to the page — and loose shapes keep their order among themselves,
 * above what was on the page already.
 */
export function attachLooseShapesToPages(records: readonly TLRecord[]): TLShape[] {
  const frames = getPageFrameRecords(records);
  if (frames.length === 0) return [];
  const canvasIds = new Set<string>(records.filter(isPageRecord).map((page) => page.id));
  const loose = records
    .filter(
      (record): record is TLShape =>
        record.typeName === "shape" && !isPageFrameShape(record) && canvasIds.has(record.parentId),
    )
    .sort((a, b) => compareCodeUnitStrings(a.index, b.index) || compareCodeUnitStrings(a.id, b.id));
  if (loose.length === 0) return [];

  const frameIds = new Set<string>(frames.map((frame) => frame.id));
  const highestChild = new Map<string, IndexKey>();
  for (const record of records) {
    if (record.typeName !== "shape" || !frameIds.has(record.parentId)) continue;
    const highest = highestChild.get(record.parentId);
    if (!highest || compareCodeUnitStrings(record.index, highest) > 0) highestChild.set(record.parentId, record.index);
  }

  const geometry = frames.map((frame) => ({ y: frame.y, height: frame.props.h }));
  return loose.map((shape) => {
    const frame = frames[Math.max(0, findLooseShapeOwnerIndex(geometry, getApproximateShapeCenterY(shape)))];
    const index = getIndexAbove(highestChild.get(frame.id));
    highestChild.set(frame.id, index);
    return { ...shape, parentId: frame.id, index, x: shape.x - frame.x, y: shape.y - frame.y };
  });
}

export {
  computeFrameShift,
  computeInsertionY,
  type FrameGeometry,
  type PageGeometryDimensions,
};
