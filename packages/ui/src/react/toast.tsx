import { Toast } from "@base-ui/react/toast";
import * as stylex from "@stylexjs/stylex";
import { AlertTriangle, CheckCircle, Info, X, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useMemo, useSyncExternalStore } from "react";

import { safe } from "../styles/atoms";
import { accent, danger, ink, neutral, success, surface, warning } from "../tokens/colors.stylex";
import { zIndex } from "../tokens/layers.stylex";
import { env } from "../tokens/media.stylex";
import { duration } from "../tokens/motion.stylex";
import { radii } from "../tokens/radii.stylex";
import { shadows } from "../tokens/shadows.stylex";
import { space } from "../tokens/space.stylex";
import { leading, text, weight } from "../tokens/typography.stylex";

/** Custom toast data, passed via `toast.add({ data: { … } })`. */
export interface ToastData {
  variant?: "success" | "error" | "info" | "warning";
}

/**
 * Passed to `Toast.Provider` so the auto-dismiss timer and the progress bar that
 * visualises it are driven by the same number. Reading Base UI's built-in
 * default instead would let the two drift apart the moment it changes.
 */
const DEFAULT_TOAST_TIMEOUT_MS = 5000;

const EXPANDED = ":is([data-expanded])";
const BEHIND = ":is([data-behind])";
const STARTING = ":is([data-starting-style])";
const ENDING = ":is([data-ending-style])";

/**
 * The collapsed stack. Each toast behind the front one is scaled down by its
 * index and follows the swipe in progress.
 */
const COLLAPSED =
  "translateX(var(--toast-swipe-movement-x, 0px)) translateY(var(--toast-swipe-movement-y, 0px)) scale(calc(1 - var(--toast-index, 0) * 0.05))";

/**
 * The fanned stack, shown while the viewport is hovered or focused: each toast
 * rises to its own row with a 0.75rem gap between them.
 */
const FANNED =
  "translateX(var(--toast-swipe-movement-x, 0px)) translateY(calc(var(--toast-offset-y, 0px) * -1 + (var(--toast-index, 0) * -0.75rem) + var(--toast-swipe-movement-y, 0px)))";

/**
 * Exit transforms. A toast that was flicked leaves in the direction of the
 * flick; one dismissed any other way leaves to the right.
 */
const exitTo = (axis: "X" | "Y", sign: "+" | "-") =>
  `translate${axis}(calc(var(--toast-swipe-movement-${axis.toLowerCase()}, 0px) ${sign} 150%))`;

const styles = stylex.create({
  viewport: {
    position: "fixed",
    bottom: space.s4,
    right: space.s4,
    zIndex: zIndex.toast,
    display: "flex",
    width: 320,
    maxWidth: "calc(100vw - 2rem)",
    flexDirection: "column",
  },
  /** Clears a row of floating controls along the bottom edge (a board's pager
      and zoom) that a toast would otherwise sit on. */
  viewportLifted: { bottom: space.s20 },

  root: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: "100%",
    transformOrigin: "bottom",
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    backgroundColor: surface.raised,
    boxShadow: shadows.elevated,
    userSelect: "none",
    // Index 0 is frontmost.
    zIndex: "calc(1000 - var(--toast-index, 0))",

    transform: {
      default: COLLAPSED,
      [EXPANDED]: FANNED,
      [STARTING]: "translateX(100%)",
      // The default exit, for a toast that was not swiped away.
      ":is([data-ending-style]:not([data-swipe-direction]))": "translateX(100%)",
      // `exitTo` folds to a string literal at build time; the rule cannot see
      // through the call.
      // oxlint-disable-next-line @stylexjs/valid-styles
      ":is([data-ending-style][data-swipe-direction='right'])": exitTo("X", "+"),
      // oxlint-disable-next-line @stylexjs/valid-styles
      ":is([data-ending-style][data-swipe-direction='left'])": exitTo("X", "-"),
      // oxlint-disable-next-line @stylexjs/valid-styles
      ":is([data-ending-style][data-swipe-direction='up'])": exitTo("Y", "-"),
      // oxlint-disable-next-line @stylexjs/valid-styles
      ":is([data-ending-style][data-swipe-direction='down'])": exitTo("Y", "+"),
    },
    opacity: {
      default: 1,
      [STARTING]: 0,
      [ENDING]: 0,
      // Hidden when the toast count exceeds the limit.
      ":is([data-limited])": 0,
    },
    transitionProperty: "transform, opacity",
    transitionDuration: { default: "300ms", [env.reducedMotion]: "0s" },
    transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",

    /**
     * Bridges the 0.75rem fan gap so the pointer never leaves the stack while
     * travelling between two expanded toasts, which would collapse it.
     *
     * Only while expanded: collapsed there is no gap, and the strip would sit
     * over the page swallowing clicks. That is also why the rounding that clips
     * the progress bar lives on `Toast.Content` rather than here — this element
     * has to let the bridge escape its own box.
     */
    "::after": {
      content: "",
      position: "absolute",
      top: "100%",
      left: 0,
      width: "100%",
      height: "calc(0.75rem + 1px)",
      display: { default: "none", [EXPANDED]: "block" },
    },
  },

  content: {
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    borderRadius: "inherit",
    opacity: { default: 1, [BEHIND]: 0, [EXPANDED]: 1 },
    pointerEvents: { default: "auto", [BEHIND]: "none" },
    transitionProperty: "opacity",
    transitionDuration: { default: "250ms", [env.reducedMotion]: "0s" },
  },
  row: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s3,
    padding: space.s4,
  },
  body: { minWidth: 0, flexGrow: 1 },
  title: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    color: ink.strong,
  },
  description: {
    marginTop: space.s0_5,
    marginBottom: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: ink.muted,
  },
  action: {
    marginTop: space.s2,
    borderWidth: 0,
    backgroundColor: "transparent",
    fontFamily: "inherit",
    fontSize: text.sm,
    fontWeight: weight.medium,
    color: accent.a700,
    cursor: "pointer",
    textDecorationLine: { default: "none", [env.hoverable]: { default: "none", ":hover": "underline" } },
    textUnderlineOffset: 2,
    outlineColor: { default: "transparent", ":focus-visible": accent.a500 },
    outlineStyle: "solid",
    outlineWidth: 2,
    outlineOffset: 2,
  },
  close: {
    flexShrink: 0,
    borderWidth: 0,
    borderRadius: radii.field,
    backgroundColor: "transparent",
    padding: space.s0_5,
    color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, ":hover": neutral.n600 } },
    cursor: "pointer",
    transitionProperty: "color",
    transitionDuration: { default: duration.instant, [env.reducedMotion]: "0s" },
  },

  /**
   * The auto-dismiss progress bar.
   *
   * Hidden entirely under reduced motion rather than shown drained: a bar that
   * cannot animate is a bar that says the toast has already expired.
   */
  track: {
    height: 2,
    width: "100%",
    backgroundColor: neutral.n100,
    display: { default: "block", [env.reducedMotion]: "none" },
  },
  fill: {
    height: "100%",
    width: "100%",
    animationName: stylex.keyframes({ from: { width: "100%" }, to: { width: "0%" } }),
    animationTimingFunction: "linear",
    animationFillMode: "forwards",
    // Base UI pauses the real timer while the viewport is hovered or focused;
    // the ancestor marker on `Toast.Root` is how this bar sees that.
    animationPlayState: {
      default: "running",
      [stylex.when.ancestor(EXPANDED)]: "paused",
    },
  },
  fillTiming: (ms: number) => ({ animationDuration: `${ms}ms` }),
  fillPaused: { animationPlayState: "paused" },
});

const fills = stylex.create({
  success: { backgroundColor: success.s500 },
  error: { backgroundColor: danger.d500 },
  info: { backgroundColor: accent.a600 },
  warning: { backgroundColor: warning.w500 },
  none: { backgroundColor: accent.a600 },
});

const iconTones = stylex.create({
  success: { color: success.s500 },
  error: { color: danger.d500 },
  info: { color: accent.a600 },
  warning: { color: warning.w500 },
});

const icons = {
  success: CheckCircle,
  error: XCircle,
  info: Info,
  warning: AlertTriangle,
} as const;

export function ToastProvider({
  children,
  liftAboveBottomControls = false,
}: {
  children: ReactNode;
  liftAboveBottomControls?: boolean;
}) {
  return (
    <Toast.Provider timeout={DEFAULT_TOAST_TIMEOUT_MS}>
      {children}
      <Toast.Portal>
        <Toast.Viewport
          {...stylex.props(
            styles.viewport,
            liftAboveBottomControls && styles.viewportLifted,
            safe.padBottom,
            safe.padRight,
          )}
        >
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function subscribeToWindowFocus(onChange: () => void) {
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  return () => {
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
  };
}

/**
 * Base UI pauses a toast's dismiss timer whenever the viewport is hovered or
 * focused *or the window is blurred* (`hovering || focused || !isWindowFocused`).
 * Only the first two surface as `data-expanded`, so the progress bar has to
 * watch the window itself — otherwise switching tabs and back leaves a drained
 * bar above a toast that is still counting down.
 */
function useWindowFocused(): boolean {
  return useSyncExternalStore(subscribeToWindowFocus, () => document.hasFocus(), () => true);
}

function ToastList() {
  const { toasts } = Toast.useToastManager<ToastData>();
  const windowFocused = useWindowFocused();

  return toasts.map((toast) => {
    const variant = toast.data?.variant;
    const Icon = variant ? icons[variant] : null;

    // Base UI only schedules a dismiss timer when the resolved timeout is above
    // zero and the toast isn't a pending `loading` one. A bar on either would
    // drain instantly and then sit empty over a toast that never leaves.
    const timeout = toast.timeout ?? DEFAULT_TOAST_TIMEOUT_MS;
    const autoDismisses = timeout > 0 && toast.type !== "loading";

    return (
      <Toast.Root
        key={toast.id}
        toast={toast}
        {...stylex.props(styles.root, stylex.defaultMarker())}
      >
        <Toast.Content {...stylex.props(styles.content)}>
          <div {...stylex.props(styles.row)}>
            {Icon && variant && <Icon size={20} {...stylex.props(iconTones[variant])} />}
            <div {...stylex.props(styles.body)}>
              <Toast.Title {...stylex.props(styles.title)} />
              <Toast.Description {...stylex.props(styles.description)} />
              {/* Renders nothing unless the toast was added with `actionProps`.
                  Going through the real part is what wires the dismiss handling
                  and the button labelling. */}
              <Toast.Action {...stylex.props(styles.action)} />
            </div>
            <Toast.Close aria-label="Close" {...stylex.props(styles.close)}>
              <X size={16} />
            </Toast.Close>
          </div>
          {autoDismisses && (
            <div {...stylex.props(styles.track)}>
              <div
                {...stylex.props(
                  styles.fill,
                  styles.fillTiming(timeout),
                  fills[variant ?? "none"],
                  !windowFocused && styles.fillPaused,
                )}
              />
            </div>
          )}
        </Toast.Content>
      </Toast.Root>
    );
  });
}

/**
 * Toasts announce politely by default, which queues a failure behind whatever
 * notices are already in flight. Anything marked `variant: "error"` is raised to
 * `priority: "high"` unless the caller says otherwise, so it interrupts.
 */
export function useToast() {
  const manager = Toast.useToastManager<ToastData>();
  const { add } = manager;

  const addWithPriority = useCallback<typeof add>(
    (options) =>
      add(
        options.data?.variant === "error" && options.priority === undefined
          ? { ...options, priority: "high" }
          : options,
      ),
    [add],
  );

  return useMemo(() => ({ ...manager, add: addWithPriority }), [manager, addWithPriority]);
}
