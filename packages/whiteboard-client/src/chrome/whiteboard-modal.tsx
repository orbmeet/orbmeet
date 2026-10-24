import { boardZIndex } from "@orbmeet/ui/tokens/layers.stylex";
import { ink, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import { scrim } from "@orbmeet/ui/tokens/wash.stylex";
import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

const styles = stylex.create({
  backdrop: {
    pointerEvents: "auto",
    position: "absolute",
    inset: 0,
    zIndex: boardZIndex.modal,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: scrim.wash,
  },
  dialog: {
    marginInline: space.s4,
    // `max-w-sm`: the dialog is a confirmation, not a form.
    maxWidth: "24rem",
    borderRadius: radii.card,
    backgroundColor: surface.raised,
    padding: space.s6,
    boxShadow: shadows.elevated,
    outlineStyle: "none",
  },
  title: {
    margin: 0,
    fontSize: text.lg,
    lineHeight: leading.lg,
    fontWeight: weight.semibold,
    color: ink.strong,
  },
  description: {
    marginTop: space.s2,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: ink.muted,
  },
});

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

interface WhiteboardModalProps {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  onDismiss: () => void;
  alert?: boolean;
  sx?: StyleXStyles;
}

export function WhiteboardModal({
  title,
  description,
  children,
  onDismiss,
  alert = false,
  sx,
}: WhiteboardModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const dismissFromEffect = useEffectEvent(onDismiss);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusFirstControl = () => {
      const firstControl = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).find((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      (firstControl ?? dialog).focus();
    };
    focusFirstControl();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissFromEffect();
        return;
      }
      if (event.key !== "Tab") return;

      const controls = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      if (controls.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) {
        focusFirstControl();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  const handleBackdropPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onDismiss();
  };

  return (
    <div {...stylex.props(styles.backdrop)} onPointerDown={handleBackdropPointerDown}>
      <div
        ref={dialogRef}
        role={alert ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        {...stylex.props(styles.dialog, sx)}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <h3 id={titleId} {...stylex.props(styles.title)}>
          {title}
        </h3>
        {description && (
          <div id={descriptionId} {...stylex.props(styles.description)}>
            {description}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
