import { Check, Link2, UserPlus } from "lucide-react";
import { useCallback } from "react";
import * as stylex from "@stylexjs/stylex";
import { focus, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { accent, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";

/** The strip's height, which the gallery takes off the space it fits your tile into. */
export const ALONE_STRIP_HEIGHT_PX = 60;
export const ALONE_STRIP_GAP_PX = 12;

const styles = stylex.create({
  strip: {
    display: "flex",
    height: ALONE_STRIP_HEIGHT_PX,
    width: "100%",
    maxWidth: "100%",
    alignItems: "center",
    gap: space.s3,
    borderRadius: radii.card,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n150,
    backgroundColor: surface.raised,
    paddingInlineStart: space.s4,
    paddingInlineEnd: space.s2_5,
    boxShadow: shadows.card,
  },
  width: (px: number) => ({ width: px }),
  glyph: { flexShrink: 0, color: accent.a600 },
  copyText: { minWidth: 0, flexGrow: 1, margin: 0, fontSize: text.sm, color: neutral.n600 },
  lead: { fontWeight: weight.semibold, color: ink.strong },
  copy: {
    display: "inline-flex",
    height: 38,
    flexShrink: 0,
    alignItems: "center",
    gap: space.s1_5,
    borderRadius: radii.control,
    borderWidth: 0,
    paddingInline: space.s3,
    fontFamily: "inherit",
    fontSize: text.sm,
    fontWeight: weight.semibold,
    cursor: "pointer",
  },
  copyIdle: {
    color: neutral.n800,
    backgroundColor: { default: surface.raised, [env.hoverable]: { default: surface.raised, ":hover": neutral.n50 } },
    boxShadow: `inset 0 0 0 1px ${neutral.n200}`,
  },
  copyDone: {
    color: accent.a700,
    backgroundColor: accent.a50,
    boxShadow: `inset 0 0 0 1px ${accent.a200}`,
  },
  /** Below the tile on a phone the sentence has no room; the action carries it. */
  hideNarrow: { display: { default: "none", "@media (min-width: 480px)": "inline" } },
});

/**
 * What a host needs while they are the only person in the room: one line
 * under their own tile, and the link.
 *
 * It used to be a second tile the same size as the host's own — two equal
 * cards side by side, one of them a face and the other a paragraph, with the
 * meeting code printed for the third time on screen. A sentence and a button
 * is all the job needs, and it leaves the stage to the one person in it.
 */
export function MeetingAloneStrip({ widthPx }: { widthPx?: number }) {
  const { copied, copy } = useCopyToClipboard();
  const handleCopy = useCallback(() => {
    void copy(window.location.href);
  }, [copy]);

  return (
    <div {...stylex.props(styles.strip, widthPx !== undefined && styles.width(widthPx))}>
      <UserPlus size={18} strokeWidth={1.75} aria-hidden="true" {...stylex.props(styles.glyph)} />
      <p {...stylex.props(styles.copyText)}>
        <span {...stylex.props(styles.lead)}>You&rsquo;re the only one here.</span>{" "}
        <span {...stylex.props(styles.hideNarrow)}>Share the link to bring people in.</span>
      </p>
      <button
        type="button"
        onClick={handleCopy}
        {...stylex.props(pressable.base, motion.tint, focus.ring, styles.copy, copied ? styles.copyDone : styles.copyIdle)}
      >
        {copied ? <Check size={15} strokeWidth={2.25} /> : <Link2 size={15} strokeWidth={1.75} />}
        {copied ? "Link copied" : "Copy link"}
      </button>
    </div>
  );
}
