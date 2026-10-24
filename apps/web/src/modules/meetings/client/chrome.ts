/**
 * Meeting-room chrome geometry — the one place the room's fixed furniture is
 * measured.
 *
 * The room is a full-bleed stage with chrome floating over it: a slim header at
 * the top and, on phones, a dock at the bottom. Every surface that has to stay
 * clear of that furniture — the video grid, the whiteboard camera, permission
 * trays — derives its insets from these numbers instead of
 * carrying its own copy. Before this module those copies had drifted: the
 * layout said `5rem`, the whiteboard said `80`, and nothing tied them together.
 *
 * These values are chrome only. They deliberately exclude the device safe-area
 * insets, which are added on top by the layout shell (web) or by the host
 * viewport (whiteboard). Keeping the two separate is what lets the same numbers
 * describe a notched phone and a desktop browser.
 *
 * All values are CSS pixels.
 */

/**
 * Slim phone header: a 40px control row — code and clock, then the lock and
 * People — plus 2px of air above and below it.
 */
export const PHONE_HEADER_HEIGHT_PX = 44;

/**
 * The phone header's second row, while there is a board or a screen to switch
 * to: Talk | Board as one segmented control, a 36px row with 4px of air.
 */
export const PHONE_MODE_SWITCH_HEIGHT_PX = 44;

/** A phone on its side: its controls rail down the right edge, 48pt targets in 10pt of padding. */
export const PHONE_RAIL_WIDTH_PX = 60;

/** Phone dock bar: a 48px control row plus the bar's own 8px padding. */
export const PHONE_DOCK_HEIGHT_PX = 64;

/**
 * Desktop top bar: identity on the left, every meeting control on the right, in
 * one full-width 52px band — on a landscape iPad every pixel of it comes off a
 * board page that runs out of height first. It is a solid band rather than a floating capsule,
 * so it reserves exactly its own height — the stage starts at its hairline.
 *
 * The controls used to dock at the bottom of the stage. On a tablet held in
 * landscape that is exactly where the hand holding the device rests, so a thumb
 * landing on the board's lower edge could end the call, and the dock's band
 * came out of the drawing surface. Up here the bottom of the screen carries
 * nothing that can be pressed.
 */
export const DESKTOP_TOP_BAR_HEIGHT_PX = 60;

/**
 * Breathing room between a piece of chrome and the stage content it floats
 * over. Used on both sides of the dock, which is why dock clearance is the
 * dock's own height plus twice this.
 */
export const CHROME_GAP_PX = 8;

/**
 * Vertical space the phone dock occupies above the bottom of the stage,
 * including the gap below it (to the safe-area edge) and above it (to content).
 *
 * Surfaces that render *inside* the stage rather than under the dock — the
 * whiteboard canvas is the notable one — use this to keep their own controls
 * from sliding underneath it.
 */
export const PHONE_DOCK_CLEARANCE_PX =
  PHONE_DOCK_HEIGHT_PX + CHROME_GAP_PX * 2;

/**
 * Header clearance, mirroring {@link PHONE_DOCK_CLEARANCE_PX}: the header is a
 * card floating a gap below the top edge, like the dock a gap above the bottom.
 * The mode switch's row sits inside the same card, after this.
 */
export const PHONE_HEADER_CLEARANCE_PX =
  PHONE_HEADER_HEIGHT_PX + CHROME_GAP_PX * 2;

/**
 * Desktop top-bar clearance. The bar is a solid band with its own hairline, so
 * unlike the floating phone chrome it needs no gap beyond its height.
 * @alias
 */
export const DESKTOP_TOP_BAR_CLEARANCE_PX = DESKTOP_TOP_BAR_HEIGHT_PX;

/**
 * Participant tile in the inline rail above a content surface.
 *
 * Portrait phones used an 84px rail holding an 80px tile plus 8px of padding
 * on each side — 96px of content in an 84px band, so the tiles were clipped
 * top and bottom. Deriving the band from the tile is what stops that
 * arithmetic from being wrong again.
 *
 * The tile is deliberately small: on a phone whiteboard the board is the
 * subject and the rail is peripheral, so it gives back the height rather than
 * competing for it.
 */
export const CONTENT_RAIL_TILE_PX = 52;

/** Padding around the tiles inside the inline rail. */
export const CONTENT_RAIL_PADDING_PX = 6;

/**
 * The strip of faces above a board or a shared screen on a tablet or a
 * desktop, where the page has height to spare: 16:9 tiles with their names,
 * big enough to read a face across a lesson. A board page runs out of width
 * before height there, so the strip costs the page little or nothing.
 */
export const STAGE_STRIP_TILE_PX = 72;
export const STAGE_STRIP_PADDING_PX = 8;

export interface MeetingChromeInput {
  /** True when the phone chrome (slim header, bottom dock) is in use. */
  isPhone: boolean;
  /**
   * False while a bottom sheet owns the screen and the dock is hidden. Only
   * phones have a bottom dock; larger viewports carry their controls in the
   * top bar, so this is ignored for them.
   */
  hasDock: boolean;
  /** False for egress/recorder renders, which carry no header. */
  hasHeader: boolean;
  /** A phone header with its Talk | Board row under it. */
  hasModeSwitch?: boolean;
}

export interface MeetingChromeInsets {
  /** Chrome covering the top of the stage. */
  top: number;
  /** Chrome covering the bottom of the stage. */
  bottom: number;
}

/**
 * Chrome-only insets for a given room configuration. The caller adds the
 * device safe-area on top; see `MeetingShell` in the web app, which does this
 * in CSS so the two compose without a re-render on rotation.
 */
export function selectMeetingChromeInsets(
  input: MeetingChromeInput,
): MeetingChromeInsets {
  const headerHeight = !input.hasHeader
    ? 0
    : input.isPhone
      ? PHONE_HEADER_CLEARANCE_PX + (input.hasModeSwitch ? PHONE_MODE_SWITCH_HEIGHT_PX : 0)
      : DESKTOP_TOP_BAR_CLEARANCE_PX;

  // Only a phone docks controls at the bottom. Everywhere else they share the
  // top bar with the room's identity, and the bottom of the stage is left to
  // the content — and to the hand holding the device.
  const dockHeight = input.isPhone && input.hasDock ? PHONE_DOCK_CLEARANCE_PX : 0;

  return { top: headerHeight, bottom: dockHeight };
}
