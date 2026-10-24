import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import type { ComponentProps, ReactNode } from "react";

import { accent, neutral, surface } from "../tokens/colors.stylex";
import { bp, env } from "../tokens/media.stylex";
import { duration, easing } from "../tokens/motion.stylex";
import { radii } from "../tokens/radii.stylex";
import { space } from "../tokens/space.stylex";
import { leading, text, weight } from "../tokens/typography.stylex";
import { inkWash } from "../tokens/wash.stylex";

const ACTIVE = ":is([data-active])";

const lists = stylex.create({
  underline: {
    display: "flex",
    // On a phone the triggers' own padding is the spacing: a space's five tabs fit.
    gap: { default: 0, [bp.sm]: space.s1 },
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: neutral.n200,
  },
  pill: {
    display: "inline-flex",
    gap: space.s1,
    borderRadius: radii.field,
    backgroundColor: neutral.n100,
    padding: space.s1,
  },
  enclosed: {
    display: "flex",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: neutral.n200,
  },
  /** Pair with `<TabsIndicator>`: the triggers carry no underline of their own. */
  sliding: {
    position: "relative",
    display: "flex",
    gap: space.s1,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: neutral.n200,
  },
  /**
   * Contributes nothing, for tab strips whose layout is entirely bespoke (the
   * grouped settings rail). Going through the wrapper still buys the roving
   * tabindex, the tablist/tabpanel wiring, and one place to fix them.
   */
  plain: {},
});

const triggerBase = stylex.create({
  /**
   * What every trigger needs to stop being a native `<button>`: no UA border,
   * no UA fill, the page's font. Applied to `plain` too — leaving it off is how
   * the settings rail grew a 2px outset border on every item.
   */
  reset: {
    borderWidth: 0,
    borderStyle: "solid",
    borderColor: "transparent",
    backgroundColor: "transparent",
    fontFamily: "inherit",
    color: "inherit",
    cursor: "pointer",
    userSelect: "none",
  },
  base: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s1_5,
    whiteSpace: "nowrap",
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    transitionProperty: "color, background-color, border-color, box-shadow",
    transitionDuration: { default: duration.instant, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
});

const triggers = stylex.create({
  underline: {
    borderBottomWidth: 2,
    borderBottomStyle: "solid",
    borderBottomColor: { default: "transparent", [ACTIVE]: accent.a600 },
    paddingInline: { default: space.s3, [bp.sm]: space.s4 },
    paddingBlock: space.s2_5,
    color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, ":hover": neutral.n700 }, [ACTIVE]: accent.a700 },
  },
  pill: {
    borderRadius: radii.field,
    paddingInline: space.s3,
    paddingBlock: space.s1_5,
    color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, ":hover": neutral.n700 }, [ACTIVE]: neutral.n900 },
    backgroundColor: { default: "transparent", [ACTIVE]: surface.raised },
    boxShadow: { default: "none", [ACTIVE]: `0 1px 2px ${inkWash.x06}` },
  },
  enclosed: {
    borderBottomWidth: 2,
    borderBottomStyle: "solid",
    borderBottomColor: { default: "transparent", [ACTIVE]: accent.a600 },
    borderStartStartRadius: radii.field,
    borderStartEndRadius: radii.field,
    paddingInline: space.s4,
    paddingBlock: space.s2_5,
    color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, ":hover": neutral.n700 }, [ACTIVE]: accent.a700 },
    backgroundColor: {
      default: "transparent",
      [env.hoverable]: { default: "transparent", ":hover": neutral.n50 },
      [ACTIVE]: `color-mix(in oklab, ${accent.a50} 50%, transparent)`,
    },
  },
  sliding: {
    paddingInline: space.s4,
    paddingBlock: space.s2_5,
    color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, ":hover": neutral.n700 }, [ACTIVE]: accent.a700 },
  },
  plain: {},
});

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
  panel: { paddingTop: space.s6 },
  /**
   * The sliding underline. Base UI publishes the active tab's geometry as
   * `--active-tab-width` / `--active-tab-left`, so the bar is one element that
   * travels rather than a border on each trigger that blinks.
   */
  indicator: {
    position: "absolute",
    bottom: 0,
    left: 0,
    height: 2,
    width: "var(--active-tab-width)",
    transform: "translateX(var(--active-tab-left))",
    backgroundColor: accent.a600,
    transitionProperty: "transform, width",
    transitionDuration: { default: duration.base, [env.reducedMotion]: "0s" },
    transitionTimingFunction: "ease-in-out",
  },
});

type TabsVariant = keyof typeof lists;
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
  variant = "underline",
  scrollable = false,
  children,
  sx,
  ...props
}: Styled<ComponentProps<typeof BaseTabs.List>> & {
  variant?: TabsVariant;
  /** Let the strip scroll sideways on a phone instead of wrapping or clipping. */
  scrollable?: boolean;
}) {
  return (
    <BaseTabs.List
      {...props}
      {...stylex.props(lists[variant], scrollable ? scroll.strip : null, sx)}
    >
      {children}
    </BaseTabs.List>
  );
}

export function TabsTrigger({
  variant = "underline",
  children,
  sx,
  ...props
}: Styled<ComponentProps<typeof BaseTabs.Tab>> & { variant?: TabsVariant }) {
  return (
    <BaseTabs.Tab
      {...props}
      {...stylex.props(
        triggerBase.reset,
        variant === "plain" ? null : triggerBase.base,
        triggers[variant],
        sx,
      )}
    >
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

/**
 * A sliding animated underline. Use it with `variant="sliding"` on both
 * `TabsList` and `TabsTrigger` — that variant omits the per-trigger border so
 * the two indicators don't stack on top of each other.
 */
export function TabsIndicator({
  sx,
  ...props
}: Styled<ComponentProps<typeof BaseTabs.Indicator>>) {
  return <BaseTabs.Indicator {...props} {...stylex.props(styles.indicator, sx)} />;
}
