import { enter } from "@orbmeet/ui/styles/animations";
import { layout, type as typeStyles } from "@orbmeet/ui/styles/atoms";
import { ink } from "@orbmeet/ui/tokens/colors.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import type { ReactNode } from "react";

const styles = stylex.create({
  /** An anchor jump must not land the heading under the shell's top edge. */
  root: { scrollMarginTop: space.s6 },
  head: {
    marginBottom: space.s3,
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: space.s3,
  },
  description: {
    marginTop: space.s0_5,
    marginBottom: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: ink.muted,
  },
  title: { margin: 0 },
  action: { flexShrink: 0 },
});

interface SectionProps {
  /** Anchor target, so a section can be linked to directly. */
  id?: string;
  title: ReactNode;
  /** Optional small descriptor next to the title. */
  description?: ReactNode;
  /** Right-aligned slot, usually a "View all →" link. */
  action?: ReactNode;
  sx?: StyleXStyles;
  children: ReactNode;
}

/**
 * A titled subsection of a page. Used by Home and the Meetings lifecycle
 * groupings, so every section label carries the same weight, spacing and "→"
 * affordance instead of bespoke markup.
 */
export function Section({ id, title, description, action, sx, children }: SectionProps) {
  return (
    <section id={id} {...stylex.props(styles.root, enter.fadeUp, sx)}>
      <div {...stylex.props(styles.head)}>
        <div {...stylex.props(layout.minZero)}>
          <h2 {...stylex.props(typeStyles.sectionTitle, styles.title)}>{title}</h2>
          {description ? <p {...stylex.props(styles.description)}>{description}</p> : null}
        </div>
        {action ? <div {...stylex.props(styles.action)}>{action}</div> : null}
      </div>
      {children}
    </section>
  );
}
