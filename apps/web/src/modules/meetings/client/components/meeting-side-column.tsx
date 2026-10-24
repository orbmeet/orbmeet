import * as React from "react";
import { X } from "lucide-react";
import { Tooltip } from "@orbmeet/ui/react";
import { enter } from "@orbmeet/ui/styles/animations";
import { focus, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { border, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { zIndex } from "@orbmeet/ui/tokens/layers.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { stage } from "@orbmeet/ui/tokens/stage.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import type { MeetingSideColumnTab } from "@/modules/meetings/client/room-layout";
import { SpeechSwitch } from "./speech-switch";

const styles = stylex.create({
  /**
   * One column, a card beside the stage, made like the board's card beside
   * it: the same gutter (`space.s3`) from the top bar, the window's edge and
   * its bottom, the same radius and lift, so their edges line up. The stage
   * reserves exactly its width and one gutter (`stage.panel`), so the board
   * and the gallery reflow beside it rather than being covered by it.
   */
  column: {
    position: "absolute",
    top: `calc(${stage.top} + ${space.s3})`,
    right: `calc(${stage.right} + ${space.s3})`,
    bottom: `calc(${stage.bottom} + ${space.s3})`,
    zIndex: zIndex.meetingPanel,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    borderRadius: radii.card,
    backgroundColor: surface.raised,
    boxShadow: shadows.card,
  },
  width: (width: string) => ({ width }),
  /**
   * The same panel under the content on an upright tablet: in the stage's
   * flow rather than over it, the full width less the gutters, about a
   * quarter of the height — a row of faces, not a second stage.
   */
  below: {
    position: "relative",
    top: "auto",
    right: "auto",
    bottom: "auto",
    zIndex: "auto",
    marginInline: space.s3,
    marginBottom: space.s3,
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: "clamp(180px, 24%, 260px)",
  },
  /** The Conversation under the stage: room to read and write, not a row of faces. */
  belowTall: { flexBasis: "clamp(320px, 42%, 520px)" },
  head: {
    display: "flex",
    flexShrink: 0,
    height: 48,
    alignItems: "center",
    gap: space.s1,
    paddingInlineStart: space.s2,
    paddingInlineEnd: space.s1_5,
    boxShadow: `inset 0 -1px 0 ${border.subtle}`,
  },
  title: {
    display: "flex",
    minWidth: 0,
    flexGrow: 1,
    alignItems: "baseline",
    gap: space.s1_5,
    margin: 0,
    paddingInlineStart: space.s1_5,
    fontSize: text.sm,
    fontWeight: weight.bold,
    whiteSpace: "nowrap",
    color: ink.strong,
  },
  count: { fontVariantNumeric: "tabular-nums", fontSize: text.xs, fontWeight: weight.medium, color: neutral.n500 },
  /** The close button's look, shared with the header's other actions. */
  close: {
    display: "grid",
    height: 30,
    width: 30,
    flexShrink: 0,
    placeItems: "center",
    borderWidth: 0,
    borderRadius: radii.field,
    cursor: "pointer",
    color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, ":hover": neutral.n900 } },
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
  },
  body: { position: "relative", display: "flex", minHeight: 0, flexGrow: 1, flexDirection: "column" },
});

export interface MeetingSideColumnTabSpec {
  id: MeetingSideColumnTab;
  label: string;
  /** Shown beside the title: how many people, for instance. */
  count?: number;
}

/**
 * The room's right side, as one object.
 *
 * People and the timeline share one column with one edge, one header and one
 * width — the same for each, so switching never resizes the board beside it.
 * People is the list of who is here; under an upright tablet's board, it is
 * their faces.
 *
 * The header names what is showing; it is not a second set of tabs. Chat and
 * People in the top bar switch between them, with their badges, and the
 * column used to repeat both, so every screen beside a board carried two
 * Chats and two Peoples.
 *
 * Beside content the column also carries the faces, over the panel, and stays
 * with no panel open: the faces then fill it, and Chat and People in the top
 * bar open a panel under them again.
 */
export function MeetingSideColumn({
  width,
  tabs,
  active,
  onClose,
  action,
  speech,
  placement = "side",
  top,
  children,
}: {
  /** A CSS length: the panel width beside the stage. */
  width: string;
  /** Beside the stage, or under the content on an upright tablet. */
  placement?: "side" | "below";
  tabs: MeetingSideColumnTabSpec[];
  /** The tab showing, or null for a column of faces alone (`top`). */
  active: MeetingSideColumnTab | null;
  onClose: () => void;
  /** A control for the tab showing, before the close button — People's invite link. */
  action?: SideColumnActionSpec;
  /** While Chat shows: whether what is said joins it, as a switch in the header. */
  speech?: { shown: boolean; arriving: boolean; onToggle: () => void };
  /** Above the tabs, for what belongs to the column whatever tab shows: the faces. */
  top?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const below = placement === "below";
  const closeLabel = below ? "Close the panel" : "Close the side panel";
  const shown = tabs.find((tab) => tab.id === active);
  return (
    <aside
      aria-label={below ? "Panel" : "Side panel"}
      {...stylex.props(
        styles.column,
        below ? [styles.below, active === "timeline" && styles.belowTall] : [styles.width(width), enter.panel],
      )}
    >
      {top}
      {active && (
        <>
          <div {...stylex.props(styles.head)}>
            <h2 {...stylex.props(styles.title)}>
              {shown?.label}
              {shown?.count !== undefined && <span {...stylex.props(styles.count)}>{shown.count}</span>}
            </h2>
            {active === "timeline" && speech && <SpeechSwitch {...speech} />}
            {action && <SideColumnAction {...action} />}
            <Tooltip content={closeLabel} side={below ? "top" : "left"}>
              <button
                type="button"
                onClick={onClose}
                aria-label={closeLabel}
                {...stylex.props(pressable.base, motion.tint, focus.ring, styles.close)}
              >
                <X size={16} strokeWidth={1.75} />
              </button>
            </Tooltip>
          </div>
          <div role="region" aria-label={shown?.label} {...stylex.props(styles.body)}>
            {children}
          </div>
        </>
      )}
    </aside>
  );
}

export interface SideColumnActionSpec {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
}

/** A control in the column's header, beside its close button: the same size, look and tooltip. */
function SideColumnAction({ icon: Icon, label, onClick }: SideColumnActionSpec) {
  return (
    <Tooltip content={label} side="bottom">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        {...stylex.props(pressable.base, motion.tint, focus.ring, styles.close)}
      >
        <Icon size={16} strokeWidth={1.75} />
      </button>
    </Tooltip>
  );
}
