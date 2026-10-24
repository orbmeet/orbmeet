import { Menu as BaseMenu } from "@base-ui/react/menu";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import type { ComponentProps } from "react";

import { blur } from "../styles/surfaces";
import { border, neutral, surface } from "../tokens/colors.stylex";
import { zIndex } from "../tokens/layers.stylex";
import { env } from "../tokens/media.stylex";
import { duration, easing } from "../tokens/motion.stylex";
import { radii } from "../tokens/radii.stylex";
import { shadows } from "../tokens/shadows.stylex";
import { space } from "../tokens/space.stylex";
import { leading, text, weight } from "../tokens/typography.stylex";
import { glass } from "../tokens/wash.stylex";

const STARTING = ":is([data-starting-style])";
const ENDING = ":is([data-ending-style])";
const HIGHLIGHTED = ":is([data-highlighted])";
const DISABLED = ":is([data-disabled])";

const styles = stylex.create({
  positioner: { zIndex: zIndex.popover, outlineStyle: "none" },
  popup: {
    minWidth: 160,
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: `color-mix(in oklab, ${border.base} 80%, transparent)`,
    backgroundColor: glass.opaque,
    padding: space.s1_5,
    boxShadow: shadows.elevated,
    outlineStyle: "none",
    transformOrigin: "var(--transform-origin)",
    opacity: { default: 1, [STARTING]: 0, [ENDING]: 0 },
    scale: { default: 1, [STARTING]: 0.95, [ENDING]: 0.95 },
    transitionProperty: "opacity, scale",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.gentle,
  },

  /**
   * One item body, two layouts.
   *
   * `item` is a flex row; `checkable` is a two-column grid whose first column
   * is the indicator gutter, so a checked and an unchecked row have their
   * labels on the same vertical line. Everything else about them is identical,
   * which is why they share `itemBase` instead of being two strings that had
   * to be kept in step by hand.
   */
  itemBase: {
    width: "100%",
    alignItems: "center",
    borderRadius: radii.field,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: { default: neutral.n600, [HIGHLIGHTED]: neutral.n900 },
    backgroundColor: { default: "transparent", [HIGHLIGHTED]: `color-mix(in oklab, ${surface.sunken} 80%, transparent)` },
    outlineStyle: "none",
    userSelect: "none",
    cursor: { default: "default", [DISABLED]: "not-allowed" },
    opacity: { default: 1, [DISABLED]: 0.5 },
    textDecorationLine: "none",
    transitionProperty: "color, background-color",
    transitionDuration: { default: duration.instant, [env.reducedMotion]: "0s" },
  },
  item: {
    display: "flex",
    gap: space.s3,
    paddingInline: space.s3,
    paddingBlock: space.s2,
  },

  separator: {
    marginBlock: space.s1,
    marginInline: space.s2,
    height: 1,
    backgroundColor: neutral.n100,
    borderWidth: 0,
  },
  groupLabel: {
    paddingInline: space.s3,
    paddingBlock: space.s1_5,
    fontSize: text.xs,
    lineHeight: leading.xs,
    fontWeight: weight.medium,
    color: neutral.n500,
    userSelect: "none",
  },
});

export const MenuRoot = BaseMenu.Root;
export const MenuTrigger = BaseMenu.Trigger;
export const MenuGroup = BaseMenu.Group;

type Styled<T> = Omit<T, "className" | "style"> & { sx?: StyleXStyles };

export function MenuContent({
  children,
  sx,
  side = "bottom",
  align = "end",
  sideOffset = 8,
  ...props
}: Styled<ComponentProps<typeof BaseMenu.Popup>> & {
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  sideOffset?: number;
}) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        positionMethod="fixed"
        collisionPadding={12}
        collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
        {...stylex.props(styles.positioner)}
      >
        <BaseMenu.Popup {...props} {...stylex.props(styles.popup, blur.xl, sx)}>
          {children}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

export function MenuItem({
  children,
  sx,
  ...props
}: Styled<ComponentProps<typeof BaseMenu.Item>>) {
  return (
    <BaseMenu.Item {...props} {...stylex.props(styles.itemBase, styles.item, sx)}>
      {children}
    </BaseMenu.Item>
  );
}

export function MenuLinkItem({
  children,
  sx,
  closeOnClick = true,
  ...props
}: Styled<ComponentProps<typeof BaseMenu.LinkItem>>) {
  return (
    <BaseMenu.LinkItem {...props} closeOnClick={closeOnClick} {...stylex.props(styles.itemBase, styles.item, sx)}>
      {children}
    </BaseMenu.LinkItem>
  );
}

export function MenuSeparator({
  sx,
  ...props
}: Styled<ComponentProps<typeof BaseMenu.Separator>>) {
  return <BaseMenu.Separator {...props} {...stylex.props(styles.separator, sx)} />;
}

export function MenuGroupLabel({
  children,
  sx,
  ...props
}: Styled<ComponentProps<typeof BaseMenu.GroupLabel>>) {
  return (
    <BaseMenu.GroupLabel {...props} {...stylex.props(styles.groupLabel, sx)}>
      {children}
    </BaseMenu.GroupLabel>
  );
}
