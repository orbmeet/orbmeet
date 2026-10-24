/**
 * Picks the meeting layout from device + room state. Pure and tiny so the
 * decision lives in one place instead of being scattered across nested JSX
 * conditionals — every layout branch in the room derives from this.
 *
 *   solo          — you're alone.
 *   gallery        — small meeting, equal tiles, active speaker glows.
 *   spotlight      — large meeting: active-speaker stage + windowed rail.
 *   content-stage  — screen share or whiteboard owns the stage; people become
 *                    the rail.
 */
export type Composition =
  | "solo"
  | "gallery"
  | "spotlight"
  | "content-stage";

export interface CompositionInput {
  /** Total participants including the local user. */
  participantCount: number;
  /** A screen share or whiteboard is occupying the stage. */
  hasContent: boolean;
  isPhone: boolean;
  isLandscape: boolean;
}

/** Above this many people we stop showing equal tiles and spotlight instead. */
export const GALLERY_MAX_DESKTOP = 6;
/** The same, on a phone. */
const PHONE_GALLERY_MAX = 3;

export function selectComposition(input: CompositionInput): Composition {
  if (input.hasContent) return "content-stage";
  if (input.participantCount <= 1) return "solo";

  // A phone shows up to three people as a gallery — two as a face and your own
  // picture in its corner, three as one wide tile over two — and four or more
  // as whoever is speaking, large, over a strip of the rest. A grid of four
  // made every face a thumbnail, and on its side ran off the bottom of the
  // screen; a spotlight of three left two of them as thumbnails beside an
  // empty strip.
  if (input.isPhone) return input.participantCount <= PHONE_GALLERY_MAX ? "gallery" : "spotlight";

  const galleryMax = GALLERY_MAX_DESKTOP;
  if (input.participantCount <= galleryMax) return "gallery";

  return "spotlight";
}
