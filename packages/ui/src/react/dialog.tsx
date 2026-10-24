import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import type { ComponentProps } from "react";

import { blur } from "../styles/surfaces";
import { accent, ink, neutral, surface } from "../tokens/colors.stylex";
import { zIndex } from "../tokens/layers.stylex";
import { bp, env } from "../tokens/media.stylex";
import { duration, easing } from "../tokens/motion.stylex";
import { radii } from "../tokens/radii.stylex";
import { shadows } from "../tokens/shadows.stylex";
import { space } from "../tokens/space.stylex";
import { leading, text, weight } from "../tokens/typography.stylex";
import { scrim } from "../tokens/wash.stylex";

/**
 * Base UI drives its enter/exit transitions through `data-starting-style` and
 * `data-ending-style` attributes on the element. StyleX can target those
 * directly, which is a real simplification over the class-string wrapper this
 * replaces: the transition is declared next to the property it animates
 * instead of as four separate utility strings that had to agree with each
 * other.
 */
const STARTING = ":is([data-starting-style])";
const ENDING = ":is([data-ending-style])";

const styles = stylex.create({
  backdrop: {
    position: "fixed",
    inset: 0,
    minHeight: "100dvh",
    zIndex: zIndex.modal,
    backgroundColor: scrim.wash,
    opacity: { default: 1, [STARTING]: 0, [ENDING]: 0 },
    transitionProperty: "opacity",
    transitionDuration: { default: duration.base, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },

  /**
   * The positioning layer: bottom-anchored on a phone (so a dialog reads as a
   * sheet) and centred once there is room.
   *
   * `justify-content` is `center` at both steps rather than `stretch` below
   * `sm`. `stretch` looks like it would fill the inline axis, but the CSS Box
   * Alignment spec defines it as behaving like `flex-start` in a flex
   * container — it only stretches in grid and block layouts. Below `sm` the
   * sheet is full-bleed (see `styles.width`), so there is no free space for
   * `center` to distribute and the two agree; above `sm` `center` is the
   * intent, and was already spelled that way.
   */
  viewport: {
    position: "fixed",
    inset: 0,
    zIndex: zIndex.modal,
    display: "flex",
    alignItems: { default: "flex-end", [bp.sm]: "center" },
    justifyContent: "center",
  },

  /**
   * The popup never scrolls. It is a bounded flex column, so `DialogHeader` and
   * `DialogFooter` stay pinned while `DialogBody` takes the overflow. A
   * scrolling popup would carry its own header and footer out of the viewport,
   * and its `position: relative` + `overflow` pair would clip any absolutely
   * positioned descendant.
   */
  popup: {
    position: "relative",
    display: "flex",
    minHeight: 0,
    flexDirection: "column",
    overflow: "hidden",
    backgroundColor: surface.raised,
    boxShadow: shadows.elevated,
    borderStartStartRadius: radii.panel,
    borderStartEndRadius: radii.panel,
    borderEndStartRadius: { default: 0, [bp.sm]: radii.panel },
    borderEndEndRadius: { default: 0, [bp.sm]: radii.panel },
    maxHeight: { default: "85vh", [bp.sm]: "calc(100vh - 4rem)" },
    outlineWidth: { default: 0, ":focus-visible": 2 },
    outlineStyle: "solid",
    outlineColor: accent.a500,
    outlineOffset: 2,

    opacity: { default: 1, [STARTING]: 0, [ENDING]: 0 },
    scale: { default: 1, [STARTING]: 0.95, [ENDING]: 0.95 },
    transitionProperty: "opacity, scale",
    transitionDuration: { default: duration.base, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.gentle,
  },

  /**
   * Width is a function of the `size` step and the viewport, hence dynamic.
   * It owns the property outright — StyleX merges a property's conditional
   * variants as one unit, so a `width` on `popup` would be replaced by this
   * call rather than serving as its phone-step fallback.
   *
   * Below `sm` the dialog is a full-bleed bottom sheet, which is what the
   * squared bottom corners on `popup` are for; the `size` cap only applies
   * once the dialog is a centred card. Applying the cap at every step left a
   * phone showing a `calc(100vw - 2rem)` card with the whole gutter on one
   * side.
   */
  width: (maxWidth: string) => ({
    width: {
      default: "100%",
      [bp.sm]: `min(${maxWidth}, calc(100vw - 2rem))`,
    },
  }),

  header: {
    flexShrink: 0,
    paddingInline: space.s6,
    paddingTop: space.s6,
    paddingBottom: 0,
  },
  body: {
    minHeight: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    overflowY: "auto",
    paddingInline: space.s6,
    paddingBlock: space.s5,
  },
  footer: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "flex-end",
    gap: space.s3,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: neutral.n100,
    paddingInline: space.s6,
    paddingBlock: space.s4,
  },
  title: {
    margin: 0,
    fontSize: text.lg,
    lineHeight: leading.lg,
    fontWeight: weight.semibold,
    color: ink.strong,
  },
  description: {
    marginTop: space.s1,
    marginBottom: 0,
    fontSize: text.sm,
    lineHeight: leading.relaxed,
    color: ink.muted,
  },
});

/**
 * The two layouts a dialog body takes.
 *
 * A dialog either has a `DialogHeader` / `DialogBody` / `DialogFooter` split,
 * or it is a single padded block that holds its own title, prose and buttons.
 * The second shape is the more common one here, and it was being rebuilt from
 * the same three utility strings in a dozen files.
 */
export const dialogLayout = stylex.create({
  /** A body that is the whole dialog: even padding on all four sides. */
  padded: { paddingBlock: space.s6, paddingInline: space.s6 },
  /** A trailing button row, aligned to the end. */
  actions: {
    marginTop: space.s5,
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: space.s3,
  },
  /** The same row stacked, for a set of choices rather than confirm/cancel. */
  actionsStacked: {
    marginTop: space.s5,
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
  },
});

/**
 * Base UI's `Dialog.Root` surface, kept open rather than re-declared: narrowing
 * it once cost callers `modal`, `disablePointerDismissal`, `actionsRef` and
 * `onOpenChangeComplete` with no type error to point at it.
 */
type DialogProps = ComponentProps<typeof BaseDialog.Root>;

export function Dialog(props: DialogProps) {
  return <BaseDialog.Root {...props} />;
}

type DialogSize = "sm" | "md" | "lg" | "xl";

const sizeMap: Record<DialogSize, string> = {
  sm: "24rem",
  md: "28rem",
  lg: "36rem",
  xl: "48rem",
};

export function DialogContent({
  children,
  sx,
  size = "md",
  ...props
}: Omit<ComponentProps<typeof BaseDialog.Popup>, "className" | "style"> & {
  size?: DialogSize;
  sx?: StyleXStyles;
}) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop {...stylex.props(styles.backdrop, blur.sm)} />
      <BaseDialog.Viewport {...stylex.props(styles.viewport)}>
        <BaseDialog.Popup
          {...props}
          {...stylex.props(styles.popup, styles.width(sizeMap[size]), sx)}
        >
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Viewport>
    </BaseDialog.Portal>
  );
}

type SlotProps = Omit<ComponentProps<"div">, "className" | "style"> & { sx?: StyleXStyles };

export function DialogHeader({ children, sx, ...props }: SlotProps) {
  return (
    <div {...props} {...stylex.props(styles.header, sx)}>
      {children}
    </div>
  );
}

/**
 * The scrolling middle of a dialog. Everything between the header and the
 * footer belongs in here — it is the only part allowed to overflow.
 */
export function DialogBody({ children, sx, ...props }: SlotProps) {
  return (
    <div {...props} {...stylex.props(styles.body, sx)}>
      {children}
    </div>
  );
}

export function DialogFooter({ children, sx, ...props }: SlotProps) {
  return (
    <div {...props} {...stylex.props(styles.footer, sx)}>
      {children}
    </div>
  );
}

export function DialogTitle({
  children,
  sx,
  ...props
}: Omit<ComponentProps<typeof BaseDialog.Title>, "className" | "style"> & {
  sx?: StyleXStyles;
}) {
  return (
    <BaseDialog.Title {...props} {...stylex.props(styles.title, sx)}>
      {children}
    </BaseDialog.Title>
  );
}

export function DialogDescription({
  children,
  sx,
  ...props
}: Omit<ComponentProps<typeof BaseDialog.Description>, "className" | "style"> & {
  sx?: StyleXStyles;
}) {
  return (
    <BaseDialog.Description {...props} {...stylex.props(styles.description, sx)}>
      {children}
    </BaseDialog.Description>
  );
}

/**
 * Closing control. Under `modal` (the default) at least one of these has to
 * render inside the popup so touch screen readers have a way out, which is why
 * `render` is exposed: an existing Cancel button becomes a real close with no
 * visual change.
 */
export const DialogClose = BaseDialog.Close;
