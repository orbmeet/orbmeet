import { progress } from "@orbmeet/ui/styles/animations";
import { layout, motion } from "@orbmeet/ui/styles/atoms";
import { blur } from "@orbmeet/ui/styles/surfaces";
import { accent, ink, neutral } from "@orbmeet/ui/tokens/colors.stylex";
import { boardZIndex } from "@orbmeet/ui/tokens/layers.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";

import type { WhiteboardUploadItem } from "./use-whiteboard-document-assets";
import { glass, scrimBase } from "@orbmeet/ui/tokens/wash.stylex";

const styles = stylex.create({
  /**
   * A stack of chips in the corner of the board. Never a hit target: an upload
   * in flight is something to watch, not something to press, and the canvas
   * underneath must stay drawable while it happens.
   */
  stack: {
    position: "absolute",
    bottom: space.s20,
    left: space.s4,
    zIndex: boardZIndex.panel,
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
    pointerEvents: "none",
  },
  chip: {
    width: 192,
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: `color-mix(in oklab, ${scrimBase.black} 6%, transparent)`,
    backgroundColor: glass.solid,
    paddingInline: space.s3,
    paddingBlock: space.s2,
    boxShadow: `0 1px 2px color-mix(in oklab, ${ink.strong} 5%, transparent)`,
  },
  head: {
    marginBottom: space.s1_5,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s2,
  },
  name: { fontSize: text.xs, lineHeight: leading.xs, color: neutral.n600 },
  percent: {
    flexShrink: 0,
    // Tabular figures so the number does not jitter sideways as it counts up.
    fontVariantNumeric: "tabular-nums",
    fontSize: text.xs2,
    lineHeight: leading.xs2,
    color: ink.muted,
  },
  track: {
    height: 4,
    overflow: "hidden",
    borderRadius: radii.pill,
    backgroundColor: neutral.n100,
  },
  fill: { height: "100%", borderRadius: radii.pill, backgroundColor: accent.a500 },
  /** No byte count yet: a breathing stub rather than a bar claiming 0%. */
  indeterminate: { width: "40%", backgroundColor: accent.a400 },
  done: { backgroundColor: accent.a600 },
  width: (percent: number) => ({ width: `${percent}%` }),
});

interface WhiteboardUploadProgressProps {
  uploads: WhiteboardUploadItem[];
}

export function WhiteboardUploadProgress({ uploads }: WhiteboardUploadProgressProps) {
  if (uploads.length === 0) return null;

  return (
    <div {...stylex.props(styles.stack, layout.decorative)}>
      {uploads.map((upload) => (
        <div key={upload.id} {...stylex.props(styles.chip, blur.sm)}>
          <div {...stylex.props(styles.head)}>
            <span {...stylex.props(styles.name, layout.truncate)}>
              {upload.name.length > 22 ? `${upload.name.slice(0, 20)}…` : upload.name}
            </span>
            <span {...stylex.props(styles.percent)}>
              {upload.progress == null ? "…" : `${upload.progress}%`}
            </span>
          </div>
          <div {...stylex.props(styles.track)}>
            {upload.progress == null ? (
              <div {...stylex.props(styles.fill, styles.indeterminate, progress.pulse)} />
            ) : (
              <div
                {...stylex.props(
                  styles.fill,
                  motion.move,
                  styles.width(upload.progress),
                  upload.progress === 100 && styles.done,
                )}
              />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
