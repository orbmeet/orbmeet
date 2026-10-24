export const INLINE_MATH_NODE = "mathInline";

/** Synced authoring source is bounded independently from the parser budget. */
export const MAX_MATH_INPUT_LENGTH = 2_000;

/**
 * AsciiMath expands on the way to LaTeX. The largest reference symbol expansion
 * is just under 10x, so this field accommodates every accepted source without
 * leaving peer-writable renderer input unbounded.
 */
export const MAX_MATH_LATEX_LENGTH = MAX_MATH_INPUT_LENGTH * 10;

/**
 * Structural bounds on rich text, applied wherever a shape carries it.
 *
 * The transport caps (`MAX_CLIENT_FRAME_BYTES`, `MAX_ROOM_WRITE_BYTES`) bound
 * how many bytes a peer can write, and that is enough for width — but not for
 * depth. Ten thousand nested single-child nodes fit comfortably inside one
 * frame, and every consumer that walks rich text recursively overflows its
 * stack on the way back out: tldraw's own `getFontsFromRichText` throws a
 * RangeError, which the accepting side never sees because it validates
 * iteratively. Depth is the bound the byte caps cannot supply.
 */
export const MAX_RICH_TEXT_DEPTH = 100;

/** Backstops behind the byte caps; neither is reachable inside one frame. */
export const MAX_RICH_TEXT_NODES = 200_000;
export const MAX_RICH_TEXT_LENGTH = 500_000;
