import { border, ink } from "@orbmeet/ui/tokens/colors.stylex";
import { bp } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

const styles = stylex.create({
  /** Two columns of facts on a phone, one stacked column in the desktop aside. */
  facts: {
    margin: 0,
    display: "grid",
    gridTemplateColumns: { default: "repeat(2, minmax(0, 1fr))", [bp.lg]: "minmax(0, 1fr)" },
    columnGap: space.s4,
    rowGap: space.s3,
  },
  factsRow: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    paddingBottom: { default: 0, [bp.lg]: space.s3 },
    borderBottomWidth: { default: 0, [bp.lg]: 1 },
    borderBottomStyle: "solid",
    borderBottomColor: border.subtle,
  },
  factsRowLast: { borderBottomWidth: 0, paddingBottom: 0 },
  factsLabel: { fontSize: text.xs, lineHeight: leading.xs, fontWeight: weight.medium, color: ink.muted },
  factsValue: {
    margin: 0,
    minWidth: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: ink.strong,
    overflowWrap: "anywhere",
  },
});

export interface Fact {
  label: string;
  value: ReactNode;
}

/** Label/value pairs: when, how long, who. A `<dl>`, styled once. */
export function Facts({ items }: { items: Fact[] }) {
  return (
    <dl {...stylex.props(styles.facts)}>
      {items.map((item, index) => (
        <div
          key={item.label}
          {...stylex.props(styles.factsRow, index === items.length - 1 && styles.factsRowLast)}
        >
          <dt {...stylex.props(styles.factsLabel)}>{item.label}</dt>
          <dd {...stylex.props(styles.factsValue)}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
