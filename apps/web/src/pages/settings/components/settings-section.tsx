import { type as typeStyles } from "@orbmeet/ui/styles/atoms";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import * as stylex from "@stylexjs/stylex";
import type * as React from "react";

const styles = stylex.create({
  title: { marginTop: 0, marginBottom: space.s6 },
});

/**
 * One settings panel's heading and body. The rail beside it already carries
 * the section's icon; repeating it here as a tile was a second copy of the
 * same signpost.
 */
export function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={title.toLowerCase().replace(/\s+/g, "-")}>
      <h2 {...stylex.props(typeStyles.sectionTitle, styles.title)}>{title}</h2>
      <div>{children}</div>
    </section>
  );
}
