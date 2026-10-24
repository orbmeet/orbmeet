import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  FilePlus,
  Pencil,
  Plus,
  Radio,
  Sparkles,
  Tags,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { accent, border, danger, ink, neutral, surface, violet } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { duration, easing } from "@orbmeet/ui/tokens/motion.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { boardDivider, boardPanel } from "../styles/board";
import type { WhiteboardPage } from "../pages/page-manager";
import { controlsPlacement, type WhiteboardChromeConfig } from "../chrome/whiteboard-chrome";
import type { WhiteboardFollowState } from "./whiteboard-follow";
import { handOffBoard, type HandoffTarget } from "./whiteboard-handoff";
import { emitWhiteboardError } from "../chrome/whiteboard-error-event";

const styles = stylex.create({
  viewport: {
    position: "absolute",
    left: "50%",
    bottom: "var(--viewport-bottom, 1.5rem)",
    zIndex: 200,
    display: "flex",
    maxWidth: "calc(100% - 2rem)",
    transform: "translateX(-50%)",
    flexDirection: "column",
    alignItems: "center",
    pointerEvents: "auto",
    // Controls, not text: a quick second tap on zoom selected the page label,
    // the zoom and the chips around it.
    userSelect: "none",
  },
  viewportBottomCompact: { "--viewport-bottom": "0.75rem" },
  /**
   * The regular board's controls: one corner at the top of the board, over
   * the palette — pages, then zoom — with whom you are following just under
   * them.
   *
   * They used to stand under the page, along the bottom edge: where the hand
   * holding a pencil rests on an iPad, so a palm turned pages. The top-left
   * corner is the one no writing hand covers, and it leaves the board's
   * other top corner to its host (a meeting's faces).
   */
  viewportBand: {
    // 8px in, over the palette: the band they stand in is
    // `WHITEBOARD_CONTROLS_BAND_PX`.
    left: "calc(var(--wb-page-rail-band, 0px) + 8px)",
    top: 8,
    bottom: "auto",
    maxWidth: "calc(100% - 16px)",
    // The status (presenting, following) beside the page controls, in the one
    // band the camera keeps clear, rather than a second row under them that
    // stood on the page's top-left corner. A board too narrow for both on one
    // line wraps, and the band is measured so the camera clears both rows.
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s2,
    transform: "none",
    pointerEvents: "none",
  },
  /** One end of the band, or the status between them: the parts that take a pointer. */
  bandPart: { display: "flex", alignItems: "center", gap: space.s2, minWidth: 0, pointerEvents: "auto" },
  /** The page control: which page, and the way to every other one. */
  pages: {
    display: "flex",
    height: 30,
    alignItems: "center",
    gap: space.s1_5,
    borderRadius: radii.control,
    borderWidth: 0,
    paddingInline: space.s2_5,
    fontFamily: "inherit",
    fontSize: text.control,
    lineHeight: leading.control,
    fontWeight: weight.medium,
    fontVariantNumeric: "tabular-nums",
    cursor: "pointer",
    transitionProperty: "background-color, color",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
  pagesIdle: {
    color: neutral.n700,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
  },
  pagesOpen: { color: accent.a700, backgroundColor: accent.a50 },
  pageTotal: { color: neutral.n500, fontWeight: weight.medium },
  /** The AI's own violet, as everywhere the assistant appears. */
  ai: {
    display: "flex",
    height: 30,
    alignItems: "center",
    gap: space.s1_5,
    borderRadius: radii.control,
    borderWidth: 0,
    paddingInline: space.s2_5,
    fontFamily: "inherit",
    fontSize: text.control,
    lineHeight: leading.control,
    fontWeight: weight.medium,
    color: violet.v600,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": violet.v50 } },
    cursor: "pointer",
  },
  aiOpen: { backgroundColor: violet.v100, color: violet.v700 },
  /**
   * An upright phone stacks the follow pill over the pager; on its side it has
   * the width to set them side by side, which halves how much page they cover.
   */
  viewportCompact: {
    bottom: "var(--viewport-bottom, calc(env(safe-area-inset-bottom, 0px) + 0.75rem))",
    flexDirection: { default: "column", [bp.md]: "row" },
    gap: { default: 0, [bp.md]: space.s2 },
  },
  viewportLandscape: {
    right: space.s2,
    bottom: space.s2,
    left: "auto",
    transform: "none",
  },
  /**
   * The control capsules. The `indigo-*` these used was never in the theme —
   * the navigation pill is the very case `board.ts`'s header notes — so every
   * one of them is the accent now.
   */
  bandCapsule: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: 2,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: border.subtle,
    backgroundColor: surface.raised,
    padding: space.s1,
    // Flat: a hairline on the board, not a popover lifted off it, whose 40px
    // shadow hazed the page under the whole capsule.
    boxShadow: shadows.hairline,
  },
  /** A regular board's capsule: 36px, a control's radius rather than a pill's. */
  bandCapsuleRegular: { height: 36, boxSizing: "border-box", borderRadius: radii.field, paddingBlock: 0, paddingInline: 2 },

  /** The zoom readout: "Fit", or a percentage of the fitted page. */
  fit: {
    borderRadius: radii.pill,
    borderWidth: 0,
    padding: 0,
    fontFamily: "inherit",
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    fontVariantNumeric: "tabular-nums",
    cursor: "pointer",
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
    transitionProperty: "background-color, color",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
  fitBand: { height: 30, minWidth: "3rem", paddingInline: space.s2, borderRadius: radii.control },
  /** Fitted — `primary-700`, which always aliased this grey. */
  fitFitted: { color: neutral.n700 },
  fitZoomed: { color: neutral.n600 },

  /** "Hand off": labeled, because it hands a participant the wheel. */
  handoff: {
    display: "flex",
    alignItems: "center",
    whiteSpace: "nowrap",
    borderRadius: radii.pill,
    borderWidth: 0,
    fontFamily: "inherit",
    fontWeight: weight.medium,
    color: { default: neutral.n600, [env.hoverable]: { default: neutral.n600, ":hover": neutral.n900 } },
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
    cursor: "pointer",
    transitionProperty: "background-color, color",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
  handoffBand: { height: 30, gap: space.s1_5, paddingInline: space.s2_5, borderRadius: radii.control, fontSize: text.control, lineHeight: leading.control },
  /**
   * In the phone's capsule: a full touch target, and the glyph alone on a
   * narrow screen — with the word, the capsule ran ~34px wider than an upright
   * phone and both its ends were clipped. The label still names it.
   */
  handoffCompact: {
    height: 44,
    minWidth: 44,
    justifyContent: "center",
    paddingInline: { default: 0, [bp.sm]: space.s2_5 },
  },
  handoffWordCompact: { display: { default: "none", [bp.sm]: "inline" } },

  /** The scrim behind an open menu. Legacy numeric z: below the board's own
      chrome on purpose, so the toolbar strip stays above. */
  menuScrim: { position: "fixed", inset: 0, zIndex: 40, cursor: "default" },
  handoffMenu: {
    position: "absolute",
    bottom: "100%",
    zIndex: 50,
    marginBottom: space.s2,
    minWidth: "11rem",
    overflow: "hidden",
  },
  handoffMenuBand: { right: 0 },
  /** Under a name in the hand-off menu: what else handing them the board does. */
  handoffItemNote: { display: "block", fontSize: text.xs, lineHeight: leading.xs, color: neutral.n600 },
  /** The handoff sits in the top band's leading capsule, so its menu opens down from that edge. */
  handoffMenuStart: { left: 0, right: "auto", top: "100%", bottom: "auto", marginTop: space.s2, marginBottom: 0 },
  handoffItem: {
    display: "block",
    width: "100%",
    borderRadius: radii.control,
    borderWidth: 0,
    paddingInline: space.s3,
    paddingBlock: space.s2,
    fontFamily: "inherit",
    fontSize: text.sm,
    lineHeight: leading.sm,
    textAlign: "left",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    cursor: "pointer",
    color: { default: neutral.n700, [env.hoverable]: { default: neutral.n700, ":hover": accent.a700 } },
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": accent.a50 } },
  },

  /** Who is driving the pages, when it is not you. */
  navStatus: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: `color-mix(in oklab, ${accent.a500} 50%, transparent)`,
    backgroundColor: `color-mix(in oklab, ${accent.a600} 90%, transparent)`,
    paddingInline: space.s3,
    paddingBlock: space.s1_5,
    fontSize: text.control,
    lineHeight: leading.control,
    fontWeight: weight.medium,
    color: ink.onDark,
    boxShadow: shadows.hairline,
    backdropFilter: { default: "blur(16px)", [env.cheapPaint]: "blur(6px)" },
  },
  navStatusBand: { marginBottom: { default: space.s2, [bp.md]: 0 }, maxWidth: "min(22rem, calc(100vw - 2rem))", alignSelf: "center" },
  /**
   * Following the presenter. Quiet while it is happening — it is the room's
   * normal state, and a class of thirty does not need it shouted at them —
   * and an accent call to action once you have stepped away, because that is
   * when you need to find your way back.
   */
  follow: {
    display: "flex",
    height: 36,
    boxSizing: "border-box",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s1_5,
    borderRadius: radii.field,
    paddingInlineStart: space.s2_5,
    paddingInlineEnd: space.s1,
    fontSize: text.control,
    lineHeight: leading.control,
    fontWeight: weight.medium,
    whiteSpace: "nowrap",
  },
  followQuiet: {
    color: neutral.n600,
    backgroundColor: surface.raised,
    boxShadow: `inset 0 0 0 1px ${border.subtle}, ${shadows.hairline}`,
  },
  followIcon: { flexShrink: 0, color: accent.a600 },
  editRequestWaiting: { paddingInlineEnd: space.s2_5 },
  followStop: {
    height: 28,
    borderRadius: radii.field,
    borderWidth: 0,
    paddingInline: space.s2,
    fontFamily: "inherit",
    fontSize: text.control,
    fontWeight: weight.medium,
    color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, ":hover": neutral.n900 } },
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
    cursor: "pointer",
  },
  /** On a phone: a cross, a thumb's width. */
  followStopIcon: { display: "grid", width: 32, height: 32, placeItems: "center", paddingInline: 0 },
  followAgain: {
    borderWidth: 0,
    paddingInlineEnd: space.s3,
    fontFamily: "inherit",
    fontWeight: weight.medium,
    color: ink.onDark,
    backgroundColor: { default: accent.a600, [env.hoverable]: { default: accent.a600, ":hover": accent.a700 } },
    boxShadow: shadows.hairline,
    cursor: "pointer",
  },
  /** Following and asking to edit, side by side: one row, never one over the other. */
  statusRow: { display: "flex", alignItems: "center", gap: space.s2, minWidth: 0 },
  statusRowCompact: { marginBottom: { default: space.s2, [bp.md]: 0 }, alignSelf: "center", maxWidth: "100%" },
  /**
   * A reader's way to ask for the pen: filled in the accent, the one action
   * on a board they can only watch. Pale, it sat beside the follow pill as one
   * more status, and readers looked past it.
   */
  editRequest: {
    paddingInlineEnd: space.s2_5,
    borderWidth: 0,
    fontFamily: "inherit",
    fontWeight: weight.semibold,
    color: ink.onDark,
    backgroundColor: { default: accent.a600, [env.hoverable]: { default: accent.a600, ":hover": accent.a700 } },
    boxShadow: shadows.hairline,
    cursor: "pointer",
  },
  /** The presenter's chip: accent while carrying the room along, quiet once it roams. */
  presenting: {
    display: "flex",
    height: 36,
    boxSizing: "border-box",
    alignItems: "center",
    gap: space.s2,
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: accent.a200,
    backgroundColor: accent.a50,
    paddingInlineStart: space.s2_5,
    paddingInlineEnd: space.s1,
    fontSize: text.control,
    lineHeight: leading.control,
    color: accent.a800,
    whiteSpace: "nowrap",
  },
  presentingRoam: { borderColor: border.subtle, backgroundColor: surface.raised, color: neutral.n700 },
  presentingDot: { width: 8, height: 8, flexShrink: 0, borderRadius: radii.pill, backgroundColor: accent.a600 },
  presentingDotRoam: { backgroundColor: neutral.n400 },
  presentingStrong: { fontWeight: weight.semibold },
  presentingAction: {
    height: 28,
    borderWidth: 0,
    borderRadius: radii.field,
    backgroundColor: { default: surface.raised, [env.hoverable]: { default: surface.raised, ":hover": neutral.n100 } },
    paddingInline: space.s2_5,
    fontFamily: "inherit",
    fontSize: text.control,
    fontWeight: weight.semibold,
    color: "inherit",
    cursor: "pointer",
  },
  navStatusLandscape: { flexGrow: 0, flexShrink: 1, flexBasis: "14rem", maxWidth: "min(22rem, 100%)" },
  navStatusDot: { height: 8, width: 8, flexShrink: 0, borderRadius: radii.pill, backgroundColor: ink.onDark },
  navStatusLabel: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  navStatusRelease: {
    display: "flex",
    height: space.s5,
    width: space.s5,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.pill,
    borderWidth: 0,
    padding: 0,
    color: accent.a100,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": accent.a500 } },
    cursor: "pointer",
  },

  /** The jump-to-page grid. */
  pagePicker: {
    position: "absolute",
    bottom: "100%",
    left: "50%",
    zIndex: 50,
    marginBottom: space.s2,
    width: "max-content",
    maxWidth: "min(20rem, calc(100vw - 2rem))",
    transform: "translateX(-50%)",
  },
  pageGrid: {
    display: "grid",
    maxHeight: "14rem",
    gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
    gap: space.s1,
    overflowY: "auto",
  },
  pageTile: {
    height: space.s10,
    width: space.s10,
    borderRadius: radii.control,
    borderWidth: 0,
    fontFamily: "inherit",
    fontSize: text.control,
    lineHeight: leading.control,
    fontWeight: weight.medium,
    fontVariantNumeric: "tabular-nums",
    cursor: "pointer",
    transitionProperty: "background-color, color",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
  pageTileCurrent: { backgroundColor: neutral.n600, color: ink.onDark },
  pageTileIdle: {
    color: neutral.n600,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
  },
  pagePickerFoot: {
    marginTop: space.s2,
    display: "flex",
    gap: space.s1,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: neutral.n100,
    paddingTop: space.s2,
  },
  newPage: {
    display: "flex",
    height: space.s10,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "0%",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s2,
    borderRadius: radii.control,
    borderWidth: 0,
    paddingInline: space.s3,
    fontFamily: "inherit",
    fontSize: text.control,
    lineHeight: leading.control,
    fontWeight: weight.medium,
    color: neutral.n700,
    backgroundColor: neutral.n50,
    cursor: "pointer",
    opacity: { default: 1, ":disabled": 0.4 },
  },
  deletePage: {
    display: "flex",
    height: space.s10,
    width: space.s10,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.control,
    borderWidth: 0,
    padding: 0,
    cursor: "pointer",
    color: { default: neutral.n400, [env.hoverable]: { default: neutral.n400, ":hover": danger.d600 } },
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": danger.d50 } },
  },

  /** The pager readout: "2 / 5". */
  pager: {
    borderRadius: radii.pill,
    borderWidth: 0,
    paddingInline: space.s3,
    fontFamily: "inherit",
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    fontVariantNumeric: "tabular-nums",
    color: neutral.n700,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
    cursor: "pointer",
    transitionProperty: "background-color",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
  pagerCompact: { height: 44, minWidth: "5rem" },
  pagerRegular: { height: 36, minWidth: "4rem" },

  /** A pager arrow or action. */
  controlButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.pill,
    borderWidth: 0,
    padding: 0,
    cursor: "pointer",
    color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, ":hover": neutral.n900 } },
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
    opacity: { default: 1, ":disabled": 0.25 },
    pointerEvents: { default: "auto", ":disabled": "none" },
    transitionProperty: "color, background-color",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
  controlButtonLarge: { height: 44, width: 44 },
  controlButtonRegular: { height: 30, width: 30, borderRadius: radii.control },
  /** A view that is on, like the page picker when it is open. */
  controlButtonPressed: { color: accent.a700, backgroundColor: accent.a50 },

  /** An anchoring context for a menu or picker. */
  anchor: { position: "relative" },

  /** Divider geometry; the rules are `boardDivider`'s. */
  bandDivider: { height: 16, marginInline: space.s1 },
});

type ConnectedUser = HandoffTarget;

interface WhiteboardViewportControlsProps {
  chrome: WhiteboardChromeConfig;
  canEditWhiteboard: boolean;
  canAddPages: boolean;
  isAddingPage?: boolean;
  pages: WhiteboardPage[];
  currentPage: number;
  /** Null while the reader has not zoomed (each page fitted), else a percentage of the page filling the width. */
  zoomPercent: number | null;
  onPageChange: (pageNumber: number) => void;
  onAddPage?: () => void;
  onInsertPageAfter?: (afterPageNumber: number) => void;
  onDeletePage?: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetView: () => void;
  canManageNavigation?: boolean;
  isNavigationController?: boolean;
  myUserId?: string | null;
  navigationControllerName?: string | null;
  connectedUsers?: ConnectedUser[];
  onSetNavigationController?: (targetUserId: string) => Promise<void>;
  /** Give someone edit access, by grant principal: handing the board to a reader does this first. */
  onGrantEditAccess?: (principalKey: string) => Promise<void>;
  onReleaseNavigationController?: () => Promise<void>;
  /** Regular boards only: whether the page rail is open, and the way to toggle it. */
  pageRailOpen?: boolean;
  onTogglePageRail?: () => void;
  /** Orb, the board assistant, for a reader who has no palette to find it in. */
  ai?: { open: boolean; onToggle: () => void };
  /** Following the presenter; null while there is nobody to follow. */
  follow?: WhiteboardFollowState | null;
  /** A reader's request for edit access: whether it is waiting, and the way to ask. Null for anyone who can edit. */
  editAccess?: { requested: boolean; onRequest: () => void } | null;
  /** The presenter's: whether they have let everyone look around. Null for anyone else. */
  presenting?: { roam: boolean; onToggleRoam: () => void } | null;
  /**
   * Show sources, beside zoom because it is a way of looking at the board:
   * a reader with no palette needs it as much as an editor does.
   */
  sources?: { showing: boolean; onToggle: () => void };
  /**
   * The controls' height as rendered — the upright dock with the status pills
   * stacked over it, or the top band, wrapped or not — or null when they stand
   * sideways. The camera keeps the page clear of exactly this, so a pill that
   * appears never covers the page.
   */
  onControlsHeightChange?: (heightPx: number | null) => void;
}

export function WhiteboardViewportControls({
  chrome,
  canEditWhiteboard,
  canAddPages,
  isAddingPage = false,
  pages,
  currentPage,
  zoomPercent,
  onPageChange,
  onAddPage,
  onInsertPageAfter,
  onDeletePage,
  onZoomIn,
  onZoomOut,
  onResetView,
  canManageNavigation = false,
  isNavigationController = false,
  myUserId = null,
  navigationControllerName = null,
  connectedUsers = [],
  onSetNavigationController,
  onGrantEditAccess,
  onReleaseNavigationController,
  pageRailOpen = false,
  onTogglePageRail,
  ai,
  follow = null,
  editAccess = null,
  presenting = null,
  sources,
  onControlsHeightChange,
}: WhiteboardViewportControlsProps) {
  const [showHandoffMenu, setShowHandoffMenu] = useState(false);
  const [showPagePicker, setShowPagePicker] = useState(false);
  const compact = chrome.mode === "compact";
  // A regular board keeps its controls in its top corner, away from the
  // writing hand; a phone keeps them in one capsule where a thumb reaches
  // them. The camera keeps the page clear of the same placement.
  const placement = controlsPlacement(chrome);
  const regular = placement === "corner";
  const sideways = placement === "side";
  // The upright dock and the corner band both grow with what they hold (status
  // pills stacked over the pager; a band wrapped to a second row), and the
  // camera keeps the page clear of their measured height. The side capsule is fixed.
  const controlsRef = useControlsHeight(placement !== "side", onControlsHeightChange);
  // Until the reader zooms, every page is fitted, and the control says so
  // rather than a percentage that would change from one page shape to the next.
  const isFitted = zoomPercent === null;
  const pageCount = Math.max(pages.length, 1);
  const isLastPage = currentPage >= pageCount;
  const pageLabel = String(currentPage);
  const handoffCandidates = connectedUsers.filter((user) => user.userId !== myUserId);
  const hasNavigationController = navigationControllerName !== null;
  const canHandOff = canManageNavigation &&
    !hasNavigationController &&
    Boolean(onSetNavigationController) &&
    handoffCandidates.length > 0;
  // The menu closes with its trigger: someone taking control, or the last
  // candidate leaving, would otherwise leave it open in state, and its
  // full-screen scrim would come back with the trigger to swallow a click.
  if (showHandoffMenu && !canHandOff) setShowHandoffMenu(false);

  const handleInsert = () => {
    if (isAddingPage) return;
    if (onInsertPageAfter) onInsertPageAfter(currentPage);
    else onAddPage?.();
  };

  const handleSetNavigationController = async (user: ConnectedUser) => {
    setShowHandoffMenu(false);
    if (!onSetNavigationController) return;
    const failure = await handOffBoard(user, {
      grant: onGrantEditAccess,
      setController: onSetNavigationController,
    });
    if (failure) emitWhiteboardError(failure, { title: "Hand off" });
  };

  const handleReleaseNavigationController = async () => {
    try {
      await onReleaseNavigationController?.();
    } catch (error) {
      console.error("Failed to release navigation controller:", error);
    }
  };

  const zoomControls = !compact && (
    <>
      <ControlButton label="Zoom out" onClick={onZoomOut}>
        <ZoomOut size={16} />
      </ControlButton>
      {/* "Fit", not "100%": the fit is the page fitted to this board — a
          wide page whole, a tall one across its width — and the control says
          which state it is in rather than making the reader know what 100%
          is relative to. */}
      <button
        type="button"
        onClick={onResetView}
        {...stylex.props(
          styles.fit,
          styles.fitBand,
          isFitted ? styles.fitFitted : styles.fitZoomed,
        )}
        aria-label={
          isFitted
            ? "Zoomed to fit the page"
            : `Zoom ${zoomPercent}%. Fit the page`
        }
        title={isFitted ? "The page fits the board" : "Fit the page to the board"}
      >
        {isFitted ? "Fit" : `${zoomPercent}%`}
      </button>
      <ControlButton label="Zoom in" onClick={onZoomIn}>
        <ZoomIn size={16} />
      </ControlButton>
    </>
  );

  const sourcesButton = sources && (
    <ControlButton label="Show sources" pressed={sources.showing} onClick={sources.onToggle} large={compact}>
      <Tags size={16} />
    </ControlButton>
  );

  const handoff = canHandOff && (
      <div {...stylex.props(styles.anchor)}>
        {/* Labeled, not a bare broadcast glyph: this hands navigation
            control to a participant, and the words say so — except in an
            upright phone's capsule, which has no room for them. */}
        <button
          type="button"
          onClick={() => setShowHandoffMenu((value) => !value)}
          {...stylex.props(styles.handoff, styles.handoffBand, compact && styles.handoffCompact)}
          aria-label="Hand off navigation control"
          title="Let a participant drive the pages everyone sees"
        >
          <Radio size={16} />
          <span {...stylex.props(compact && styles.handoffWordCompact)}>Hand off</span>
        </button>
        {showHandoffMenu && (
          <>
            <button
              type="button"
              {...stylex.props(styles.menuScrim)}
              aria-label="Close handoff menu"
              onClick={() => setShowHandoffMenu(false)}
            />
            <div
              {...stylex.props(
                styles.handoffMenu,
                boardPanel.surface,
                boardPanel.padSm,
                styles.handoffMenuBand,
                regular && styles.handoffMenuStart,
              )}
            >
              {handoffCandidates.map((user) => (
                <button
                  key={user.userId}
                  type="button"
                  onClick={() => void handleSetNavigationController(user)}
                  {...stylex.props(styles.handoffItem)}
                >
                  {user.userName}
                  {user.canEdit === false && (
                    <span {...stylex.props(styles.handoffItemNote)}>Gets edit access too</span>
                  )}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    );

  // The follow pill names the presenter, so for a plain follower it says
  // everything "Maya controls navigation" did. The navigation status stays for
  // whoever holds or can release control, which is a different message.
  const showNavigationStatus =
    hasNavigationController && (!follow || isNavigationController || canManageNavigation);
  const presentingStatus = presenting && (
    <div role="status" {...stylex.props(styles.presenting, presenting.roam && styles.presentingRoam)}>
      <span aria-hidden="true" {...stylex.props(styles.presentingDot, presenting.roam && styles.presentingDotRoam)} />
      <span {...stylex.props(styles.navStatusLabel)}>
        <b {...stylex.props(styles.presentingStrong)}>{presenting.roam ? "Everyone's browsing" : "You're presenting"}</b>
      </span>
      <button
        type="button"
        onClick={presenting.onToggleRoam}
        title={presenting.roam ? "Bring everyone back to your view" : "Let everyone look around on their own"}
        {...stylex.props(styles.presentingAction)}
      >
        {presenting.roam ? "Lead again" : "Let everyone browse"}
      </button>
    </div>
  );
  const followStatus = follow && (
    follow.roam && !follow.following ? (
      <div role="status" {...stylex.props(styles.follow, styles.followQuiet)}>
        <span {...stylex.props(styles.navStatusLabel)}>{follow.presenterName} let everyone look around</span>
        <button
          type="button"
          onClick={follow.follow}
          title={`Jump to ${follow.presenterName}'s view and stay with them`}
          {...stylex.props(styles.followStop)}
        >
          Follow
        </button>
      </div>
    ) : follow.following ? (
      <div role="status" {...stylex.props(styles.follow, styles.followQuiet)}>
        <Eye size={14} strokeWidth={2} aria-hidden="true" {...stylex.props(styles.followIcon)} />
        {/* A phone has the width for a first name and a cross beside "Ask to
            edit", not for the whole sentence: it pushed the request off the
            screen's edge. */}
        <span {...stylex.props(styles.navStatusLabel)}>
          Following {regular ? follow.presenterName : firstWord(follow.presenterName)}
        </span>
        <button
          type="button"
          onClick={follow.stopFollowing}
          aria-label={`Stop following ${follow.presenterName}`}
          title="Look around the board on your own"
          {...stylex.props(styles.followStop, !regular && styles.followStopIcon)}
        >
          {regular ? "Stop following" : <X size={16} strokeWidth={2} aria-hidden="true" />}
        </button>
      </div>
    ) : (
      <button
        type="button"
        onClick={follow.follow}
        title={`Jump to ${follow.presenterName}'s page and stay with them`}
        {...stylex.props(styles.follow, styles.followAgain)}
      >
        <Eye size={14} strokeWidth={2} aria-hidden="true" />
        Back to {follow.presenterName}
      </button>
    )
  );

  const editRequest = editAccess && (
    editAccess.requested ? (
      <span role="status" {...stylex.props(styles.follow, styles.followQuiet, styles.editRequestWaiting)}>
        Asked to edit…
      </span>
    ) : (
      <button
        type="button"
        onClick={editAccess.onRequest}
        title="Ask the host to let you draw on the board"
        {...stylex.props(styles.follow, styles.editRequest)}
      >
        <Pencil size={14} aria-hidden="true" />
        Ask to edit
      </button>
    )
  );
  // Following and asking to edit share one row: the request used to float
  // centred over the band and covered the follow pill on a narrow board.
  const statusRow = (followStatus || editRequest) && (
    <div {...stylex.props(styles.statusRow, !regular && styles.statusRowCompact)}>
      {followStatus}
      {editRequest}
    </div>
  );

  const navigationStatus = showNavigationStatus && (
    <div
      data-viewport-status-placement={regular ? "beside" : "band"}
      {...stylex.props(
        styles.navStatus,
        !regular && styles.navStatusBand,
        sideways && styles.navStatusLandscape,
      )}
    >
      <span {...stylex.props(styles.navStatusDot)} />
      <span {...stylex.props(styles.navStatusLabel)}>
        {isNavigationController ? "You control navigation" : `${navigationControllerName} controls navigation`}
      </span>
      {(isNavigationController || canManageNavigation) && onReleaseNavigationController && (
        <button
          type="button"
          onClick={() => void handleReleaseNavigationController()}
          {...stylex.props(styles.navStatusRelease)}
          aria-label="Release navigation control"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );

  const pagePicker = showPagePicker ? (
    <>
      <button
        type="button"
        {...stylex.props(styles.menuScrim)}
        aria-label="Close page picker"
        onClick={() => setShowPagePicker(false)}
      />
      <div {...stylex.props(styles.pagePicker, boardPanel.surface, boardPanel.padMd)}>
        <div {...stylex.props(styles.pageGrid)}>
          {pages.map((page) => (
            <button
              key={page.id}
              type="button"
              onClick={() => {
                setShowPagePicker(false);
                onPageChange(page.number);
              }}
              {...stylex.props(
                styles.pageTile,
                page.number === currentPage ? styles.pageTileCurrent : styles.pageTileIdle,
              )}
            >
              {page.number}
            </button>
          ))}
        </div>
        {(canAddPages || (canEditWhiteboard && pages.length > 1)) && (
          <div {...stylex.props(styles.pagePickerFoot)}>
            {canAddPages && (onInsertPageAfter || onAddPage) && (
              <button
                type="button"
                onClick={() => {
                  setShowPagePicker(false);
                  handleInsert();
                }}
                disabled={isAddingPage}
                {...stylex.props(styles.newPage)}
              >
                <Plus size={16} />
                New page
              </button>
            )}
            {canEditWhiteboard && onDeletePage && pages.length > 1 && (
              <button
                type="button"
                onClick={() => {
                  setShowPagePicker(false);
                  onDeletePage();
                }}
                {...stylex.props(styles.deletePage)}
                aria-label="Delete current page"
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>
        )}
      </div>
    </>
  ) : null;

  // The regular board: the corner at the top, one capsule — pages, then zoom,
  // then the rarer ways of looking. The page control opens the rail of
  // thumbnails rather than a grid of numbers — the rail is the page list, so
  // the capsule only says where you are in it.
  if (regular) {
    const divider = <span {...stylex.props(boardDivider.vertical, styles.bandDivider)} />;
    return (
      <div ref={controlsRef} data-viewport-placement="band" {...stylex.props(styles.viewport, styles.viewportBand)}>
        <div {...stylex.props(styles.bandPart)}>
          <div {...stylex.props(styles.bandCapsule, styles.bandCapsuleRegular)}>
            <ControlButton
              label="Previous page"
              onClick={() => onPageChange(Math.max(1, currentPage - 1))}
              disabled={currentPage <= 1}
            >
              <ChevronLeft size={16} />
            </ControlButton>
            <button
              type="button"
              onClick={onTogglePageRail}
              aria-pressed={pageRailOpen}
              aria-label={`Page ${pageLabel} of ${pageCount}. ${pageRailOpen ? "Hide" : "Show"} all pages`}
              title={pageRailOpen ? "Hide the page list" : "Show every page"}
              {...stylex.props(styles.pages, pageRailOpen ? styles.pagesOpen : styles.pagesIdle)}
            >
              <span>
                Page {pageLabel}
                <span {...stylex.props(styles.pageTotal)}> of {pageCount}</span>
              </span>
            </button>
            <ControlButton
              label="Next page"
              onClick={() => onPageChange(Math.min(pageCount, currentPage + 1))}
              disabled={isLastPage}
            >
              <ChevronRight size={16} />
            </ControlButton>
            {canAddPages && !pageRailOpen && (onInsertPageAfter || onAddPage) && (
              <ControlButton label="New page after this one" onClick={handleInsert} disabled={isAddingPage}>
                <Plus size={16} />
              </ControlButton>
            )}
            {divider}
            {zoomControls}
            {sourcesButton && divider}
            {sourcesButton}
            {handoff && divider}
            {handoff}
            {ai && (
              <>
                {divider}
                <button
                  type="button"
                  onClick={ai.onToggle}
                  aria-pressed={ai.open}
                  aria-label="Ask Orb"
                  title="Ask Orb"
                  {...stylex.props(styles.ai, ai.open && styles.aiOpen)}
                >
                  <Sparkles size={14} />
                  Orb
                </button>
              </>
            )}
          </div>
        </div>
        {(statusRow || navigationStatus || presentingStatus) && (
          <div {...stylex.props(styles.bandPart)}>
            {presentingStatus}
            {statusRow}
            {navigationStatus}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={controlsRef}
      data-viewport-placement={sideways ? "landscape" : "compact"}
      {...stylex.props(
        styles.viewport,
        styles.viewportCompact,
        sideways && styles.viewportLandscape,
        styles.viewportBottomCompact,
      )}
    >
      {presentingStatus}
      {statusRow}
      {navigationStatus}

      <div {...stylex.props(styles.bandCapsule)}>
        {zoomControls}
        {!compact && <span {...stylex.props(boardDivider.vertical, styles.bandDivider)} />}

        <ControlButton
          label="Previous page"
          onClick={() => onPageChange(Math.max(1, currentPage - 1))}
          disabled={currentPage <= 1}
          large={compact}
        >
          <ChevronLeft size={16} />
        </ControlButton>
        <div {...stylex.props(styles.anchor)}>
          <button
            type="button"
            onClick={() => setShowPagePicker((value) => !value)}
            {...stylex.props(styles.pager, compact ? styles.pagerCompact : styles.pagerRegular)}
            aria-label={`Page ${pageLabel} of ${pageCount}. Choose page`}
          >
            {pageLabel} / {pageCount}
          </button>
          {pagePicker}
        </div>
        <ControlButton
          label="Next page"
          onClick={() => onPageChange(Math.min(pageCount, currentPage + 1))}
          disabled={isLastPage}
          large={compact}
        >
          <ChevronRight size={16} />
        </ControlButton>

        {/* The page rail carries "add page" when it is mounted; two + buttons
            a few hundred pixels apart is one too many. */}
        {canAddPages && !chrome.pageRailVisible && (onInsertPageAfter || onAddPage) && (
          <>
            <span {...stylex.props(boardDivider.vertical, styles.bandDivider)} />
            <ControlButton
              label="New page"
              onClick={handleInsert}
              disabled={isAddingPage}
              large={compact}
            >
              <FilePlus size={16} />
            </ControlButton>
          </>
        )}

        {handoff}

        {sourcesButton && (
          <>
            <span {...stylex.props(boardDivider.vertical, styles.bandDivider)} />
            {sourcesButton}
          </>
        )}
      </div>
    </div>
  );
}

function ControlButton({
  children,
  disabled = false,
  label,
  large = false,
  onClick,
  pressed,
}: {
  children: ReactNode;
  disabled?: boolean;
  label: string;
  large?: boolean;
  onClick: () => void;
  /** Set only on a toggle; a plain action has no pressed state to announce. */
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      {...stylex.props(
        styles.controlButton,
        large ? styles.controlButtonLarge : styles.controlButtonRegular,
        pressed && styles.controlButtonPressed,
      )}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
    >
      {children}
    </button>
  );
}

function firstWord(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/**
 * Reports the controls' rendered height as it changes, and null while they are
 * not `measured`. Rounded, so subpixel layout noise does not move the camera.
 */
function useControlsHeight(measured: boolean, onChange: ((heightPx: number | null) => void) | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!onChange) return;
    const element = ref.current;
    if (!measured || !element) {
      onChange(null);
      return;
    }
    const report = () => onChange(Math.round(element.getBoundingClientRect().height));
    report();
    if (typeof ResizeObserver === "undefined") return () => onChange(null);
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => {
      observer.disconnect();
      onChange(null);
    };
  }, [measured, onChange]);
  return ref;
}
