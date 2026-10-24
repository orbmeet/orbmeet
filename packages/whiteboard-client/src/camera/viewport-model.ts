import type { ScreenInsets, ScreenSize } from "./page-band";
import {
  WHITEBOARD_EDGE_INSET_PX,
  WHITEBOARD_PALETTE_BAND_PX,
  WHITEBOARD_PHONE_LANDSCAPE_INSETS,
  WHITEBOARD_PHONE_PORTRAIT_INSETS,
  WHITEBOARD_TOOLBAR_HEIGHT,
  WHITEBOARD_UPRIGHT_SIDE_INSET_PX,
  VIEWPORT_CONTROLS_BOTTOM_OFFSET_PX,
  VIEWPORT_CONTROLS_GAP_PX,
  whiteboardControlsBandPx,
} from "./viewport-insets";
import {
  controlsPlacement,
  DEFAULT_WHITEBOARD_CHROME,
  type WhiteboardChromeConfig,
} from "../chrome/whiteboard-chrome";

const MIN_FIT_ZOOM = 0.05;
const MAX_FIT_ZOOM = 4;

export interface ViewportModelDimensions {
  pageWidth: number;
  cameraPadding: number;
}

/**
 * What the camera keeps the page clear of, in screen px inside the board's
 * cell. Decided by where the board's controls stand (`controlsPlacement`),
 * never by the cell's own size: a desktop board narrowed by a side panel, or
 * shortened by the faces under it, still has its palette and its top band,
 * and a phone's board in a short stage still has its pager along the bottom.
 */
export function getWhiteboardViewportInsets(
  dimensions: ViewportModelDimensions,
  chrome: WhiteboardChromeConfig = DEFAULT_WHITEBOARD_CHROME
): ScreenInsets {
  const toolbarInset = chrome.toolbarVisible
    ? WHITEBOARD_TOOLBAR_HEIGHT[chrome.mode]
    : 0;

  switch (controlsPlacement(chrome)) {
    case "side":
      // One capsule in the bottom corner; the tools, when there are any, across the top.
      return {
        left: Math.max(dimensions.cameraPadding, WHITEBOARD_PHONE_LANDSCAPE_INSETS.left),
        right: Math.max(dimensions.cameraPadding, WHITEBOARD_PHONE_LANDSCAPE_INSETS.right),
        top: Math.max(dimensions.cameraPadding, WHITEBOARD_PHONE_LANDSCAPE_INSETS.top) + toolbarInset,
        bottom: Math.max(dimensions.cameraPadding, WHITEBOARD_PHONE_LANDSCAPE_INSETS.bottom),
      };
    case "dock":
      // The dock along the bottom — the pager, and whatever status pills are
      // stacked over it as measured — and the tool strip, when there is one,
      // across the top.
      return {
        left: WHITEBOARD_UPRIGHT_SIDE_INSET_PX,
        right: WHITEBOARD_UPRIGHT_SIDE_INSET_PX,
        top: Math.max(dimensions.cameraPadding, WHITEBOARD_PHONE_PORTRAIT_INSETS.top) + toolbarInset,
        bottom: chrome.controlsHeightPx === undefined
          ? WHITEBOARD_PHONE_PORTRAIT_INSETS.bottom
          : Math.max(
              WHITEBOARD_PHONE_PORTRAIT_INSETS.bottom,
              VIEWPORT_CONTROLS_BOTTOM_OFFSET_PX + chrome.controlsHeightPx + VIEWPORT_CONTROLS_GAP_PX,
            ),
      };
    case "corner":
      // A regular board's bands, each the page's breathing room on its side:
      //
      // - left: the tool palette's band while there is a palette, the edge gap
      //   otherwise. Nothing stands on the right, so it is only the edge gap —
      //   the camera centres a page on the board when there is room and nudges
      //   it off the palette when there is not (see `CameraConstraints`).
      // - top: the page and zoom controls everyone uses, in its leading corner;
      //   the edit-access request a reader is offered shares the band, which
      //   grows to a second row when they wrap (as measured).
      // - bottom: only the edge gap. Nothing stands where a writing hand rests.
      //
      // The page rail is not an inset: it is outside the canvas container
      // entirely (see the Tldraw wrapper in synced-whiteboard).
      return {
        left: chrome.toolbarVisible ? WHITEBOARD_PALETTE_BAND_PX : WHITEBOARD_EDGE_INSET_PX,
        right: WHITEBOARD_EDGE_INSET_PX,
        top: Math.max(
          whiteboardControlsBandPx(chrome.controlsHeightPx),
          chrome.toolbarVisible ? 0 : WHITEBOARD_TOOLBAR_HEIGHT.regular,
        ),
        bottom: WHITEBOARD_EDGE_INSET_PX,
      };
  }
}

export function getFitWidthZoom(
  viewport: Pick<ScreenSize, "width"> & Partial<Pick<ScreenSize, "height">>,
  dimensions: ViewportModelDimensions,
  insets: ScreenInsets = {
    left: dimensions.cameraPadding,
    right: dimensions.cameraPadding,
    top: 0,
    bottom: 0,
  },
): number {
  const paddedViewportWidth = Math.max(
    1,
    viewport.width - insets.left - insets.right
  );
  const fitZoom = paddedViewportWidth / dimensions.pageWidth;
  if (!Number.isFinite(fitZoom)) return 1;
  return Math.min(MAX_FIT_ZOOM, Math.max(MIN_FIT_ZOOM, fitZoom));
}

export function getFitRelativeZoom(cameraZoom: number, fitZoom: number): number {
  if (!Number.isFinite(fitZoom) || fitZoom <= 0) return 1;
  return cameraZoom / fitZoom;
}
