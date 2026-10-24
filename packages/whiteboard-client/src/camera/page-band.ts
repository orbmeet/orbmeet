// The camera's geometry over the board's pages: what part of the board a
// camera shows, as a band of a page, and the camera that shows a band. A view
// of the reader's own is kept as a page and a band of it (see `BoardView`),
// so it survives a resize, a panel opening and a page being inserted above.

/** A band of a page, as fractions of the page: x and w of its width, y and h of its height from its top. */
export interface PageBand {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a page sits on the board, as far as this geometry cares. */
export interface PageExtent {
  y: number;
  height: number;
  width: number;
}

export interface ScreenSize {
  width: number;
  height: number;
}

export interface ScreenInsets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface CameraState {
  x: number;
  y: number;
  z: number;
}

/** Page-space rect (tldraw page coordinates, not fractions). */
export interface PageSpaceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// tldraw maps a page point p to screen (p + camera) × zoom. All band math
// below is inset-adjusted: the "band" is the part of the viewport not covered
// by floating UI.

export function visibleBoundsForCamera(
  camera: CameraState,
  viewport: ScreenSize,
  insets: ScreenInsets,
): PageSpaceRect {
  const z = Math.max(camera.z, 1e-6);
  const bandW = Math.max(1, viewport.width - insets.left - insets.right);
  const bandH = Math.max(1, viewport.height - insets.top - insets.bottom);
  return {
    x: insets.left / z - camera.x,
    y: insets.top / z - camera.y,
    w: bandW / z,
    h: bandH / z,
  };
}

export function pageSpaceRectToFractions(bounds: PageSpaceRect, page: PageExtent): PageBand {
  const width = Math.max(page.width, 1);
  const height = Math.max(page.height, 1);
  return {
    x: bounds.x / width,
    y: (bounds.y - page.y) / height,
    w: bounds.w / width,
    h: bounds.h / height,
  };
}

export function fractionsToPageSpaceRect(band: PageBand, page: PageExtent): PageSpaceRect {
  return {
    x: band.x * page.width,
    y: page.y + band.y * page.height,
    w: band.w * page.width,
    h: band.h * page.height,
  };
}

/** The camera at `zoom` whose visible band is centred on `bounds`. */
export function cameraFocusingBounds(options: {
  bounds: PageSpaceRect;
  viewport: ScreenSize;
  insets: ScreenInsets;
  zoom: number;
}): CameraState {
  const { bounds, viewport, insets } = options;
  const z = Math.max(options.zoom, 1e-6);
  const bandW = Math.max(1, viewport.width - insets.left - insets.right);
  const bandH = Math.max(1, viewport.height - insets.top - insets.bottom);
  const centerX = bounds.x + bounds.w / 2;
  const centerY = bounds.y + bounds.h / 2;
  return {
    x: (insets.left + bandW / 2) / z - centerX,
    y: (insets.top + bandH / 2) / z - centerY,
    z,
  };
}

/** The page whose vertical extent contains `y`; otherwise the page whose center is nearest. -1 only for an empty list. */
export function findPageIndexAtY(pages: readonly { y: number; height: number }[], y: number): number {
  for (let i = 0; i < pages.length; i += 1) {
    if (y >= pages[i].y && y <= pages[i].y + pages[i].height) return i;
  }
  let nearestIndex = -1;
  let nearestDistance = Infinity;
  for (let i = 0; i < pages.length; i += 1) {
    const distance = Math.abs(y - (pages[i].y + pages[i].height / 2));
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = i;
    }
  }
  return nearestIndex;
}
