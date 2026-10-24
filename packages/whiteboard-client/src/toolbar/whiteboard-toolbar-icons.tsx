import {
  Circle,
  Diamond,
  Eraser,
  Highlighter,
  MousePointer2,
  MoveUpRight,
  Pencil,
  Square,
  SquareDashedMousePointer,
  Table2,
  Type,
} from "lucide-react";
import type { TLGeoShapeGeoStyle } from "tldraw";
import { ink } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({
  /**
   * The colour a new stroke will take, as the control itself: a disc ringed
   * in the toolbar's own ground and then a hairline, so white and pale yellow
   * still read as a colour rather than as a hole.
   */
  swatch: (color: string) => ({
    width: 18,
    height: 18,
    borderRadius: radii.pill,
    backgroundColor: color,
    boxShadow: `0 0 0 2px ${ink.onDark}, 0 0 0 3px color-mix(in oklab, ${ink.strong} 22%, transparent)`,
  }),
});

/**
 * The toolbar is one icon system: a single grid, a single weight. Lucide draws
 * on a 24px box, so bespoke marks below use the same viewBox and stroke so they
 * sit on the same optical baseline as the imported ones.
 */
export const TOOL_ICON_SIZE = 18;
export const TOOL_ICON_STROKE = 1.75;

const iconProps = {
  size: TOOL_ICON_SIZE,
  strokeWidth: TOOL_ICON_STROKE,
} as const;

/** Shared frame for the marks lucide has no equivalent for. */
function BespokeIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width={TOOL_ICON_SIZE}
      height={TOOL_ICON_SIZE}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={TOOL_ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/**
 * Lucide has no laser pointer, and the obvious mark — a dot on a diagonal beam —
 * is indistinguishable from the arrow tool sitting right next to it. So draw what
 * the laser does rather than what the device looks like: a bright head with a
 * trail fading out behind it, which is exactly how it behaves on the canvas.
 */
function LaserIcon() {
  return (
    <BespokeIcon>
      <circle cx="6.5" cy="17.5" r="3.4" fill="currentColor" stroke="none" />
      <circle cx="13" cy="11" r="2" fill="currentColor" stroke="none" opacity="0.55" />
      <circle cx="17.8" cy="6.2" r="1.2" fill="currentColor" stroke="none" opacity="0.3" />
      <circle cx="21" cy="3" r="0.7" fill="currentColor" stroke="none" opacity="0.18" />
    </BespokeIcon>
  );
}

/**
 * Lucide's `</>` says "code" but not "this runs", and the run is the point:
 * people skimmed past it as a formatting option. So keep the opening bracket
 * and replace the rest with a play mark, the one symbol everyone reads as run.
 */
function CodeRunIcon() {
  return (
    <BespokeIcon>
      <path d="M8 6 2.5 12 8 18" />
      <path d="M12.5 6.5v11l8.5-5.5z" fill="currentColor" />
    </BespokeIcon>
  );
}

export function GeoToolIcon({ geoType }: { geoType: TLGeoShapeGeoStyle }) {
  switch (geoType) {
    case "rectangle":
      return <Square {...iconProps} />;
    case "ellipse":
      return <Circle {...iconProps} />;
    case "diamond":
      return <Diamond {...iconProps} />;
    default:
      return null;
  }
}

/**
 * The style panel's trigger is the current colour itself. It used to be a
 * palette glyph with an 8px dot in its corner, which read as a stray mark
 * rather than as the colour you were about to draw in.
 */
export function StyleToolIcon({ color }: { color: string }) {
  return <span aria-hidden="true" {...stylex.props(styles.swatch(color))} />;
}

export function ToolIcon({ toolId }: { toolId: string }) {
  switch (toolId) {
    case "select":
      return <MousePointer2 {...iconProps} />;
    case "draw":
      return <Pencil {...iconProps} />;
    case "highlight":
      return <Highlighter {...iconProps} />;
    case "eraser":
    case "stroke-eraser":
      return <Eraser {...iconProps} />;
    case "text":
      return <Type {...iconProps} />;
    // Diagonal, not the horizontal chevron-arrow: this draws an arrow, it does
    // not mean "next".
    case "arrow":
      return <MoveUpRight {...iconProps} />;
    case "laser":
      return <LaserIcon />;
    // A dashed box with an X in it reads as "delete". This is a region select.
    case "screenshot":
      return <SquareDashedMousePointer {...iconProps} />;
    case "table":
      return <Table2 {...iconProps} />;
    case "code":
      return <CodeRunIcon />;
    default:
      return null;
  }
}
