import { ChevronUp } from "lucide-react";
import { enter } from "@orbmeet/ui/styles/animations";
import { focus, layout, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { accent, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { useNow } from "@/lib/hooks/use-now";
import type { CaptionTranscriptEntry } from "@/modules/meetings/client/captions/board";
import { latestCaption } from "@/modules/meetings/client/captions/latest-caption";
import { firstName } from "./meeting-format";

const blink = stylex.keyframes({ "0%, 49%": { opacity: 1 }, "50%, 100%": { opacity: 0 } });

const styles = stylex.create({
  base: {
    display: "flex",
    alignItems: "center",
    gap: space.s3,
    borderWidth: 0,
    fontFamily: "inherit",
    textAlign: "start",
    cursor: "pointer",
  },
  /** Talk: a dark band over the bottom of the stage, where subtitles are read. */
  stage: {
    width: "min(720px, calc(100% - 48px))",
    borderRadius: radii.card,
    backgroundColor: `color-mix(in oklab, ${neutral.n900} 82%, transparent)`,
    backdropFilter: "blur(12px)",
    paddingInline: space.s4,
    paddingBlock: space.s3,
    color: ink.onDark,
    boxShadow: shadows.float,
  },
  /** Board: one line at the top of the board, away from the writing hand. */
  board: {
    width: "min(470px, calc(100% - 32px))",
    height: 44,
    borderRadius: radii.control,
    backgroundColor: { default: `color-mix(in oklab, ${surface.raised} 95%, transparent)`, [env.hoverable]: { default: `color-mix(in oklab, ${surface.raised} 95%, transparent)`, ":hover": surface.raised } },
    paddingInline: space.s3_5,
    color: neutral.n800,
    boxShadow: `0 0 0 1px ${neutral.n150}, ${shadows.float}`,
  },
  /** Phone: a card above the thumb zone, two lines, with what is new. */
  card: {
    width: "100%",
    flexDirection: "column",
    alignItems: "stretch",
    gap: space.s1,
    borderRadius: radii.card,
    backgroundColor: surface.raised,
    paddingInline: space.s3,
    paddingBlock: space.s2_5,
    color: neutral.n800,
    boxShadow: `0 0 0 1px ${neutral.n150}, ${shadows.float}`,
  },
  cardHead: { display: "flex", alignItems: "center", gap: space.s1_5 },
  grow: { flexGrow: 1 },
  name: { flexShrink: 0, fontSize: text.xs, fontWeight: weight.semibold, color: accent.a700 },
  nameOnDark: { color: accent.a200 },
  words: { minWidth: 0, flexGrow: 1, fontSize: text.sm, lineHeight: leading.sm },
  wordsStage: { fontSize: text.base, lineHeight: leading.base, fontWeight: weight.medium },
  wordsOneLine: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  wordsTwoLines: {
    display: "-webkit-box",
    overflow: "hidden",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    fontSize: text.base,
    lineHeight: leading.sm,
  },
  saying: { color: neutral.n400 },
  sayingOnDark: { color: `color-mix(in oklab, ${ink.onDark} 60%, transparent)` },
  caret: {
    display: "inline-block",
    width: 2,
    height: "1em",
    marginInlineStart: 2,
    verticalAlign: "-0.15em",
    borderRadius: 1,
    backgroundColor: accent.a500,
    animationName: { default: blink, [env.reducedMotion]: "none" },
    animationDuration: "1.1s",
    animationIterationCount: "infinite",
  },
  fresh: {
    flexShrink: 0,
    display: "inline-flex",
    height: 22,
    alignItems: "center",
    borderRadius: radii.field,
    backgroundColor: accent.a50,
    paddingInline: space.s2,
    fontSize: text.xs2,
    fontWeight: weight.bold,
    fontVariantNumeric: "tabular-nums",
    color: accent.a700,
  },
  freshOnDark: { backgroundColor: `color-mix(in oklab, ${ink.onDark} 14%, transparent)`, color: ink.onDark },
  /** Under a phone's board, in the flow: no lift, it is not floating over anything. */
  peek: { flexShrink: 0, boxShadow: `0 0 0 1px ${neutral.n150}` },
  peekHead: { fontSize: text.xs, fontWeight: weight.semibold, color: neutral.n500 },
  peekSpeaker: { fontWeight: weight.semibold, color: ink.strong },
  quiet: { color: neutral.n500 },
});

/**
 * The Conversation under a phone's board, folded to its newest line and kept
 * there when the room goes quiet: what is being said, else the last message,
 * else where both will land. Pressing it opens the Conversation, where the
 * box to write in is.
 *
 * Its title stays "Conversation", with whoever said the line at the head of
 * the line: the speaker's name used to take the title's place, so the card
 * stopped saying what it was the moment anyone spoke. What is new is the Chat
 * button's badge in the dock, and is said once, there.
 */
export function ConversationPeek({
  entries,
  latestMessage,
  newCount,
  onOpen,
}: {
  entries: readonly CaptionTranscriptEntry[];
  /** The newest message to the room, if any. */
  latestMessage: { userName: string; text: string } | undefined;
  newCount: number;
  onOpen: () => void;
}) {
  const now = useNow(1000, entries.length > 0);
  const caption = latestCaption(entries, now);
  const speaker = caption?.userName ?? latestMessage?.userName;
  const line = caption ? [caption.settled, caption.saying].filter(Boolean).join(" ") : latestMessage?.text;
  const label = `Open the conversation${newCount > 0 ? `, ${newCount} new` : ""}`;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={speaker && line ? `${speaker}: ${line}. ${label}` : label}
      {...stylex.props(pressable.base, motion.tint, focus.ring, styles.base, styles.card, styles.peek)}
    >
      <span {...stylex.props(styles.cardHead, styles.peekHead)}>
        Conversation
        <span {...stylex.props(styles.grow)} />
        <ChevronUp size={16} strokeWidth={2} aria-hidden="true" color="currentColor" />
      </span>
      <span aria-hidden="true" {...stylex.props(styles.words, styles.wordsOneLine, layout.minZero, !line && styles.quiet)}>
        {speaker && line && <span {...stylex.props(styles.peekSpeaker)}>{firstName(speaker)} </span>}
        {line ?? "Write to the room, or read what is said"}
      </span>
    </button>
  );
}

/**
 * The Conversation, folded to one caption: what is being said now, by whom,
 * and how much is new. Pressing it opens the Conversation. In Talk it is a
 * band at the bottom of the stage; on the board, one line at the top, where
 * no writing hand rests; on a phone, a card above the controls.
 *
 * It is there only while someone is talking, so a quiet room has nothing over
 * its stage; what is new waits on the Conversation button.
 */
export function LiveCaption({
  variant,
  entries,
  newCount,
  onOpen,
}: {
  variant: "stage" | "board" | "card";
  entries: readonly CaptionTranscriptEntry[];
  /** Unread in the Conversation. */
  newCount: number;
  onOpen: () => void;
}) {
  const now = useNow(1000, entries.length > 0);
  const caption = latestCaption(entries, now);
  if (!caption) return null;

  const onDark = variant === "stage";
  const fresh = newCount > 0 && (
    <span {...stylex.props(styles.fresh, onDark && styles.freshOnDark)}>{newCount > 9 ? "9+" : newCount} new</span>
  );
  const words = (
    <>
      {caption.settled}
      {caption.saying && (
        <span {...stylex.props(onDark ? styles.sayingOnDark : styles.saying)}>
          {caption.settled ? " " : ""}
          {caption.saying}
        </span>
      )}
      {caption.saying && <span aria-hidden="true" {...stylex.props(styles.caret)} />}
    </>
  );
  const label = `${caption.userName}: ${caption.settled} ${caption.saying}. Open the conversation${newCount > 0 ? `, ${newCount} new` : ""}`;

  if (variant === "card") {
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label={label}
        {...stylex.props(pressable.base, motion.tint, focus.ring, styles.base, styles.card, enter.fade)}
      >
        <span {...stylex.props(styles.cardHead)}>
          <span {...stylex.props(styles.name)}>{firstName(caption.userName)}</span>
          <span {...stylex.props(styles.grow)} />
          {fresh}
          <ChevronUp size={16} strokeWidth={2} aria-hidden="true" color="currentColor" />
        </span>
        <span aria-hidden="true" {...stylex.props(styles.wordsTwoLines)}>
          {words}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      {...stylex.props(pressable.base, motion.tint, focus.ring, styles.base, styles[variant], enter.fade)}
    >
      <span {...stylex.props(styles.name, onDark && styles.nameOnDark)}>{firstName(caption.userName)}</span>
      <span
        aria-hidden="true"
        {...stylex.props(styles.words, variant === "stage" ? styles.wordsStage : [styles.wordsOneLine, layout.minZero])}
      >
        {words}
      </span>
      {fresh}
    </button>
  );
}
