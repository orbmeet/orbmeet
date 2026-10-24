import { WHITEBOARD_CONFIG } from "./config.ts";

// Pure page-layout arithmetic shared by the client PageManager (browser, drives a
// tldraw Editor) and the server room-manager (Node, mutates the store directly).
// Both must compute insertion points and frame shifts identically or page inserts
// drift between who runs the math. Keep this module free of tldraw Editor and
// Node APIs so both sides can import it.

const { PAGE_HEIGHT, PAGE_SPACING } = WHITEBOARD_CONFIG;

export interface PageGeometryDimensions {
  /** Configured page height (not a measured frame height). */
  height: number;
  spacing: number;
}

/** Minimal frame shape this module reasons about: a top edge and a height. */
export interface FrameGeometry {
  y: number;
  height: number;
}

const DEFAULT_DIMENSIONS: PageGeometryDimensions = {
  height: PAGE_HEIGHT,
  spacing: PAGE_SPACING,
};

// The vertical distance every frame at/below an insertion point moves when `count`
// pages are inserted. Uses the configured page height (not measured frame heights)
// so client and server always shift by the same predictable amount.
export function computeFrameShift(
  count: number,
  dims: PageGeometryDimensions = DEFAULT_DIMENSIONS,
): number {
  return count * (dims.height + dims.spacing);
}

// The page-space Y at which a page inserted at `insertIndex` begins:
//   - before an existing frame  → that frame's current top
//   - appended after the last   → just below it (its measured height + spacing)
//   - empty document            → 0
// `insertIndex` is assumed already clamped to [0, frames.length].
export function computeInsertionY(
  frames: readonly FrameGeometry[],
  insertIndex: number,
  dims: PageGeometryDimensions = DEFAULT_DIMENSIONS,
): number {
  if (insertIndex < frames.length) {
    return frames[insertIndex].y;
  }
  const lastFrame = frames[frames.length - 1];
  if (!lastFrame) return 0;
  return lastFrame.y + lastFrame.height + dims.spacing;
}

/**
 * Which page a loose (non-frame, top-level) shape belongs to, as an index into
 * `frames` (which must be sorted by `y`), or -1 when no page owns it.
 *
 * Ownership is one-dimensional: pages are stacked vertically and all share the
 * same horizontal extent, so the shape's center Y decides it. Answering it
 * with a two-dimensional overlap test instead assigns a shape straddling the
 * seam between two pages to *both*.
 *
 * The center is resolved to the last page starting at or above it, so a shape
 * parked in the gap below a page belongs to that page. A center above the
 * first page is owned by nothing (`attachLooseShapesToPages` gives it to the
 * first page).
 */
export function findLooseShapeOwnerIndex(
  frames: readonly FrameGeometry[],
  shapeCenterY: number,
): number {
  let low = 0;
  let high = frames.length - 1;
  let owner = -1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (frames[mid].y <= shapeCenterY) {
      owner = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return owner;
}

/**
 * Where each frame belongs once the stack is closed up: the first at the top
 * (y = 0), and each next one `spacing` below the bottom of the one before it,
 * at its own measured height. A deleted page leaves a gap; this is the layout
 * that closes it. `frames` must already be in page order.
 */
export function computeCompactedFrameYs(
  frames: readonly FrameGeometry[],
  dims: PageGeometryDimensions = DEFAULT_DIMENSIONS,
): number[] {
  const ys: number[] = [];
  let cursor = 0;
  for (const frame of frames) {
    ys.push(cursor);
    cursor += frame.height + dims.spacing;
  }
  return ys;
}
