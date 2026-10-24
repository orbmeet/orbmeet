import { accent, danger, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { boardZIndex } from "@orbmeet/ui/tokens/layers.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { duration, easing } from "@orbmeet/ui/tokens/motion.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, tracking, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { Fragment, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpToLine, Plus, Trash2 } from "lucide-react";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";
import type { WhiteboardPage } from "./page-manager";
import type { PageThumbnails } from "./use-page-thumbnails";
import { railVars } from "../styles/board-context.stylex";
import { boardPanel } from "../styles/board";
import { scrim } from "@orbmeet/ui/tokens/wash.stylex";
import {
  WHITEBOARD_PAGE_RAIL_CARD_MAX_HEIGHT_PX,
  WHITEBOARD_PAGE_RAIL_WIDTH_PX,
} from "../camera/viewport-insets";

/**
 * The gap between two thumbnails, which is also the insert row.
 *
 * Two heights, because the row has two jobs depending on what is pointing at
 * it. On a mouse the caret appears under the cursor and a thin gap is enough
 * to aim at. On touch there is no cursor to appear under: the row has to be
 * permanently visible *and* big enough to hit, and 12px is neither.
 *
 * This is the bug the rail shipped with. `caretOpacity` was gated on
 * `@media (hover: hover) and (pointer: fine)`, which an iPad is not — so on a
 * tablet the insert affordance was rendered at `opacity: 0` forever, and
 * "add a page between 4 and 5" had no answer anywhere in the product. The
 * page menu below is the other half of the answer; this is the fast path.
 */
const RAIL_ROW_GAP_PX = 28;
const RAIL_ROW_GAP_HOVERABLE_PX = 14;

/**
 * A thumbnail's width. Its height comes from the page it stands for.
 *
 * A literal rather than the import from `viewport-insets`: StyleX resolves
 * `stylex.create` at build time and can only follow values it can statically
 * reach, which a plain module constant is not. The number it must equal is
 * `WHITEBOARD_PAGE_RAIL_CARD_WIDTH_PX` — the thumbnail renderer solves its
 * raster size from that one, and a test asserts the two agree so the pair
 * cannot drift into a permanently blurry rail.
 */
const CARD_WIDTH = 88;

/**
 * Bounds on a card's height.
 *
 * A card takes its aspect from its own frame, so a thumbnail has the page's
 * proportions; the clamp is only there so a deliberately extreme frame cannot
 * produce a card taller than the rail.
 */
const MIN_CARD_HEIGHT = 52;

function cardHeightFor(page: WhiteboardPage): number {
  const width = page.width;
  if (!Number.isFinite(page.height) || page.height <= 0 || !Number.isFinite(width) || width <= 0) {
    return Math.round((CARD_WIDTH * WHITEBOARD_CONFIG.PAGE_HEIGHT) / WHITEBOARD_CONFIG.PAGE_WIDTH);
  }
  const height = Math.round((CARD_WIDTH * page.height) / width);
  return Math.min(
    WHITEBOARD_PAGE_RAIL_CARD_MAX_HEIGHT_PX,
    Math.max(MIN_CARD_HEIGHT, height),
  );
}

/**
 * An arriving page fades and settles into a slot the list has *already* made
 * for it.
 *
 * The old entrance animated the card's height from 0, which meant every page
 * below the new one slid downwards for 260ms — insert a page at the top of a
 * 23-page document and the whole rail was in motion. The reflow that opens the
 * slot is unavoidable and instant; what follows is only the card arriving in
 * it, and nothing else on the rail moves.
 */
const cardIn = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(-4px) scale(0.92)" },
  to: { opacity: 1, transform: "translateY(0) scale(1)" },
});

const cardFlash = stylex.keyframes({
  from: { boxShadow: `0 0 0 0 color-mix(in oklab, ${accent.a500} 45%, transparent)` },
  to: { boxShadow: `0 0 0 9px color-mix(in oklab, ${accent.a500} 0%, transparent)` },
});

const ghostBreathe = stylex.keyframes({
  "0%": { opacity: 0.35 },
  "50%": { opacity: 0.8 },
  "100%": { opacity: 0.35 },
});

const menuIn = stylex.keyframes({
  from: { opacity: 0, transform: "translateX(-6px) scale(0.97)" },
  to: { opacity: 1, transform: "translateX(0) scale(1)" },
});

const styles = stylex.create({
  /**
   * Two parts: a heading and one scroller.
   *
   * The zoom controls live in the canvas's bottom-right corner, not in a band
   * at the rail's foot: that band would need a hand-kept constant equal to the
   * rendered height of a capsule whose contents are conditional, and a number
   * kept equal to a rendered height by hand eventually stops being equal.
   */
  rail: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    zIndex: boardZIndex.rail,
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    borderRightWidth: 1,
    borderRightStyle: "solid",
    borderRightColor: scrim.hairline,
    backgroundColor: "var(--wb-document-bg)",
    paddingTop: space.s3,
  },
  /**
   * The rail's band, as a dynamic style rather than a literal: the camera
   * reserves exactly this width (see `viewport-insets`), and the two must not
   * be able to drift.
   */
  railWidth: (px: number) => ({ width: px }),
  count: {
    flexShrink: 0,
    paddingInline: space.s2,
    paddingBottom: space.s2,
    textAlign: "center",
    fontSize: "11px",
    lineHeight: 1,
    fontWeight: weight.medium,
    color: neutral.n500,
  },

  /** The only scroller. Fades at its foot rather than cutting a card in half. */
  scroller: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "0%",
    minHeight: 0,
    overflowY: "auto",
    overflowX: "hidden",
    overscrollBehavior: "contain",
    scrollbarWidth: "none",
    "::-webkit-scrollbar": { display: "none" },
    // The fade is exactly as deep as the list's own bottom padding, so at the
    // end of the scroll it dims empty space rather than the append button.
    maskImage: "linear-gradient(to bottom, black calc(100% - 16px), transparent 100%)",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    paddingBottom: space.s6,
  },

  card: {
    position: "relative",
    display: "block",
    width: CARD_WIDTH,
    flexShrink: 0,
    overflow: "hidden",
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "solid",
    backgroundColor: surface.raised,
    fontFamily: "inherit",
    padding: 0,
    cursor: "pointer",
    // A long press opens the page menu, so the text under the finger must not
    // be selectable — otherwise the gesture starts a selection instead.
    userSelect: "none",
    transform: { default: "none", ":active": "scale(0.95)" },
    transitionProperty: "transform, border-color, box-shadow",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
  cardHeight: (px: number) => ({ height: px }),
  cardCurrent: {
    borderColor: accent.a500,
    // The ring rides on the resting lift rather than replacing it.
    boxShadow: `${shadows.lift1}, 0 0 0 2px color-mix(in oklab, ${accent.a500} 35%, transparent)`,
  },
  cardIdle: {
    borderColor: { default: neutral.n200, [env.hoverable]: { default: neutral.n200, ":hover": neutral.n400 } },
    boxShadow: { default: shadows.lift1, [env.hoverable]: { default: shadows.lift1, ":hover": shadows.card } },
  },
  cardEntering: {
    animationName: { default: `${cardIn}, ${cardFlash}`, [env.reducedMotion]: "none" },
    animationDuration: "220ms, 820ms",
    animationDelay: "0ms, 120ms",
    animationTimingFunction: "cubic-bezier(0.2, 0.9, 0.25, 1), ease-out",
  },

  /** The page, as a picture. Contained, so a page of any shape stays whole. */
  thumb: {
    display: "block",
    height: "100%",
    width: "100%",
    objectFit: "contain",
    backgroundColor: surface.raised,
  },
  /**
   * A picture restored from the last session, shown while the live one renders.
   *
   * Held back a touch rather than hidden: a slightly dimmed picture of the page
   * as it was answers "which one is the one I want", and a blank card does not.
   */
  thumbStale: { opacity: 0.72 },
  /** What a card shows until any picture at all exists. */
  thumbPending: { height: "100%", width: "100%", backgroundColor: neutral.n50 },

  /**
   * The page number, as a corner chip.
   *
   * Centred and large, it would sit exactly where the page's own content is, so
   * the number lives in a corner and takes a wash with it — a number has to
   * stay legible over a dense diagram as well as over an empty page.
   */
  badge: {
    position: "absolute",
    right: 4,
    bottom: 4,
    minWidth: 17,
    borderRadius: radii.field,
    paddingInline: 5,
    paddingBlock: 1,
    fontSize: "10px",
    lineHeight: "14px",
    fontWeight: weight.bold,
    fontVariantNumeric: "tabular-nums",
    textAlign: "center",
    color: ink.onDark,
    backgroundColor: `color-mix(in oklab, ${neutral.n900} 62%, transparent)`,
  },
  badgeCurrent: { backgroundColor: accent.a600 },

  /**
   * The row between two thumbnails, and the button that lives in it.
   *
   * Fixed height, always. A row that grows under the pointer pushes every page
   * below it down and then lets it spring back — the rail would ripple while
   * you aim at it, and the target would move out from under the cursor.
   *
   * On touch the mark is permanently at rest visible, because there is no
   * hover state to reveal it with and an invisible control is not a control.
   * On a mouse it still fades in per row rather than as a set: the list used
   * to raise every caret in the document to half opacity the moment the
   * pointer entered it, which drew twenty-two "insert here" marks to answer a
   * question about one gap.
   */
  caret: {
    display: "flex",
    height: { default: RAIL_ROW_GAP_PX, [env.hoverable]: RAIL_ROW_GAP_HOVERABLE_PX },
    width: CARD_WIDTH,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 0,
    backgroundColor: "transparent",
    padding: 0,
    cursor: "pointer",
    pointerEvents: { default: "auto", ":disabled": "none" },
    [railVars.caretOpacity]: {
      default: "0.55",
      [env.hoverable]: { default: "0", ":hover": "1" },
      ":focus-visible": "1",
      ":active": "1",
      ":disabled": "0",
    },
  },
  caretMark: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    opacity: railVars.caretOpacity,
    transitionProperty: "opacity",
    transitionDuration: { default: "120ms", [env.reducedMotion]: "0s" },
    transitionTimingFunction: "ease-out",
  },
  caretRule: { height: 1, flexGrow: 1, flexShrink: 1, flexBasis: "0%", backgroundColor: accent.a400 },
  /**
   * The `+` itself. A filled disc on touch — at rest, with no hover to explain
   * it, a bare glyph on a hairline reads as decoration rather than a button.
   */
  caretIcon: {
    display: "flex",
    height: { default: 18, [env.hoverable]: 14 },
    width: { default: 18, [env.hoverable]: 14 },
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    marginInline: 3,
    borderRadius: radii.pill,
    color: { default: ink.onDark, [env.hoverable]: accent.a600 },
    backgroundColor: { default: accent.a500, [env.hoverable]: "transparent" },
  },

  /**
   * The empty row where an insert would be meaningless — below the last page,
   * and every row when the viewer cannot place pages at all. Same height as a
   * caret row, so the list's rhythm does not change with permissions.
   */
  gap: {
    flexShrink: 0,
    height: { default: RAIL_ROW_GAP_PX, [env.hoverable]: RAIL_ROW_GAP_HOVERABLE_PX },
  },

  /** The slot a page is about to occupy, held open while the room answers. */
  ghost: {
    display: "flex",
    width: CARD_WIDTH,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: accent.a400,
    backgroundColor: `color-mix(in oklab, ${accent.a50} 70%, transparent)`,
    color: accent.a500,
    opacity: { default: 1, [env.reducedMotion]: 0.6 },
    animationName: { default: ghostBreathe, [env.reducedMotion]: "none" },
    animationDuration: "1.1s",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
  },

  add: {
    display: "flex",
    height: space.s10,
    width: CARD_WIDTH,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: space.s1,
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: { default: neutral.n300, [env.hoverable]: { default: neutral.n300, ":hover": accent.a400 } },
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": accent.a50 } },
    color: { default: neutral.n500, [env.hoverable]: { default: neutral.n400, ":hover": accent.a600 } },
    fontFamily: "inherit",
    fontSize: "11px",
    lineHeight: 1,
    fontWeight: weight.medium,
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    opacity: { default: 1, ":disabled": 0.4 },
    transform: { default: "none", ":active": "scale(0.95)" },
    transitionProperty: "color, background-color, border-color, transform",
    transitionDuration: { default: duration.instant, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
    [railVars.addIconRotation]: { default: "0deg", [env.hoverable]: { default: "0deg", ":hover": "90deg" } },
  },
  addIcon: {
    transform: `rotate(${railVars.addIconRotation})`,
    transitionProperty: "transform",
    transitionDuration: { default: duration.base, [env.reducedMotion]: "0s" },
  },

  /**
   * The page menu. Anchored beside its card rather than over it, because the
   * card is the thing the menu is about and covering it loses the reference.
   */
  menuScrim: {
    position: "fixed",
    inset: 0,
    zIndex: boardZIndex.rail,
    borderWidth: 0,
    padding: 0,
    backgroundColor: "transparent",
    cursor: "default",
  },
  /**
   * Positioned against the viewport, not against its card.
   *
   * The obvious anchor — `absolute; left: 100%` on the row — is clipped: the
   * page list lives in a scroller with `overflow-x: hidden`, so a panel that
   * reaches past the rail's right edge is cut off at exactly the width of the
   * rail. Fixed coordinates read off the card's own rect place it beside the
   * card, and it is rendered outside the scroller, whose mask would otherwise
   * clip a fixed descendant all the same.
   */
  menu: {
    position: "fixed",
    zIndex: boardZIndex.rail,
    minWidth: "11rem",
    animationName: { default: menuIn, [env.reducedMotion]: "none" },
    animationDuration: "140ms",
    animationTimingFunction: "cubic-bezier(0.2, 0.9, 0.25, 1)",
  },
  menuAt: (top: number, left: number) => ({ top, left }),
  menuItem: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: space.s2_5,
    borderRadius: radii.control,
    borderWidth: 0,
    paddingInline: space.s2_5,
    paddingBlock: space.s2,
    fontFamily: "inherit",
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    textAlign: "left",
    whiteSpace: "nowrap",
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    opacity: { default: 1, ":disabled": 0.4 },
    color: { default: neutral.n700, [env.hoverable]: { default: neutral.n700, ":hover": accent.a700 } },
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": accent.a50 } },
  },
  menuItemDanger: {
    color: { default: danger.d600, [env.hoverable]: { default: danger.d600, ":hover": danger.d700 } },
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": danger.d50 } },
  },
  menuRule: {
    height: 1,
    marginBlock: space.s1,
    backgroundColor: neutral.n100,
  },
  menuHeading: {
    paddingInline: space.s2_5,
    paddingBottom: space.s1,
    fontSize: "9.5px",
    lineHeight: 1,
    fontWeight: weight.bold,
    textTransform: "uppercase",
    letterSpacing: tracking.widest,
    color: neutral.n400,
  },

  /** Positioning context for a card's menu. */
  row: { position: "relative", display: "flex", flexShrink: 0, justifyContent: "center" },
});

/** Long enough to cover the card entrance plus its delayed ripple. */
const PAGE_ENTER_MS = 1000;

/** Where a press that has not come back from the room yet is aimed. */
type PendingAdd = { at: "end" } | { at: "after"; pageNumber: number };

/** Viewport coordinates the page menu opens at, read off its card. */
interface MenuAnchor {
  /**
   * The page by id, not number: pages inserted or deleted before it
   * renumber it, and the menu must stay with the page it was opened on.
   */
  pageId: string;
  top: number;
  left: number;
}

/**
 * Roughly how tall the menu is, for keeping it inside the window.
 *
 * An estimate rather than a measurement: the alternative is opening the menu
 * off-screen, measuring it, and moving it, which is a visible jump. Being a
 * few pixels out only shifts where a menu near the bottom edge sits.
 */
const MENU_HEIGHT_ESTIMATE_PX = 116;
const MENU_DELETE_ROW_PX = 46;

/**
 * Which pages appeared since the previous render.
 *
 * A page arrives from the CRDT, not from the click — a collaborator's page
 * lands here the same way yours does — so "new" can only be read by comparing
 * against what the rail was showing a moment ago. React's guarded render-time
 * state adjustment makes the entry class part of the first committed frame;
 * an effect then retires the class after the CSS animation has finished.
 */
function useEnteringPages(pages: WhiteboardPage[]): (id: string) => boolean {
  const ids = pages.map((page) => String(page.id));
  const [arrival, setArrival] = useState(() => ({
    ids,
    entering: new Set<string>(),
  }));

  if (
    ids.length !== arrival.ids.length ||
    ids.some((id, index) => id !== arrival.ids[index])
  ) {
    const currentIds = new Set(ids);
    const previousIds = new Set(arrival.ids);
    const entering = new Set(
      [...arrival.entering].filter((id) => currentIds.has(id)),
    );
    for (const id of ids) {
      if (!previousIds.has(id)) entering.add(id);
    }
    setArrival({ ids, entering });
  }

  useEffect(() => {
    if (arrival.entering.size === 0) return;
    const timeout = window.setTimeout(() => {
      setArrival((current) =>
        current.entering.size === 0
          ? current
          : { ...current, entering: new Set() },
      );
    }, PAGE_ENTER_MS);
    return () => window.clearTimeout(timeout);
  }, [arrival.entering]);

  return (id: string) => arrival.entering.has(id);
}

/** The slot a page is about to occupy, held open while the room answers. */
function PendingPageSlot({ height }: { height: number }) {
  return (
    <div
      aria-hidden
      data-pending-page
      {...stylex.props(styles.ghost, styles.cardHeight(height))}
    >
      <Plus size={14} />
    </div>
  );
}

/**
 * "Put a page here" — the row that lives in the gap between two thumbnails.
 *
 * Insert renumbers every page below it for everyone in the room, so it is a
 * deliberate gesture rather than the rail's default: position carries the
 * meaning, and the row only exists where a page can actually land.
 */
function InsertPageHere({
  afterPageNumber,
  disabled,
  onInsert,
}: {
  afterPageNumber: number;
  disabled: boolean;
  onInsert: (afterPageNumber: number) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        if (!disabled) onInsert(afterPageNumber);
      }}
      disabled={disabled}
      data-insert-after={afterPageNumber}
      aria-label={
        afterPageNumber === 0
          ? "Insert page before page 1"
          : `Insert page after page ${afterPageNumber}`
      }
      {...stylex.props(styles.caret)}
    >
      <span aria-hidden {...stylex.props(styles.caretMark)}>
        <span {...stylex.props(styles.caretRule)} />
        <span {...stylex.props(styles.caretIcon)}>
          <Plus size={11} strokeWidth={3} />
        </span>
        <span {...stylex.props(styles.caretRule)} />
      </span>
    </button>
  );
}

/**
 * What you can do to one page, once you are standing on it.
 *
 * The rail's gestures are layered rather than modal: a tap on any card goes to
 * that page, and a second tap on the card you are *already* on — a gesture
 * that would otherwise do nothing — opens this. That keeps navigation, by
 * far the common case, a single unqualified tap, while giving the rarer
 * operations somewhere to live that does not require a hover, a right-click,
 * or twenty-four permanently-drawn overflow buttons.
 */
function PageMenu({
  page,
  anchor,
  canInsert,
  canDelete,
  isBusy,
  onInsertBefore,
  onInsertAfter,
  onDelete,
  onClose,
}: {
  page: WhiteboardPage;
  anchor: MenuAnchor;
  canInsert: boolean;
  canDelete: boolean;
  isBusy: boolean;
  onInsertBefore: () => void;
  onInsertAfter: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Focus moves into the menu so a keyboard or switch user is not left behind
  // on the card, and so Escape has somewhere to return from.
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, []);

  // Kept on screen: a card near the foot of a long rail would otherwise open
  // a menu that runs off the bottom of the window.
  const height = MENU_HEIGHT_ESTIMATE_PX + (canDelete ? MENU_DELETE_ROW_PX : 0);
  const viewportHeight = typeof window === "undefined" ? 0 : window.innerHeight;
  const top = Math.max(8, Math.min(anchor.top, viewportHeight - height - 8));

  return (
    <>
      <button
        type="button"
        {...stylex.props(styles.menuScrim)}
        aria-label="Close page menu"
        onClick={onClose}
      />
      <div
        ref={ref}
        role="menu"
        aria-label={`Page ${page.number} actions`}
        data-page-menu={page.number}
        {...stylex.props(
          styles.menu,
          styles.menuAt(top, anchor.left),
          boardPanel.surface,
          boardPanel.padSm,
        )}
      >
        <div {...stylex.props(styles.menuHeading)}>Page {page.number}</div>
        <button
          type="button"
          role="menuitem"
          disabled={!canInsert || isBusy}
          onClick={onInsertBefore}
          {...stylex.props(styles.menuItem)}
        >
          <ArrowUpToLine size={15} />
          Insert page above
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={!canInsert || isBusy}
          onClick={onInsertAfter}
          {...stylex.props(styles.menuItem)}
        >
          <ArrowDownToLine size={15} />
          Insert page below
        </button>
        {canDelete && (
          <>
            <div aria-hidden {...stylex.props(styles.menuRule)} />
            <button
              type="button"
              role="menuitem"
              onClick={onDelete}
              {...stylex.props(styles.menuItem, styles.menuItemDanger)}
            >
              <Trash2 size={15} />
              Delete page
            </button>
          </>
        )}
      </div>
    </>
  );
}

/** Where a card's menu should open: just past its right edge, level with it. */
function anchorFor(pageId: string, card: HTMLElement): MenuAnchor {
  const rect = card.getBoundingClientRect();
  return { pageId, top: rect.top, left: rect.right + 8 };
}

/** One page: its picture, its number, and whether you are standing on it. */
function PageCard({
  page,
  height,
  isCurrent,
  isEntering,
  hasMenu,
  thumbnails,
  onPageChange,
  onOpenMenu,
}: {
  page: WhiteboardPage;
  height: number;
  isCurrent: boolean;
  isEntering: boolean;
  hasMenu: boolean;
  thumbnails: PageThumbnails | undefined;
  onPageChange: (pageNumber: number) => void;
  onOpenMenu: (anchor: MenuAnchor) => void;
}) {
  const pageId = String(page.id);
  const thumbnail = thumbnails?.byPageId.get(pageId);
  const opensMenu = hasMenu && isCurrent;
  return (
    <button
      type="button"
      ref={thumbnails?.observe(pageId)}
      onClick={(event) => {
        if (opensMenu) onOpenMenu(anchorFor(pageId, event.currentTarget));
        else onPageChange(page.number);
      }}
      // A long press is the other way in, for anyone who reaches for it — and
      // it is how the menu is opened for a page you are *not* on, without
      // making the trip there first.
      onContextMenu={(event) => {
        if (!hasMenu) return;
        event.preventDefault();
        onOpenMenu(anchorFor(pageId, event.currentTarget));
      }}
      aria-label={
        opensMenu
          ? `Page ${page.number}, current page. Open page actions`
          : `Go to page ${page.number}`
      }
      aria-haspopup={opensMenu ? "menu" : undefined}
      aria-current={isCurrent ? "true" : undefined}
      data-entering-page={isEntering || undefined}
      {...stylex.props(
        styles.card,
        styles.cardHeight(height),
        isCurrent ? styles.cardCurrent : styles.cardIdle,
        isEntering && styles.cardEntering,
      )}
    >
      {thumbnail ? (
        // Decorative: the button's own label already names the page, and a
        // thumbnail has no text alternative worth reading out.
        <img
          src={thumbnail.url}
          alt=""
          draggable={false}
          data-stale-thumbnail={thumbnail.stale || undefined}
          {...stylex.props(styles.thumb, thumbnail.stale && styles.thumbStale)}
        />
      ) : (
        <span aria-hidden {...stylex.props(styles.thumbPending)} />
      )}
      <span aria-hidden {...stylex.props(styles.badge, isCurrent && styles.badgeCurrent)}>
        {page.number}
      </span>
    </button>
  );
}

/**
 * Every page in the document, down the left of the board.
 *
 * Without it, a board's other pages would have one trace in the UI: the
 * `1 / 3` in the bottom pager, which you have to already be looking at to
 * read. With the page fitted to the viewport there is no page edge peeking
 * below the fold either, so a three-page board and a one-page board would look
 * identical and people draw off the end of page 1 rather than turning the page.
 *
 * The rail is a list, not a scroll position: click a page to go to it, and the
 * count is legible without clicking anything. Each row shows the page itself
 * (see `use-page-thumbnails`) rather than only its number, because the
 * question people bring to a page list is "which one is the one I want", and
 * a number cannot answer it.
 *
 * ## Adding a page
 *
 * Three gestures, and every one of them works with a finger:
 *
 *   - the row between two thumbnails inserts there, including a row *above
 *     page 1*;
 *   - the `+` at the foot appends after the last page, renumbering nothing;
 *   - the page menu — a second tap on the card you are already on — does both
 *     by name, for anyone who did not read a hairline as a button.
 *
 * The first of those shipped gated behind `:hover`, which meant that on a
 * tablet it did not ship. The others exist because one affordance for an
 * operation this common was already one too few.
 */
export function WhiteboardPageRail({
  pages,
  currentPage,
  canAddPages,
  canDeletePages = false,
  isAddingPage = false,
  thumbnails,
  onPageChange,
  onAddPage,
  onInsertPageAfter,
  onDeletePage,
}: {
  pages: WhiteboardPage[];
  currentPage: number;
  canAddPages: boolean;
  canDeletePages?: boolean;
  isAddingPage?: boolean;
  thumbnails?: PageThumbnails;
  onPageChange: (pageNumber: number) => void;
  onAddPage?: () => void;
  /** `0` inserts before page 1; `n` inserts after page `n`. */
  onInsertPageAfter?: (afterPageNumber: number) => void;
  onDeletePage?: (pageNumber: number) => void;
}) {
  const isEntering = useEnteringPages(pages);
  const [pending, setPending] = useState<PendingAdd | null>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!pending || isAddingPage) return;
    const timeout = window.setTimeout(() => setPending(null), 0);
    return () => window.clearTimeout(timeout);
  }, [isAddingPage, pending]);

  // A page that went away — deleted here or by somebody else — must not leave
  // its menu open over the card that took its place.
  useEffect(() => {
    if (menu !== null && !pages.some((page) => String(page.id) === menu.pageId)) setMenu(null);
  }, [menu, pages]);

  // The menu is placed in viewport coordinates so it can escape the scroller's
  // horizontal clip, which means it does not travel with its card. Rather than
  // recompute the anchor on every scroll frame, the menu closes: it is a short
  // list of actions, and one that has drifted away from the page it is about
  // is worse than one that is not there.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const scroller = scrollerRef.current;
    scroller?.addEventListener("scroll", close, { passive: true });
    window.addEventListener("resize", close);
    return () => {
      scroller?.removeEventListener("scroll", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  if (pages.length === 0) return null;

  const canInsert = canAddPages && !!onInsertPageAfter;
  const canDelete = canDeletePages && !!onDeletePage && pages.length > 1;
  const hasMenu = canInsert || canDelete;
  const pendingAfter =
    isAddingPage && pending?.at === "after" ? pending.pageNumber : null;
  const pendingAtEnd = isAddingPage && pending?.at === "end";
  // A slot is held open at the shape of the page it is standing in for.
  const ghostHeight = cardHeightFor(
    pages[Math.max(0, Math.min(pages.length - 1, currentPage - 1))] ?? pages[0],
  );

  const insertAt = (afterPageNumber: number) => {
    if (!onInsertPageAfter || isAddingPage) return;
    setMenu(null);
    setPending({ at: "after", pageNumber: afterPageNumber });
    onInsertPageAfter(afterPageNumber);
  };

  const menuPage = menu ? pages.find((page) => String(page.id) === menu.pageId) ?? null : null;

  return (
    <nav
      aria-label="Pages"
      // Opaque, not floating: the camera reserves the rail's band, but tldraw
      // re-centres the page itself when it is narrower than the viewport, so a
      // tall window can still slide a page edge under here. A solid column
      // makes that a clean boundary instead of a page peeking out from beneath
      // the buttons.
      {...stylex.props(styles.rail, styles.railWidth(WHITEBOARD_PAGE_RAIL_WIDTH_PX))}
    >
      <span {...stylex.props(styles.count)}>
        {pages.length === 1 ? "1 page" : `${pages.length} pages`}
      </span>

      <div ref={scrollerRef} {...stylex.props(styles.scroller)}>
        {/* The list owns its own row spacing so an insert row can occupy the
            gap it would otherwise leave empty. */}
        <div {...stylex.props(styles.list)}>
          {/* Above page 1. The rail had no way to express this position, and
              the client clamped `afterPageNumber` to 1 — even though the
              server has always accepted 0. */}
          {canInsert ? (
            <InsertPageHere afterPageNumber={0} disabled={isAddingPage} onInsert={insertAt} />
          ) : (
            <div {...stylex.props(styles.gap)} />
          )}
          {pendingAfter === 0 && <PendingPageSlot height={ghostHeight} />}

          {pages.map((page, index) => {
            const isLast = index === pages.length - 1;
            return (
              <Fragment key={page.id}>
                <div {...stylex.props(styles.row)}>
                  <PageCard
                    page={page}
                    height={cardHeightFor(page)}
                    isCurrent={page.number === currentPage}
                    isEntering={isEntering(String(page.id))}
                    hasMenu={hasMenu}
                    thumbnails={thumbnails}
                    onPageChange={onPageChange}
                    onOpenMenu={setMenu}
                  />
                </div>
                {pendingAfter === page.number && <PendingPageSlot height={ghostHeight} />}
                {canInsert && !isLast ? (
                  <InsertPageHere
                    afterPageNumber={page.number}
                    disabled={isAddingPage}
                    onInsert={insertAt}
                  />
                ) : (
                  <div {...stylex.props(styles.gap)} />
                )}
              </Fragment>
            );
          })}
          {pendingAtEnd && <PendingPageSlot height={ghostHeight} />}

          {canAddPages && onAddPage && (
            <button
              type="button"
              onClick={() => {
                if (isAddingPage) return;
                setMenu(null);
                setPending({ at: "end" });
                onAddPage();
              }}
              disabled={isAddingPage}
              aria-label="Add page at end"
              {...stylex.props(styles.add)}
            >
              <Plus size={14} strokeWidth={2.5} {...stylex.props(styles.addIcon)} />
              Page
            </button>
          )}
        </div>
      </div>

      {/* Outside the scroller, which fades its foot with a mask: a mask makes
          its element the containing block of every fixed descendant and
          clips them to it, so a menu rendered inside was cut off at the
          rail's edge — invisible, and with Delete page out of reach. */}
      {menuPage && menu && (
        <PageMenu
          page={menuPage}
          anchor={menu}
          canInsert={canInsert}
          canDelete={canDelete}
          isBusy={isAddingPage}
          onInsertBefore={() => insertAt(menuPage.number - 1)}
          onInsertAfter={() => insertAt(menuPage.number)}
          onDelete={() => {
            setMenu(null);
            onDeletePage?.(menuPage.number);
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </nav>
  );
}
