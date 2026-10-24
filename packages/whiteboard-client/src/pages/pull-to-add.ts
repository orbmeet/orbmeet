/** Pull distance in screen pixels; convert once at the page-space boundary. */
export const AUTO_ADD_PAGE_PULL_DISTANCE_PX = 140;
export const PULL_TO_ADD_INDICATOR_MIN_PROGRESS = 0.08;
const FIT_WIDTH_ZOOM_MIN_RATIO = 0.75;
const FIT_WIDTH_ZOOM_MAX_RATIO = 1.3;

function getPullToAddDistance(lastPageBottom: number, viewportBottom: number): number {
  return Math.max(0, viewportBottom - lastPageBottom);
}

export function getPullToAddProgress(
  lastPageBottom: number,
  viewportBottom: number,
  pullDistance = AUTO_ADD_PAGE_PULL_DISTANCE_PX,
): number {
  return Math.min(
    1,
    getPullToAddDistance(lastPageBottom, viewportBottom) / pullDistance,
  );
}

export function isPullToAddReady(
  lastPageBottom: number,
  viewportBottom: number,
  pullDistance = AUTO_ADD_PAGE_PULL_DISTANCE_PX,
): boolean {
  return getPullToAddDistance(lastPageBottom, viewportBottom) >= pullDistance;
}

export function hasPulledPastPageTop(
  lastPageTop: number,
  viewportTop: number,
  tolerance = 0
): boolean {
  return viewportTop >= lastPageTop + Math.max(0, tolerance);
}

export function isPullToAddPointerGesture(
  dx: number,
  dy: number,
  minDistance = 24
): boolean {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  if (-dy < minDistance) return false;
  return Math.abs(dy) > Math.abs(dx) * 1.2;
}

export function isNearFitWidthZoom(currentZoom: number, fitWidthZoom: number): boolean {
  if (!Number.isFinite(currentZoom) || !Number.isFinite(fitWidthZoom) || fitWidthZoom <= 0) {
    return false;
  }

  const ratio = currentZoom / fitWidthZoom;
  return ratio >= FIT_WIDTH_ZOOM_MIN_RATIO && ratio <= FIT_WIDTH_ZOOM_MAX_RATIO;
}
