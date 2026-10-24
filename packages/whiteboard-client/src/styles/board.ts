/**
 * The whiteboard's own style layer.
 *
 * `@orbmeet/ui/styles` covers the app shell; this covers the three treatments
 * that recur across the board's chrome and nowhere else. It is deliberately
 * short — a namespace earns a place here only when more than one component
 * makes the same *decision*, not merely the same declarations. Everything that
 * appears once stays in its component's own `stylex.create`.
 *
 * Two palette notes, both carried over from the app-shell conversion:
 *
 *   - `primary-*` and `neutral-*` were both Tailwind aliases of the same grey
 *     ramp, so every one of them is `neutral.n*` here.
 *   - `indigo-*` and `purple-*` were never declared in `@theme`; they resolved
 *     to stock Tailwind defaults, which is how the navigation-controller pill
 *     ended up a hue the design system does not contain. They map onto the
 *     system's own `accent` and `violet`.
 */
import { accent, border, danger, ink, neutral, surface, violet } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { duration, easing } from "@orbmeet/ui/tokens/motion.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import type { CompiledStyles } from "@stylexjs/stylex";

/**
 * The surface behind every panel a toolbar control opens.
 *
 * Padding is a separate style rather than part of the surface: the insert menu
 * is a list of rows and the "more tools" menu is a grid, and they want
 * different insets around the same panel.
 */
export const boardPanel = stylex.create({
  surface: {
    borderRadius: radii.card,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: `color-mix(in oklab, ${border.base} 80%, transparent)`,
    backgroundColor: surface.raised,
    boxShadow: shadows.popover,
  },
  padSm: { padding: space.s1_5 },
  padMd: { padding: space.s2 },
});

/**
 * Divider rules inside the board's chrome.
 *
 * A 1px element rather than a border because both of these separate siblings
 * in a flex row or a menu, where there is no box to hang a border on.
 */
export const boardDivider = stylex.create({
  /** Between two groups of toolbar buttons. */
  vertical: {
    flexShrink: 0,
    width: 1,
    backgroundColor: `color-mix(in oklab, ${neutral.n200} 60%, transparent)`,
  },
  /** Between two sections of a menu. */
  horizontal: {
    height: 1,
    backgroundColor: neutral.n100,
  },
});

/**
 * The action row at the foot of a board dialog.
 *
 * Every one of these was written out longhand at each of the five call sites,
 * and they had already drifted: two spellings of the same cancel button, and a
 * confirm that was `primary-600` in one dialog and `danger-600` in another for
 * the same destructive act. Named by what the button *does*.
 */
export const boardAction = stylex.create({
  base: {
    // Pills, like every other button in the app: the board's dialogs used to
    // speak a slate, square-cornered dialect of their own.
    borderRadius: radii.pill,
    borderWidth: 0,
    borderStyle: "solid",
    paddingInline: space.s4,
    paddingBlock: space.s2,
    fontFamily: "inherit",
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    opacity: { default: 1, ":disabled": 0.4 },
    transitionProperty: "color, background-color, border-color",
    transitionDuration: { default: duration.instant, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
  /** The default: an outlined button that does not commit anything. */
  outline: {
    borderWidth: 1,
    borderColor: neutral.n300,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n50 } },
    color: neutral.n700,
  },
  /** Dismissal. No border, so it sits behind the other two. */
  ghost: {
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
    color: neutral.n600,
  },
  /** The confirming action of a destructive dialog. */
  danger: {
    backgroundColor: { default: danger.d600, [env.hoverable]: { default: danger.d600, ":hover": danger.d700 } },
    color: ink.onDark,
  },
  /** The confirming action of an ordinary one. */
  confirm: {
    backgroundColor: { default: accent.a600, [env.hoverable]: { default: accent.a600, ":hover": accent.a700 } },
    color: ink.onAccent,
  },
  /** Recognition and other AI-side confirmations. */
  ai: {
    backgroundColor: { default: violet.v600, [env.hoverable]: { default: violet.v600, ":hover": violet.v500 } },
    color: ink.onDark,
  },
  /** Tighter, for a row that has four buttons in it. */
  tight: { paddingInline: space.s3 },
  /** Pushed to the far end of the row, away from the confirm/cancel pair. */
  leading: { marginRight: "auto" },
});

/** The row those buttons sit in. */
export const boardActionRow = stylex.create({
  base: {
    marginTop: space.s4,
    display: "flex",
    justifyContent: "flex-end",
    gap: space.s2,
  },
  wrap: { flexWrap: "wrap" },
  split: { justifyContent: "space-between" },
  /** Ruled off from the dialog body above it. */
  ruled: {
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: border.base,
    paddingTop: space.s4,
  },
});

/**
 * The round trigger buttons of the board's toolbar.
 *
 * One geometry for every tool, panel toggle and menu toggle in the strip,
 * and the same one the meeting's top bar uses directly above it: a rounded
 * square, a soft accent tint for what is on, a bare icon for everything else.
 * The current tool used to be a filled navy disc scaled up 10% with a drop
 * shadow — the loudest object on screen, louder than the ink on the page —
 * and the bar above spoke a different visual language for the same idea.
 * Panel toggles follow the *tool* rule — Style, Background — because they
 * read as tools, not as menus.
 */
export const boardTrigger = stylex.create({
  base: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    borderWidth: 0,
    borderRadius: radii.control,
    padding: 0,
    cursor: "pointer",
    transitionProperty: "transform, background-color, color, box-shadow",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
  compact: { height: 44, width: 44 },
  regular: { height: 36, width: 36 },
  /**
   * The current tool, or an open panel that reads as one: a solid accent
   * fill. With a pencil in hand you check the tool at a glance from arm's
   * length, and a pale tint on a white palette was the one state that took a
   * second look.
   */
  active: {
    backgroundColor: accent.a600,
    color: ink.onAccent,
    boxShadow: `inset 0 1px 0 color-mix(in oklab, ${ink.onAccent} 18%, transparent), 0 1px 2px color-mix(in oklab, ${accent.a700} 35%, transparent)`,
  },
  /** An open menu: pressed in, not filled. */
  open: {
    backgroundColor: neutral.n100,
    color: neutral.n900,
    boxShadow: `inset 0 2px 4px color-mix(in oklab, ${ink.strong} 5%, transparent)`,
  },
  idle: {
    color: neutral.n600,
    backgroundColor: {
      default: "transparent",
      [env.hoverable]: { default: "transparent", ":hover": neutral.n100 },
      ":active": neutral.n200,
    },
  },
});

/**
 * The ruled label strip at the top of a board panel.
 *
 * The strip and its title are shared; the inset is not, because each panel's
 * body padding is its own decision. (The two panels that have this header had
 * already drifted to two insets — that drift now has to be chosen on purpose.)
 */
export const boardPanelHeader = stylex.create({
  strip: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: neutral.n100,
  },
  title: {
    fontSize: text.xs,
    lineHeight: leading.xs,
    fontWeight: weight.semibold,
    color: neutral.n700,
  },
});

/**
 * Merge StyleX styles with an integration class.
 *
 * Tldraw selects its frame classes internally, while `whiteboard-document` is
 * the stable hook the tiny adapter stylesheet uses to reach tldraw-owned
 * descendants. Everything we own on those elements is still StyleX; this
 * helper lets the external hook and generated classes share one `className`.
 */
export function withBoardClass(
  cssClass: string,
  // `CompiledStyles` rather than `StyleXStyles`: this only ever forwards to
  // `stylex.props`, and `StyleXStyles` rejects entries whose values came from
  // `defineConsts` (a `zIndex` const types as a class name, not a CSS value),
  // which the board's layer tokens are.
  ...styles: readonly CompiledStyles[]
): { className: string; style?: Readonly<Record<string, string | number>> } {
  const props = stylex.props(...styles);
  return {
    ...props,
    className: props.className ? `${cssClass} ${props.className}` : cssClass,
  };
}
