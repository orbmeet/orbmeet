import { presence } from "@orbmeet/ui/styles/animations";
import { accent, live } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";

/**
 * "Open" and "Live" are different facts: a room can be open with nobody in
 * it. The accent tint says the door is unlocked; the presence green plus the
 * pinging dot says people are actually inside.
 */
const styles = stylex.create({
  pill: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    borderRadius: radii.pill,
    paddingInline: space.s2,
    paddingBlock: space.s0_5,
    fontSize: text.xs,
    fontWeight: weight.medium,
  },
  pillOpen: { backgroundColor: accent.a50, color: accent.a700 },
  pillLive: { backgroundColor: live.l50, color: live.l700 },
  text: { fontWeight: weight.medium },
  textOpen: { color: accent.a700 },
  textLive: { color: live.l700 },
  /** A 6px dot with a ring expanding out of it. */
  dot: { position: "relative", display: "flex", height: 6, width: 6 },
  dotRing: {
    position: "absolute",
    display: "inline-flex",
    height: "100%",
    width: "100%",
    borderRadius: radii.pill,
    backgroundColor: live.l400,
  },
  dotCore: {
    position: "relative",
    display: "inline-flex",
    height: 6,
    width: 6,
    borderRadius: radii.pill,
    backgroundColor: live.l500,
  },
});

/** The pill beside an open Meeting's title: "Live" with people inside, "Open" without. */
export function MeetingStatePill({ live: isLive }: { live: boolean }) {
  return (
    <span {...stylex.props(styles.pill, isLive ? styles.pillLive : styles.pillOpen)}>
      {isLive ? (
        <span {...stylex.props(styles.dot)}>
          <span {...stylex.props(styles.dotRing, presence.ping)} />
          <span {...stylex.props(styles.dotCore)} />
        </span>
      ) : null}
      {isLive ? "Live" : "Open"}
    </span>
  );
}

/** The line under an open Meeting's title, in the same colour as its pill. */
export function MeetingStateText({ live: isLive, children }: { live: boolean; children: React.ReactNode }) {
  return <span {...stylex.props(styles.text, isLive ? styles.textLive : styles.textOpen)}>{children}</span>;
}
