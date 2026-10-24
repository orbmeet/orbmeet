import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import { Children, type ReactNode } from "react";

import { space } from "../tokens/space.stylex";

/** The room one "·" takes, which is also the space between two items. */
const DOT = "1.4em";

const styles = stylex.create({
  // Clipped sideways only, so a face's ring above or below an item still shows.
  clip: { display: "block", minWidth: 0, overflowX: "clip" },
  list: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    rowGap: space.s1,
    marginInlineStart: `calc(-1 * ${DOT})`,
  },
  item: { display: "inline-flex", alignItems: "center", minWidth: 0 },
  dot: { display: "inline-block", flexShrink: 0, width: DOT, textAlign: "center" },
});

/**
 * A line of short facts — a time, a length, a place — with a "·" between
 * them, that wraps without stranding a dot at the end of a line.
 *
 * Each item carries the dot before it, and the list is pulled back by one
 * dot's width inside a box that clips sideways: whichever item starts a line,
 * the first or one that wrapped, has its dot clipped away. Empty children
 * (`null`, `false`) are skipped, so optional facts need no dot bookkeeping.
 */
export function DotList({ children, sx }: { children: ReactNode; sx?: StyleXStyles }) {
  const items = Children.toArray(children);
  return (
    <span {...stylex.props(styles.clip, sx)}>
      <span {...stylex.props(styles.list)}>
        {items.map((item, index) => (
          <span key={index} {...stylex.props(styles.item)}>
            <span aria-hidden="true" {...stylex.props(styles.dot)}>·</span>
            {item}
          </span>
        ))}
      </span>
    </span>
  );
}
