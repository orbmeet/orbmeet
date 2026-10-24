// The permanent tool dock occupies a stable band above the canvas document.

/**
 * The band a regular board keeps clear down the left of the page while it
 * has a tool palette: the palette is 44px wide and 8px in, and the page
 * stands 16px clear of it.
 */
export const WHITEBOARD_PALETTE_BAND_PX = 68;

/** The least a regular board keeps between the page and an edge with nothing on it. */
export const WHITEBOARD_EDGE_INSET_PX = 16;

/**
 * Height of the band at the top of the board. Published to CSS as
 * `--whiteboard-toolbar-height` by the whiteboard document element, so the
 * band the camera reserves and the band the chrome paints are one number.
 *
 * On a compact board it is the tool strip. On a regular board it holds the
 * pill a reader uses to ask for edit access, beside the page and zoom
 * controls in the corner (see `WHITEBOARD_CONTROLS_BAND_PX`, which is the
 * band the camera keeps clear there).
 */
export const WHITEBOARD_TOOLBAR_HEIGHT = {
  regular: 48,
  compact: 58,
} as const;

// The camera's bottom inset mirrors the overlay stack actually covering the
// canvas. All values are screen px inside the whiteboard cell.
//
// The cell is not the screen. In a meeting the whiteboard renders inside
// `inset-stage`, whose bottom edge already sits above the phone dock — that is
// the entire job of `--stage-bottom`. Adding the dock's clearance again here
// would count it twice and float a landscape page high in the viewport with
// empty desk beneath it.
//
// Anything below this line reserves space for overlays *inside* the cell only.
// Chrome outside the cell is the stage's business.

/** The compact pager dock: h-11 buttons + container padding/border. */
export const VIEWPORT_CONTROLS_HEIGHT_PX = 56;
/** A regular board's control capsules: 30px buttons in a 36px capsule. */
const REGULAR_CONTROLS_HEIGHT_PX = 36;
/** Breathing room between the pager dock and the page content. */
export const VIEWPORT_CONTROLS_GAP_PX = 12;
/** Pager dock offset from the cell bottom (0.75rem). */
export const VIEWPORT_CONTROLS_BOTTOM_OFFSET_PX = 12;
/** A regular board's capsules: their offset from the cell's bottom edge, and the gap above them. */
const REGULAR_CONTROLS_OFFSET_PX = 8;

/**
 * The band at the top of a regular board that holds its page and zoom
 * controls: the capsules, their offset from the cell's top edge, and the gap
 * under them. The camera centres the page in what the bands leave.
 */
export const WHITEBOARD_CONTROLS_BAND_PX =
  REGULAR_CONTROLS_OFFSET_PX * 2 + REGULAR_CONTROLS_HEIGHT_PX;

/**
 * The top band as the controls actually stand, given their measured height.
 * On a board too narrow for the page controls and the status (presenting,
 * following) on one line they wrap to a second, and a band held at one row
 * left that row standing on the page's top-left corner. Never below one row.
 */
export function whiteboardControlsBandPx(controlsHeightPx: number | undefined): number {
  if (controlsHeightPx === undefined) return WHITEBOARD_CONTROLS_BAND_PX;
  return Math.max(WHITEBOARD_CONTROLS_BAND_PX, REGULAR_CONTROLS_OFFSET_PX * 2 + controlsHeightPx);
}

/**
 * The band the pager dock occupies at the bottom of the cell. The only bottom
 * overlay compact portrait has, so it is the whole bottom inset.
 */
export const WHITEBOARD_PAGER_BAND_PX =
  VIEWPORT_CONTROLS_BOTTOM_OFFSET_PX +
  VIEWPORT_CONTROLS_HEIGHT_PX +
  VIEWPORT_CONTROLS_GAP_PX;

/**
 * The page rail: a column of page thumbnails down the left of a regular-size
 * board. It is the answer to "how does anyone know page 2 exists" — the pager
 * in the bottom bar reads `1 / 3` only after you have found it, and a page
 * fitted to the viewport shows no edge of the page below it.
 *
 * The rail sits outside the canvas container — the Tldraw wrapper is offset
 * by this band — so the camera never treats it as an inset. That is
 * deliberate: an asymmetric camera inset cannot be expressed in tldraw's
 * symmetric constraint padding, and the two solvers then disagree about where
 * the page belongs.
 */
export const WHITEBOARD_PAGE_RAIL_WIDTH_PX = 112;

/**
 * A thumbnail's width inside the rail — the rail's own width less its gutters.
 *
 * Exported because the thumbnail renderer solves `pixelRatio` from it. A
 * raster sized for a different card than the one it lands in is either blurry
 * (too small, which is what shipped) or wasteful (too large), and both are
 * invisible in review unless the two numbers are visibly the same number.
 */
export const WHITEBOARD_PAGE_RAIL_CARD_WIDTH_PX = 88;
/** Maximum rendered height of a page thumbnail in the rail. */
export const WHITEBOARD_PAGE_RAIL_CARD_MAX_HEIGHT_PX = 148;
/** Breathing room between the rail and the page beside it. */
export const WHITEBOARD_PAGE_RAIL_GAP_PX = 12;
/** Left band the rail occupies inside the cell. */
export const WHITEBOARD_PAGE_RAIL_BAND_PX =
  WHITEBOARD_PAGE_RAIL_WIDTH_PX + WHITEBOARD_PAGE_RAIL_GAP_PX;

export const WHITEBOARD_PHONE_PORTRAIT_INSETS = {
  left: 16,
  right: 16,
  top: 16,
  bottom: WHITEBOARD_PAGER_BAND_PX,
} as const;

export const WHITEBOARD_PHONE_LANDSCAPE_INSETS = {
  left: 16,
  right: 16,
  top: 16,
  bottom: 52,
} as const;

export interface ViewportScreenSize {
  width: number;
  height: number;
}

/** The side inset of a compact board held upright. */
export const WHITEBOARD_UPRIGHT_SIDE_INSET_PX = 16;
