import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Toolbar } from "@base-ui/react/toolbar";
import { layout, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { accent, danger, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, leading, text, tracking, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import { PopoverContent, PopoverRoot, PopoverTrigger, Tooltip } from "@orbmeet/ui/react";
import { eqByIndex } from "@orbmeet/ui/styles/animations";
import { countBadge } from "@/modules/meetings/client/meeting-styles";

/**
 * The pieces every control in the room's top strip is built from.
 *
 * The strip holds two kinds of control — yours (mic, camera, hand) and the
 * room's (view, share, timeline, leave) — and they have to read as one set.
 * They share a slot size, a state vocabulary and a menu chrome by importing
 * them from here rather than each carrying a copy.
 */
const dockItem = stylex.create({
  /**
   * Every control in the bar is the same 34px slot inside a 48px bar — and
   * 40px where a finger, not a cursor, does the pointing: as big as the bar
   * leaves room for while keeping a hairline of air around a lit control.
   *
   * Focus is a ring-shaped shadow rather than the app's usual offset outline:
   * the slot is flush inside the bar, and an offset ring would sit under its
   * neighbour.
   */
  base: {
    position: "relative",
    display: "flex",
    height: { default: 36, [env.touch]: 40 },
    minWidth: 36,
    alignItems: "center",
    justifyContent: "center",
    gap: space.s2,
    borderRadius: radii.pill,
    paddingInline: space.s2_5,
    // A control's resting ground is stated, never left unset: composing a
    // hover style whose `default` is `null` *removes* an inherited
    // `background-color`, and what shows through a `<button>` then is the
    // user agent's ButtonFace grey. Every background below names its resting
    // value.
    backgroundColor: "transparent",
    // The strip sets its own type scale; inheriting the page's 16px body size
    // would render labels a third larger than the controls beside them.
    fontFamily: "inherit",
    fontSize: text.control,
    lineHeight: leading.control,
    fontWeight: weight.medium,
    letterSpacing: tracking.normal,
    color: neutral.n600,
    outlineStyle: "none",
    boxShadow: { default: "none", ":focus-visible": `0 0 0 2px color-mix(in oklab, ${accent.a500} 30%, transparent)` },
  },
  /** A press that pushes in. Gated in JS, not by `:not(:disabled)` — see below. */
  press: { transform: { default: "none", ":active": "scale(0.96)" } },
  /** The resting control lights up under the cursor. */
  idleHover: {
    backgroundColor: {
      default: "transparent",
      [env.hoverable]: { default: "transparent", ":hover": neutral.n100 },
    },
    color: { default: neutral.n600, [env.hoverable]: { default: neutral.n600, ":hover": neutral.n900 } },
  },
  /** `active` is the accent — the one thing you have turned on. */
  active: { backgroundColor: accent.a50, color: accent.a700 },
  /**
   * `off` is a red *tint*, never a filled red block: filled red belongs to
   * leaving alone, so "my mic is off" can't be mistaken at a glance for "end
   * the meeting".
   */
  off: { backgroundColor: danger.d50, color: danger.d600 },
  offHover: {
    backgroundColor: { default: danger.d50, [env.hoverable]: { default: danger.d50, ":hover": danger.d100 } },
  },
  /**
   * Pointer feedback is gated here rather than in a selector: Base UI keeps a
   * disabled Toolbar.Button hoverable on purpose (see `DockButton`) — it renders
   * `aria-disabled` and no native `disabled` attribute, so `:hover` and
   * `:active` still fire and `:not(:disabled)` never matches. Without this gate
   * a greyed-out control lit up under the cursor like a live one.
   */
  disabled: { cursor: "not-allowed", opacity: 0.4 },
});

/**
 * The states a strip control can be in, as styles.
 *
 * Two states carry color and nothing else does. Colour says what the control
 * *is*, independent of whether it can be used: a muted mic that is temporarily
 * unavailable still has to read as muted. Pointer feedback says whether it can
 * be *pressed*, and is composed separately.
 */
export function dockItemStyles({
  active = false,
  off = false,
  disabled = false,
}: {
  active?: boolean;
  off?: boolean;
  disabled?: boolean;
}): StyleXStyles[] {
  return [
    dockItem.base,
    motion.tint,
    off ? dockItem.off : active ? dockItem.active : null,
    !disabled && (off ? dockItem.offHover : active ? null : dockItem.idleHover),
    disabled ? dockItem.disabled : dockItem.press,
  ];
}

/**
 * Compose the accessible name for a strip control.
 *
 * WCAG 2.5.3 (Label in Name): a control's accessible name has to contain the
 * text a sighted user can read on it, or someone driving the app by voice
 * cannot activate what they are looking at. Controls are labelled as things
 * ("Share") and their tooltips phrased as actions ("Present your screen"), and
 * letting the tooltip simply *replace* the label broke that pairing.
 *
 * Icon-only controls have no visible text, so there the tooltip alone is both
 * the best name and a compliant one.
 */
export function dockAccessibleName(visibleText: string | null, description: string) {
  if (!visibleText) return description;
  if (description.toLowerCase().includes(visibleText.toLowerCase())) return description;
  return `${visibleText}. ${description}`;
}

export const dockStyles = stylex.create({
  /**
   * A group of controls that belong together — yours, the room's — as one
   * white pill floating on the page, the way the stage switch is one capsule.
   */
  cluster: {
    display: "flex",
    alignItems: "center",
    gap: 2,
    borderRadius: radii.pill,
    padding: 3,
    backgroundColor: surface.raised,
    boxShadow: `0 0 0 1px ${neutral.n150}, ${shadows.lift1}`,
  },
  /** The icon's box, which an unread badge is pinned to. */
  icon: { position: "relative", display: "inline-flex", flexShrink: 0 },
  /**
   * Labels appear only where the strip has room; the tooltip always carries
   * them. From a landscape iPad up: measured, Chat's, People's and Unmute's
   * words cost the bar about 86px, and at 1024px the meeting's name still has
   * about 250px. A tablet showed bare icons, and touch has no tooltip.
   */
  label: {
    display: { default: "none", [bp.lg]: "inline" },
    maxWidth: 96,
  },
  /**
   * The words for your own controls — Mute, video, hand, More — need a wider
   * bar than Chat's and People's, so they appear from a laptop up, where the
   * meeting's name still keeps its room. Below that the tooltip carries them.
   */
  labelWide: {
    display: { default: "none", [bp.xl]: "inline" },
    maxWidth: 96,
  },
  /** The rule between groups. */
  /**
   * A split control: an action and the chevron that opens its settings, as
   * one silhouette. The action keeps the outer radius on its leading edge,
   * the chevron on its trailing edge, and the seam between them is square.
   */
  split: { display: "flex", alignItems: "center", gap: 1 },
  splitStart: { borderEndEndRadius: 4, borderStartEndRadius: 4 },
  splitChevron: {
    display: "flex",
    height: { default: 34, [env.touch]: 40 },
    // 24, not 22: the trailing half of a split control still has to clear the
    // WCAG 2.2 minimum target size on its own.
    width: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.pill,
    borderStartStartRadius: 4,
    borderEndStartRadius: 4,
    color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, ":hover": neutral.n900 } },
    backgroundColor: {
      default: "transparent",
      [env.hoverable]: { default: "transparent", ":hover": neutral.n100 },
      ":is([data-popup-open])": neutral.n100,
    },
  },
  /** While its action is off the chevron sits on the same tint, so the pair reads as one. */
  splitChevronOff: {
    color: { default: danger.d500, [env.hoverable]: { default: danger.d500, ":hover": danger.d700 } },
    backgroundColor: {
      default: danger.d50,
      [env.hoverable]: { default: danger.d50, ":hover": danger.d100 },
      ":is([data-popup-open])": danger.d100,
    },
  },
  /** The shared chrome of the strip's popovers. */
  menuPanel: {
    width: 288,
    borderRadius: radii.card,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n150,
    backgroundColor: surface.raised,
    padding: space.s2,
    boxShadow: shadows.lift3,
  },
  menuHeading: {
    marginBlock: 0,
    paddingInline: space.s2_5,
    paddingTop: space.s1,
    paddingBottom: space.s1_5,
    fontSize: text.xs2,
    fontWeight: weight.semibold,
    letterSpacing: tracking.wider,
    textTransform: "uppercase",
    color: neutral.n400,
  },
  menuRule: { height: 1, marginBlock: space.s1_5, marginInline: space.s2, backgroundColor: neutral.n150 },
  menuRow: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: space.s2_5,
    borderRadius: radii.control,
    paddingInline: space.s2_5,
    paddingBlock: space.s2,
    textAlign: "start",
    fontFamily: "inherit",
    fontSize: text.xs,
    fontWeight: weight.medium,
    color: neutral.n700,
    backgroundColor: {
      default: "transparent",
      [env.hoverable]: { default: "transparent", ":hover:not(:disabled)": neutral.n50 },
    },
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    opacity: { default: 1, ":disabled": 0.4 },
  },
  menuRowDanger: {
    color: danger.d600,
    backgroundColor: {
      default: "transparent",
      [env.hoverable]: { default: "transparent", ":hover:not(:disabled)": danger.d50 },
    },
  },
  /**
   * A number that is the control's whole message — how many people are here —
   * so unlike a label it shows at every width, set as a figure.
   */
  count: { fontFamily: fonts.mono, fontSize: text.xs },
  /** Three bars beside a control's icon while a voice is coming through it. */
  wave: { display: "flex", height: 14, alignItems: "center", gap: 1.5, overflow: "hidden" },
  waveBar: { width: 2, borderRadius: radii.pill, backgroundColor: "currentColor" },
  menuRowIcon: { flexShrink: 0, color: neutral.n400 },
  menuRowIconDanger: { color: danger.d500 },
  /** The label always survives; a hint wraps under it rather than being cut off. */
  menuRowText: { display: "flex", minWidth: 0, flexGrow: 1, flexDirection: "column", gap: 1 },
  menuRowHint: {
    fontSize: text.xs2,
    lineHeight: leading.xs,
    fontWeight: weight.normal,
    color: neutral.n400,
  },
});

export function DockLabel({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return <span {...stylex.props(wide ? dockStyles.labelWide : dockStyles.label, layout.truncate)}>{children}</span>;
}

export interface DockButtonProps {
  icon: React.ElementType;
  label: string;
  /**
   * Renders the label beside the icon: `true` from a tablet up, `"wide"` from
   * a laptop up, for controls that are labelled only where the bar has room.
   */
  showLabel?: boolean | "wide";
  active?: boolean;
  off?: boolean;
  badge?: number;
  /** A count shown beside the icon at every width, e.g. the people in the room. */
  count?: number;
  /** Shown after the icon and any count: a live state the icon cannot carry. */
  trailing?: React.ReactNode;
  disabled?: boolean;
  tooltip?: string;
  /** Only for a control that is half of a split silhouette — see `dockStyles.splitStart`. */
  sx?: StyleXStyles;
  onClick: () => void;
}

export function DockButton({
  icon: Icon,
  label,
  showLabel = false,
  active = false,
  off = false,
  badge,
  count,
  trailing,
  disabled = false,
  tooltip,
  sx,
  onClick,
}: DockButtonProps) {
  const description = tooltip ?? label;
  const visibleText = count !== undefined ? String(count) : showLabel ? label : null;
  return (
    <Tooltip content={description} side="bottom">
      {/* Toolbar.Button, not a native disabled <button>: a disabled control that
          drops out of the tab order and stops emitting pointer events also
          silences the tooltip explaining why it is disabled. Base UI keeps it
          hoverable and focusable under `aria-disabled` and swallows the click. */}
      <Toolbar.Button
        onClick={onClick}
        disabled={disabled}
        aria-label={dockAccessibleName(visibleText, description)}
        aria-pressed={active ? true : undefined}
        {...stylex.props(pressable.base, ...dockItemStyles({ active, off, disabled }), sx)}
      >
        {/* The badge rides on the icon, not the button's corner: with the
            label showing, the corner is over the label's last letter. */}
        <span {...stylex.props(dockStyles.icon)}>
          <Icon size={20} strokeWidth={active || off ? 2 : 1.75} />
          {badge !== undefined && badge > 0 && (
            <span {...stylex.props(countBadge.base, countBadge.docked)}>
              {badge > 99 ? "99+" : badge}
            </span>
          )}
        </span>
        {showLabel && <DockLabel wide={showLabel === "wide"}>{label}</DockLabel>}
        {count !== undefined && <span {...stylex.props(dockStyles.count)}>{count}</span>}
        {trailing}
      </Toolbar.Button>
    </Tooltip>
  );
}

/** Words are arriving: three bars, moving as a voice does. Still under reduced motion. */
export function SpeechWave() {
  return (
    <span aria-hidden="true" {...stylex.props(dockStyles.wave)}>
      {eqByIndex.slice(0, 3).map((bar, index) => (
        <span key={index} {...stylex.props(dockStyles.waveBar, bar)} />
      ))}
    </span>
  );
}

/**
 * The trailing chevron of a split control, and the settings it opens.
 *
 * `children` receives whether the popover is open (so a live preview such as
 * a mic level runs only while it is on screen) and a `close` callback.
 */
export function DockSplitMenu({
  label,
  off = false,
  panelSx,
  onOpenChange,
  children,
}: {
  label: string;
  off?: boolean;
  panelSx?: StyleXStyles;
  /** For a menu with a view of its own to reset when it closes. */
  onOpenChange?: (open: boolean) => void;
  children: (state: { open: boolean; close: () => void }) => React.ReactNode;
}) {
  const [open, setOpenState] = React.useState(false);
  const setOpen = React.useCallback(
    (next: boolean) => {
      setOpenState(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const close = React.useCallback(() => setOpen(false), [setOpen]);
  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <Toolbar.Button
        render={<PopoverTrigger />}
        aria-label={label}
        {...stylex.props(
          pressable.base,
          motion.tint,
          dockStyles.splitChevron,
          off && dockStyles.splitChevronOff,
        )}
      >
        <ChevronDown size={14} />
      </Toolbar.Button>
      <PopoverContent
        title={label}
        side="bottom"
        align="start"
        sx={[dockStyles.menuPanel, panelSx]}
      >
        {children({ open, close })}
      </PopoverContent>
    </PopoverRoot>
  );
}

/**
 * One row of a strip menu. The hint is a second line, never a truncated tail:
 * a disabled row's hint is the only place that says *why*.
 */
export function DockMenuRow({
  icon: Icon,
  label,
  hint,
  danger: isDanger = false,
  disabled = false,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      {...stylex.props(pressable.base, motion.tint, dockStyles.menuRow, isDanger && dockStyles.menuRowDanger)}
    >
      <Icon
        size={16}
        strokeWidth={1.75}
        {...stylex.props(dockStyles.menuRowIcon, isDanger && dockStyles.menuRowIconDanger)}
      />
      <span {...stylex.props(dockStyles.menuRowText)}>
        <span>{label}</span>
        {hint && <span {...stylex.props(dockStyles.menuRowHint)}>{hint}</span>}
      </span>
    </button>
  );
}
