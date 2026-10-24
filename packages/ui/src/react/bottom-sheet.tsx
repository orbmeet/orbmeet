import * as stylex from "@stylexjs/stylex";
import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { neutral, surface } from "../tokens/colors.stylex";
import { zIndex } from "../tokens/layers.stylex";
import { env, safeArea } from "../tokens/media.stylex";
import { duration } from "../tokens/motion.stylex";
import { radii } from "../tokens/radii.stylex";
import { space } from "../tokens/space.stylex";
import { leading, text, weight } from "../tokens/typography.stylex";
import { scrimBase } from "../tokens/wash.stylex";

/**
 * The phone's bottom sheet: meeting options, People, Timeline, search, caption
 * language and pre-join settings all open in it.
 *
 * Deliberately not Base UI's Drawer (or Dialog). On iOS 27 Safari every Base
 * UI variant froze rendering for ~4 s per open over a live meeting, and longer
 * as the phone heated: the tap and React's commit took ~40 ms, then no frame
 * for 3.8 → 12.8 s. Measured on the device, it survived removing the backdrop,
 * the backdrop blur, the transitions, modality, the snap points, the virtual
 * keyboard provider, the initial focus and the <body> portal, and swapping
 * Drawer for Dialog. A plain fixed panel with the same menu opened in under
 * 80 ms. What only the Base UI variants had was a viewport-sized fixed layer
 * (the Viewport) over the video, and `touch-action: none` on it and on the
 * popup — the pairing Base UI's drawer examples recommend for swipe.
 *
 * So this sheet has neither: no viewport-sized element, default touch
 * handling, and the dismissal a backdrop would catch done by a document
 * listener. It keeps the drawer's look, curve and keyboard behaviour. There is
 * no swipe-to-dismiss.
 */

const ENTER_EXIT_MS = 240;
/** Base UI's drawer curve. Sharper out than in, so the sheet lands. */
const DRAWER_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
/** Overlap between the sheet and the soft keyboard; see `useKeyboardInset`. */
const KEYBOARD = "var(--sheet-keyboard-inset, 0px)";
/** A click outside this soon after the dismissing press is swallowed with it. */
const SWALLOW_CLICK_MS = 600;
/** On a short landscape screen the sheet reaches up to just under the top safe area. */
const SHORT_LANDSCAPE_HEIGHT = `calc(100dvh - ${safeArea.top} - ${space.s2})`;

const styles = stylex.create({
  sheet: {
    position: "fixed",
    insetInline: 0,
    // Lifted above the soft keyboard rather than padded: there is no viewport
    // element to pad.
    bottom: KEYBOARD,
    zIndex: zIndex.modal,
    display: "flex",
    flexDirection: "column",
    // A phone on its side is ~390pt tall: 80% of it left a chat sheet room for
    // two messages once its tabs and composer were drawn. It takes the height.
    height: { default: "80dvh", [env.shortLandscape]: SHORT_LANDSCAPE_HEIGHT },
    maxHeight: {
      default: `calc(80dvh - ${KEYBOARD})`,
      [env.shortLandscape]: `calc(${SHORT_LANDSCAPE_HEIGHT} - ${KEYBOARD})`,
    },
    paddingBottom: `max(0px, calc(${safeArea.bottom} - ${KEYBOARD}))`,
    borderStartStartRadius: radii.panel,
    borderStartEndRadius: radii.panel,
    backgroundColor: surface.raised,
    boxShadow: `0 -6px 20px color-mix(in oklab, ${scrimBase.black} 18%, transparent), 0 0 0 1px color-mix(in oklab, ${neutral.n200} 80%, transparent)`,
    outlineStyle: "none",
    translate: "0 100%",
    transitionProperty: "translate, bottom",
    transitionDuration: { default: `${ENTER_EXIT_MS}ms`, [env.reducedMotion]: "0s" },
    transitionTimingFunction: DRAWER_EASE,
  },
  shown: { translate: "0 0" },
  /** Standing on something that stays usable under it, such as a dock: it clears that instead of the safe area. */
  lifted: (inset: string) => ({
    bottom: `max(${inset}, ${KEYBOARD})`,
    height: `calc(80dvh - ${inset})`,
    maxHeight: `calc(80dvh - max(${inset}, ${KEYBOARD}))`,
    paddingBottom: 0,
  }),
  /** Beside something that stays usable on its right, such as a landscape control rail. */
  beside: (inset: string) => ({ insetInlineEnd: inset }),

  handleRow: {
    display: "flex",
    justifyContent: "center",
    paddingInline: space.s4,
    paddingTop: space.s3,
    paddingBottom: space.s1,
    flexShrink: 0,
  },
  handle: {
    height: 4,
    width: 40,
    borderRadius: radii.pill,
    backgroundColor: neutral.n300,
    opacity: 0.6,
  },
  titleRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    paddingInline: space.s4,
    paddingBottom: space.s2,
    flexShrink: 0,
  },
  title: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.semibold,
    color: neutral.n800,
  },
  close: {
    display: "flex",
    height: 32,
    width: 32,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 0,
    borderRadius: radii.field,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
    color: neutral.n400,
    cursor: "pointer",
    transitionProperty: "background-color",
    transitionDuration: { default: duration.instant, [env.reducedMotion]: "0s" },
  },
  content: {
    flexGrow: 1,
    minHeight: 0,
    overflow: "hidden",
    overscrollBehavior: "contain",
  },
});

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /**
   * Required. It names the dialog *and* is what renders the close button — a
   * modal sheet without either is one a touch screen reader cannot name or
   * escape.
   */
  title: string;
  /** Shown in place of the title, such as tabs; `title` still names the dialog. */
  heading?: ReactNode;
  /**
   * Lift the sheet this far off the bottom of the screen, onto something that
   * stays usable under it (a meeting's dock). Pair with `passThrough`.
   */
  bottomInset?: string;
  /**
   * Stop this far short of the right edge of the screen, beside something that
   * stays usable (a phone's landscape control rail). Pair with `passThrough`.
   */
  endInset?: string;
  /** Presses inside what this selector matches neither close the sheet nor are swallowed. */
  passThrough?: string;
}

/** Mounted from open until the exit transition ends; `shown` drives the slide. */
function usePresence(open: boolean) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      // Two frames: the first commits the off-screen position, the second
      // starts the transition from it.
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    setShown(false);
    const timeout = setTimeout(() => setMounted(false), ENTER_EXIT_MS);
    return () => clearTimeout(timeout);
  }, [open]);
  return { mounted, shown };
}

/**
 * Lifts the sheet above the soft keyboard so a panel's input (chat, search,
 * language filter) stays reachable; panels embedded in the sheet leave the
 * keyboard to it. Touch devices only, and `offsetTop` subtracted so pinch-zoom
 * is not misread as a keyboard — the same reading as `useIOSKeyboard`.
 */
function useKeyboardInset(element: HTMLElement | null) {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!element || !viewport || !window.matchMedia?.("(pointer: coarse)").matches) return undefined;
    const update = () => {
      const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      element.style.setProperty("--sheet-keyboard-inset", `${Math.ceil(inset)}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, [element]);
}

/**
 * Escape and outside presses close the sheet. The press that dismisses also
 * swallows its click, as a modal backdrop would: a tap on "More options" to
 * close the sheet must not reopen it, and a tap on Mute must not also mute —
 * unless it lands in `passThrough`, a dock the sheet stands on and leaves usable.
 */
function useDismiss(element: HTMLElement | null, open: boolean, onClose: () => void, passThrough?: string) {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!element || !open) return undefined;
    let dismissedAt = -Infinity;
    const outside = (event: Event) =>
      event.target instanceof Node &&
      !element.contains(event.target) &&
      !(passThrough && event.target instanceof Element && event.target.closest(passThrough));
    const onPointerDown = (event: PointerEvent) => {
      if (!outside(event) || (event.pointerType === "mouse" && event.button !== 0)) return;
      dismissedAt = event.timeStamp;
      onCloseRef.current();
    };
    const onClick = (event: MouseEvent) => {
      if (!outside(event) || event.timeStamp - dismissedAt > SWALLOW_CLICK_MS) return;
      // One click per dismissing press, never the ones after it.
      dismissedAt = -Infinity;
      event.preventDefault();
      event.stopPropagation();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      // The swallow outlives the sheet by the click it is waiting for.
      setTimeout(() => document.removeEventListener("click", onClick, true), SWALLOW_CLICK_MS);
    };
  }, [element, open, passThrough]);
}

/**
 * Focus the sheet on open; on unmount give focus back to whatever had it —
 * but only if focus is still in this sheet (or nowhere). A sheet closed by
 * opening another, as the options menu does for Timeline, unmounts after the
 * next one has taken focus, and must not pull it back out.
 */
function useFocusReturn(element: HTMLElement | null) {
  useEffect(() => {
    if (!element) return undefined;
    const previous = document.activeElement;
    element.focus({ preventScroll: true });
    return () => {
      const current = document.activeElement;
      const focusIsOurs = current === null || current === document.body || element.contains(current);
      if (focusIsOurs && previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [element]);
}

export function BottomSheet({
  open,
  onClose,
  children,
  title,
  heading,
  bottomInset,
  endInset,
  passThrough,
}: BottomSheetProps) {
  const { mounted, shown } = usePresence(open);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const titleId = useId();
  useKeyboardInset(element);
  useDismiss(element, open, onClose, passThrough);
  useFocusReturn(element);

  if (!mounted || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={setElement}
      role="dialog"
      aria-modal="true"
      aria-labelledby={heading ? undefined : titleId}
      aria-label={heading ? title : undefined}
      tabIndex={-1}
      data-open={open ? "" : undefined}
      {...stylex.props(
        styles.sheet,
        shown && styles.shown,
        bottomInset !== undefined && styles.lifted(bottomInset),
        endInset !== undefined && styles.beside(endInset),
      )}
    >
      <div {...stylex.props(styles.handleRow)}>
        <div {...stylex.props(styles.handle)} />
      </div>
      <div {...stylex.props(styles.titleRow)}>
        {heading ?? (
          <h2 id={titleId} {...stylex.props(styles.title)}>
            {title}
          </h2>
        )}
        <button type="button" aria-label="Close" onClick={onClose} {...stylex.props(styles.close)}>
          <X size={16} />
        </button>
      </div>
      <div {...stylex.props(styles.content)}>{children}</div>
    </div>,
    document.body,
  );
}
