/**
 * Gallery geometry: the largest tile that fits, given the stage we actually have.
 *
 * Every previous version of this was a table — "two people means two columns,
 * capped at 64rem" — and a table cannot know the shape of the window it is
 * being poured into. Tiles were `aspect-video` and sized by width alone, so
 * their height was whatever the width cap implied: two people on a 1552×877
 * stage got two 16:9 tiles across the middle and left ~40% of the stage empty
 * above and below them.
 *
 * So we measure instead. For each candidate column count we work out the cell
 * it produces, fit a tile into that cell, and keep whichever count yields the
 * biggest tile. That is the whole algorithm, and it is what makes a lone
 * participant fill the stage while nine of them still tile evenly.
 *
 * Tiles are *not* pinned to 16:9. A 16:9 tile in a tall cell wastes the cell,
 * and camera framing is mostly centred faces, so the tile takes the cell's own
 * proportions — clamped to a sane range — and the video cover-crops into it.
 * That clamp is what stops two people on an ultrawide from becoming two very
 * tall slots, and one person on a tall window from becoming a letterbox.
 */

import { clamp } from "@orbmeet/primitives";

/**
 * Narrowest tile we will draw (width ÷ height). A camera publishes a 16:9
 * frame, and 4:3 is as far as a tile may crop it: at square, three people on a
 * laptop stood in one row of squares with half of each frame thrown away and
 * empty bands above and below, where two rows of wide tiles were nearly as big
 * and showed the whole frame. A tall, narrow window gets letterboxing instead
 * — the honest failure.
 */
export const MIN_TILE_ASPECT = 4 / 3;
/** Widest tile we will draw: the camera's own 16:9. */
export const MAX_TILE_ASPECT = 16 / 9;

export interface GalleryFitInput {
  count: number;
  /** Space available to the tiles, in CSS px, chrome already subtracted. */
  width: number;
  height: number;
  /** Gutter between tiles, in CSS px. */
  gap: number;
  minAspect?: number;
  maxAspect?: number;
}

export interface GalleryFit {
  columns: number;
  rows: number;
  /** Tile size in CSS px. Floored, so a row can never overflow by a subpixel. */
  tileWidth: number;
  tileHeight: number;
}

const EMPTY_FIT: GalleryFit = { columns: 1, rows: 0, tileWidth: 0, tileHeight: 0 };

export function fitGallery({
  count,
  width,
  height,
  gap,
  minAspect = MIN_TILE_ASPECT,
  maxAspect = MAX_TILE_ASPECT,
}: GalleryFitInput): GalleryFit {
  if (count <= 0 || width <= 0 || height <= 0) return EMPTY_FIT;

  let best: GalleryFit | null = null;
  let bestArea = 0;
  let bestWaste = Number.POSITIVE_INFINITY;

  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns);
    const cellWidth = (width - (columns - 1) * gap) / columns;
    const cellHeight = (height - (rows - 1) * gap) / rows;
    if (cellWidth <= 1 || cellHeight <= 1) continue;

    // The tile takes the cell's proportions unless that would make it too tall
    // or too wide to read as a video tile; then it letterboxes inside the cell.
    const aspect = clamp(cellWidth / cellHeight, minAspect, maxAspect);
    const widthLed = cellWidth / cellHeight <= aspect;
    const tileWidth = Math.floor(widthLed ? cellWidth : cellHeight * aspect);
    const tileHeight = Math.floor(widthLed ? cellWidth / aspect : cellHeight);
    if (tileWidth < 1 || tileHeight < 1) continue;

    const area = tileWidth * tileHeight;
    // Empty cells in the last row. Only a tie-breaker: between two layouts that
    // draw the same size tile, the one that fills its rows looks deliberate.
    const waste = columns * rows - count;
    if (area > bestArea || (area === bestArea && waste < bestWaste)) {
      best = { columns, rows, tileWidth, tileHeight };
      bestArea = area;
      bestWaste = waste;
    }
  }

  return best ?? EMPTY_FIT;
}

/**
 * Phones fill the stage with tiles rather than fitting them, so they need a
 * shape and no measurement. The screen is small enough that a cropped tile
 * edge to edge beats any arrangement that leaves margins.
 */
export function getPhoneGridLayout(
  count: number,
  isLandscape: boolean,
): { columns: number; gap: number } {
  if (count === 1) return { columns: 1, gap: 0 };
  if (isLandscape) {
    if (count === 3) return { columns: 3, gap: 4 };
    return { columns: 2, gap: 4 };
  }
  if (count === 2) return { columns: 1, gap: 4 };
  return { columns: 2, gap: 4 };
}

/**
 * How big the contents of a camera-off tile should be, given the tile the fit
 * produced.
 *
 * The gallery measures the stage and grows the tiles; the tile then drew a
 * 64px avatar and a 14px name inside whatever it was given. On a tablet that
 * is a 558px square carrying about 1.3% of its own area as content, which is
 * what made a two-person call read as two empty white boxes.
 *
 * The avatar is a proportion of the tile rather than a step function, so the
 * tile has one appearance that scales rather than three that snap. The clamp
 * is what keeps a nine-up grid's avatars legible and a solo tile's avatar from
 * becoming a wall.
 */
export interface AvatarTileScale {
  avatarPx: number;
  namePx: number;
  statePx: number;
}

const AVATAR_SHARE_OF_TILE = 0.22;
const MIN_AVATAR_PX = 56;
const MAX_AVATAR_PX = 168;

export function getAvatarTileScale(tileHeight: number): AvatarTileScale {
  // No measurement yet (phones, or the frame before the observer reports):
  // the pre-existing fixed sizes are the honest fallback.
  if (!Number.isFinite(tileHeight) || tileHeight <= 0) {
    return { avatarPx: 64, namePx: 14, statePx: 12 };
  }

  const avatarPx = Math.round(
    clamp(tileHeight * AVATAR_SHARE_OF_TILE, MIN_AVATAR_PX, MAX_AVATAR_PX),
  );
  // The name tracks the avatar rather than the tile, so the two always read as
  // one object; the state line sits a step below it.
  const namePx = Math.round(clamp(avatarPx * 0.18, 14, 26));
  const statePx = Math.round(clamp(namePx * 0.82, 12, 20));

  return { avatarPx, namePx, statePx };
}
