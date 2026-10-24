import * as stylex from "@stylexjs/stylex";
import { useParticipantAttribute } from "@livekit/components-react";
import type { Participant } from "livekit-client";
import { Hand } from "lucide-react";
import { warning } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { PARTICIPANT_ATTRIBUTE, parseRaisedHand } from "@/modules/meetings/contract/live-state";

const styles = stylex.create({
  badge: {
    position: "absolute",
    top: space.s2_5,
    left: space.s2_5,
    zIndex: 2,
    display: "inline-flex",
    height: 26,
    alignItems: "center",
    gap: space.s1,
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: warning.w200,
    backgroundColor: warning.w50,
    paddingInline: space.s2,
    fontSize: text.xs,
    fontWeight: weight.semibold,
    color: warning.w800,
    pointerEvents: "none",
  },
  /** A phone's tiles are small: the hand alone says it. */
  compact: { width: 26, paddingInline: 0, justifyContent: "center" },
});

/**
 * Whether this person has a hand up. The hand is a participant attribute the
 * server writes, so every viewer reads the same, moderator or not.
 */
export function useHandRaised(participant: Participant): boolean {
  return parseRaisedHand(useParticipantAttribute(PARTICIPANT_ATTRIBUTE.hand, { participant })) !== null;
}

/**
 * A raised hand, on the tile of whoever raised it: everyone sees who is
 * waiting to speak, not only the people who can call on them.
 */
export function TileHandBadge({ participant, compact = false }: { participant: Participant; compact?: boolean }) {
  if (!useHandRaised(participant)) return null;
  return (
    <span role="img" aria-label="Hand raised" {...stylex.props(styles.badge, compact && styles.compact)}>
      <Hand size={13} strokeWidth={2.2} aria-hidden="true" />
      {!compact && "Hand raised"}
    </span>
  );
}
