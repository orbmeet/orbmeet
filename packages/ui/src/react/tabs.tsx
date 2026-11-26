import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import type { ComponentProps, ReactNode } from "react";

import { accent, neutral } from "../tokens/colors.stylex";
import { bp, env } from "../tokens/media.stylex";
import { duration, easing } from "../tokens/motion.stylex";
import { space } from "../tokens/space.stylex";
import { leading, text, weight } from "../tokens/typography.stylex";

const ACTIVE = ":is([data-active])";

/**
 * A strip wider than the screen. It scrolls sideways, bleeds to the page edge
 * on a phone, and dissolves at its trailing edge so a clipped tab reads as
 * "there is more" rather than as a layout bug. The trailing padding lets the
 * last tab scroll clear of the fade.
 */
const scroll = stylex.create({
  strip: {
    overflowX: "auto",
    overflowY: "hidden",
    scrollbarWidth: "none",
    "::-webkit-scrollbar": { display: "none" },
    marginInline: { default: `calc(-1 * ${space.s4})`, [bp.sm]: 0 },
    paddingInlineStart: { default: space.s4, [bp.sm]: 0 },
    paddingInlineEnd: { default: space.s10, [bp.sm]: 0 },
    maskImage: {
      default: `linear-gradient(to right, black calc(100% - ${space.s10}), transparent)`,
      [bp.sm]: "none",
    },
  },
});

const styles = stylex.create({
  list: {
    display: "flex",
    // On a phone the triggers' own padding is the spacing: a space's five tabs fit.
    gap: { default: 0, [bp.sm]: space.s1 },
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: neutral.n200,
  },
  trigger: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s1_5,
    whiteSpace: "nowrap",
    borderWidth: 0,
    borderStyle: "solid",
    borderColor: "transparent",
    borderBottomWidth: 2,
    borderBottomColor: { default: "transparent", [ACTIVE]: accent.a600 },
    backgroundColor: "transparent",
    paddingInline: { default: space.s3, [bp.sm]: space.s4 },
    paddingBlock: space.s2_5,
    fontFamily: "inherit",
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, ":hover": neutral.n700 }, [ACTIVE]: accent.a700 },
    cursor: "pointer",
    userSelect: "none",
    transitionProperty: "color, background-color, border-color, box-shadow",
    transitionDuration: { default: duration.instant, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
  panel: { paddingTop: space.s6 },
});

type Styled<T> = Omit<T, "className" | "style"> & { sx?: StyleXStyles };

/**
 * Everything `Tabs.Root` accepts, except that `value` is narrowed to the string
 * ids this app uses and `onValueChange` hands back a plain string. `orientation`
 * and the rest stay reachable — narrowing them away is what pushed the settings
 * page off the wrapper and onto raw `Tabs` parts.
 */
type TabsProps = Omit<
  ComponentProps<typeof BaseTabs.Root>,
  "value" | "defaultValue" | "onValueChange"
> & {
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  children: ReactNode;
};

export function Tabs({ defaultValue, value, onValueChange, children, ...props }: TabsProps) {
  return (
    <BaseTabs.Root
      {...props}
      defaultValue={defaultValue}
      value={value}
      onValueChange={
        onValueChange
          ? (newValue: string | number | null) => {
              if (newValue !== null) onValueChange(String(newValue));
            }
          : undefined
      }
    >
      {children}
    </BaseTabs.Root>
  );
}

export function TabsList({
  scrollable = false,
  children,
  sx,
  ...props
}: Styled<ComponentProps<typeof BaseTabs.List>> & {
  /** Let the strip scroll sideways on a phone instead of wrapping or clipping. */
  scrollable?: boolean;
}) {
  return (
    <BaseTabs.List
      {...props}
      {...stylex.props(styles.list, scrollable ? scroll.strip : null, sx)}
    >
      {children}
    </BaseTabs.List>
  );
}

export function TabsTrigger({
  children,
  sx,
  ...props
}: Styled<ComponentProps<typeof BaseTabs.Tab>>) {
  return (
    <BaseTabs.Tab {...props} {...stylex.props(styles.trigger, sx)}>
      {children}
    </BaseTabs.Tab>
  );
}

export function TabsContent({
  children,
  sx,
  ...props
}: Styled<ComponentProps<typeof BaseTabs.Panel>>) {
  return (
    <BaseTabs.Panel {...props} {...stylex.props(styles.panel, sx)}>
      {children}
    </BaseTabs.Panel>
  );
}
