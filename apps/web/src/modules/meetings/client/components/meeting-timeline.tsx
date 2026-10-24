import * as React from "react";
import { Hand, Lock, Mic, MessageSquareLock, MessageSquareText, Pencil, RefreshCw, Send, X } from "lucide-react";
import { Avatar, Tooltip } from "@orbmeet/ui/react";
import { enter } from "@orbmeet/ui/styles/animations";
import { focus, layout, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { accent, danger, ink, neutral, surface, violet, warning } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { duration } from "@orbmeet/ui/tokens/motion.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import type { CaptionTranscriptEntry } from "@/modules/meetings/client/captions/board";
import { useIOSKeyboard } from "@/lib/hooks/use-ios-keyboard";
import { useNow } from "@/lib/hooks/use-now";
import { sidePanel } from "@/modules/meetings/client/meeting-styles";
import { audienceKey, type AssistantAudienceRequest } from "@orbmeet/whiteboard-core/assistant";
import {
  isOrbMentionPrefix,
  ORB_NAME,
  orbQuestion,
  recentlySaid,
  sharedOrbAnswer,
  withOrbMention,
  type MeetingAssistant,
} from "@/modules/meetings/client/orb";
import {
  buildTimeline,
  ROOM_THREAD,
  threadAudience,
  type TimelineChatInput,
  type TimelineItem,
  type TimelineThread,
} from "@/modules/meetings/client/timeline-model";
import type { HandRaise } from "@/modules/meetings/client/use-hand-raises";
import {
  loadOrbTipsOff,
  loadOrbTipTurn,
  orbQuestionIdeas,
  orbTips,
  saveOrbTipsOff,
  saveOrbTipTurn,
} from "@/modules/meetings/client/orb-tips";
import { SpeechWave } from "./dock-primitives";
import { SpeechSwitch } from "./speech-switch";
import { OrbEntry, OrbMark, OrbRunBar } from "./timeline-orb";
import { TimelineThreads, type TimelineThreadsProps } from "./timeline-threads";
import { firstName } from "./meeting-format";

const URL_REGEX = /https?:\/\/[^\s<>)"']*[^\s<>)"'.,;:!?]/g;
const MAX_MESSAGE_LENGTH = 500;

const styles = stylex.create({
  shell: { height: "100%" },
  headerMain: { display: "flex", minWidth: 0, alignItems: "center", gap: space.s2 },
  headerTools: { display: "flex", alignItems: "center", gap: space.s1 },
  title: {
    margin: 0,
    fontFamily: fonts.heading,
    fontSize: text.sm,
    fontWeight: weight.bold,
    color: ink.strong,
  },

  /** Raised hands wait above the stream: a person waiting is not history yet. */
  hands: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: warning.w100,
    backgroundColor: warning.w50,
    paddingInline: space.s3,
    paddingBlock: space.s2_5,
  },
  handsHeading: {
    margin: 0,
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    fontSize: text.xs,
    fontWeight: weight.semibold,
    color: warning.w700,
  },
  handRow: { display: "flex", alignItems: "center", gap: space.s2 },
  saidMark: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s1,
    fontSize: text.xs2,
    color: neutral.n500,
  },
  handName: { minWidth: 0, flexGrow: 1, fontSize: text.sm, fontWeight: weight.medium, color: neutral.n800 },
  handWait: { flexShrink: 0, fontVariantNumeric: "tabular-nums", fontSize: text.xs2, color: neutral.n500 },
  // Words, not a tick and a cross: which of the two let someone speak was a
  // guess, and a wrong guess lowers the hand of the person you meant to call on.
  handAction: {
    display: "flex",
    height: 30,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.pill,
    borderWidth: 0,
    paddingInline: space.s3,
    fontFamily: "inherit",
    fontSize: text.xs,
    fontWeight: weight.semibold,
    cursor: "pointer",
  },
  handApprove: {
    backgroundColor: { default: accent.a600, [env.hoverable]: { default: accent.a600, ":hover": accent.a700, ":disabled": neutral.n200 } },
    color: ink.onDark,
  },
  handDismiss: {
    backgroundColor: { default: surface.raised, [env.hoverable]: { default: surface.raised, ":hover": neutral.n100 } },
    color: neutral.n600,
    boxShadow: `inset 0 0 0 1px ${neutral.n200}`,
  },

  /**
   * One stream, three kinds of entry told apart by their shape rather than by
   * a filter: what was said is plain text under a face, a message is a
   * bubble, and your own messages sit on your side.
   */
  stream: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3_5,
    paddingInline: space.s4,
    paddingBlock: space.s3,
  },
  note: {
    margin: 0,
    textAlign: "center",
    fontSize: text.xs2,
    color: neutral.n400,
  },
  said: { display: "grid", gridTemplateColumns: "24px minmax(0, 1fr)", columnGap: space.s2_5 },
  head: { display: "flex", minWidth: 0, alignItems: "baseline", gap: space.s1_5 },
  name: { minWidth: 0, fontSize: text.xs, fontWeight: weight.semibold, color: neutral.n800 },
  time: { flexShrink: 0, fontSize: text.xs3, fontVariantNumeric: "tabular-nums", color: neutral.n500 },
  saidText: {
    margin: 0,
    marginTop: 1,
    overflowWrap: "anywhere",
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: neutral.n800,
  },
  /** Words still being revised as the speaker talks. */
  saying: { fontStyle: "italic", color: neutral.n500 },
  wave: { display: "inline-flex", marginInlineStart: space.s1_5, color: accent.a600, verticalAlign: "middle" },
  message: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: space.s1 },
  messageMine: { alignItems: "flex-end" },
  bubble: {
    maxWidth: "85%",
    margin: 0,
    overflowWrap: "anywhere",
    borderRadius: 16,
    borderEndStartRadius: 5,
    backgroundColor: neutral.n100,
    paddingInline: space.s3,
    paddingBlock: space.s2,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: neutral.n900,
  },
  bubbleMine: { borderEndStartRadius: 16, borderEndEndRadius: 5, backgroundColor: accent.a600, color: ink.onDark },
  /** Yours, in a private thread: slate, the colour the room keeps for privacy. */
  bubblePrivateMine: { backgroundColor: neutral.n800 },
  /** "@Orb" at the head of a question, so a question to Orb reads as one. */
  orbToken: { fontWeight: weight.semibold, color: violet.v700 },
  orbTokenOnDark: { color: violet.v100 },
  link: {
    color: { default: accent.a700, [env.hoverable]: { default: accent.a700, ":hover": accent.a900 } },
    textDecoration: "underline",
  },
  linkOnAccent: { color: { default: ink.onDark, [env.hoverable]: { default: ink.onDark, ":hover": ink.onDark } } },

  empty: {
    display: "flex",
    flexGrow: 1,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s1,
    paddingInline: space.s6,
    paddingBlock: space.s10,
    textAlign: "center",
  },
  emptyGlyph: { marginBottom: space.s2, color: neutral.n300 },
  emptyTitle: { margin: 0, fontSize: text.sm, fontWeight: weight.semibold, color: neutral.n700 },
  emptyBody: { margin: 0, fontSize: text.xs, lineHeight: leading.relaxed, color: neutral.n500 },

  /** At the top of a private thread: who sees it, said once, plainly. */
  privacy: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s2,
    margin: 0,
    borderRadius: radii.field,
    backgroundColor: neutral.n100,
    paddingInline: space.s2_5,
    paddingBlock: space.s2,
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: neutral.n700,
  },
  privacyIcon: { flexShrink: 0, marginTop: 2 },

  composer: {
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: neutral.n100,
    padding: space.s3,
    transitionProperty: "padding-bottom",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
  },
  composerKeyboardOffset: (offset: number) => ({ paddingBottom: `calc(0.75rem + ${offset}px)` }),
  composerForm: { position: "relative" },
  /**
   * The box you write in: who it goes to, then the line and its send button,
   * one bordered field. Its edge takes the thread's colour, so a private
   * message never looks like one to the room.
   */
  field: {
    borderRadius: radii.card,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: neutral.n200, ":focus-within": accent.a400 },
    backgroundColor: surface.raised,
    boxShadow: { default: shadows.hairline, ":focus-within": `0 0 0 3px ${accent.a50}` },
    transitionProperty: "border-color, box-shadow",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
  },
  fieldPrivate: {
    borderColor: { default: neutral.n400, ":focus-within": neutral.n600 },
    boxShadow: { default: shadows.hairline, ":focus-within": `0 0 0 3px ${neutral.n100}` },
  },
  fieldOrb: {
    borderColor: { default: violet.v200, ":focus-within": violet.v400 },
    boxShadow: { default: shadows.hairline, ":focus-within": `0 0 0 3px ${violet.v50}` },
  },
  fieldHead: { paddingTop: space.s2, paddingInline: space.s2_5 },
  composerRow: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    paddingBlock: space.s1_5,
    paddingInlineStart: space.s3,
    paddingInlineEnd: space.s1_5,
  },
  /** Who a message goes to, at the top of the box you type it in. */
  audience: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    height: 22,
    borderRadius: radii.field,
    paddingInline: space.s2,
    fontSize: text.xs2,
    fontWeight: weight.semibold,
  },
  audiencePrivate: { backgroundColor: neutral.n800, color: ink.onDark },
  audienceOrb: { backgroundColor: violet.v50, color: violet.v800 },
  hint: { display: "flex", alignItems: "center", gap: space.s1, margin: 0, marginTop: space.s1_5, fontSize: text.xs2, color: ink.muted },
  hintOrb: { color: violet.v700 },
  chipRow: {
    display: "flex",
    justifyContent: "flex-end",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: neutral.n100,
    paddingInline: space.s3,
    paddingBlock: space.s2,
  },
  /** "Orb, catch me up": asked in your own thread with Orb, so nobody else sees it. */
  catchUp: {
    alignSelf: "center",
    display: "inline-flex",
    alignItems: "center",
    gap: space.s2,
    height: 30,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: violet.v100,
    backgroundColor: { default: violet.v50, [env.hoverable]: { default: violet.v50, ":hover": violet.v100 } },
    paddingInlineStart: space.s1_5,
    paddingInlineEnd: space.s3,
    fontFamily: "inherit",
    fontSize: text.xs,
    fontWeight: weight.semibold,
    color: violet.v800,
    cursor: "pointer",
  },
  /** The @Orb suggestion, floating just above the box. */
  mention: {
    position: "absolute",
    insetInline: space.s3,
    bottom: "calc(100% - 0.25rem)",
    display: "flex",
    alignItems: "center",
    gap: space.s2_5,
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: violet.v100,
    backgroundColor: { default: surface.raised, [env.hoverable]: { default: surface.raised, ":hover": violet.v50 } },
    paddingInline: space.s2_5,
    paddingBlock: space.s2,
    textAlign: "start",
    boxShadow: shadows.float,
    cursor: "pointer",
  },
  mentionText: { display: "flex", minWidth: 0, flexDirection: "column" },
  mentionName: { fontSize: text.sm, fontWeight: weight.semibold, color: violet.v800 },
  mentionHint: { fontSize: text.xs, color: ink.muted },
  input: {
    flexGrow: 1,
    minWidth: 0,
    height: 36,
    borderWidth: 0,
    backgroundColor: "transparent",
    padding: 0,
    fontFamily: "inherit",
    // 16px under a finger: iOS zooms the page into a smaller focused field (see styles.css).
    fontSize: { default: text.sm, [env.touch]: text.base },
    color: neutral.n800,
    outlineStyle: "none",
    "::placeholder": { color: neutral.n400 },
  },
  send: {
    display: "inline-flex",
    height: 36,
    width: 36,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.control,
    borderWidth: 0,
    // ":disabled" inside the hover branch too, as the private and Orb sends
    // have it: on a device with a mouse that branch is the rule that applies,
    // and without it an empty box's send button stayed accent.
    backgroundColor: {
      default: accent.a600,
      [env.hoverable]: { default: accent.a600, ":hover": accent.a700, ":disabled": neutral.n200 },
      ":disabled": neutral.n200,
    },
    color: { default: ink.onDark, ":disabled": neutral.n400 },
    cursor: { default: "pointer", ":disabled": "default" },
  },
  sendPrivate: {
    backgroundColor: {
      default: neutral.n800,
      [env.hoverable]: { default: neutral.n800, ":hover": neutral.n900, ":disabled": neutral.n200 },
      ":disabled": neutral.n200,
    },
  },
  sendOrb: {
    backgroundColor: {
      default: violet.v600,
      [env.hoverable]: { default: violet.v600, ":hover": violet.v700, ":disabled": neutral.n200 },
      ":disabled": neutral.n200,
    },
  },
  sendError: { margin: 0, marginTop: space.s2, fontSize: text.xs, color: danger.d700 },

  /** One tip under the box: quiet, a line or two, and it changes. */
  tip: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s2,
    marginTop: space.s2,
    paddingInlineStart: space.s1,
  },
  tipMark: { flexShrink: 0, marginTop: 3 },
  tipText: { margin: 0, minWidth: 0, flexGrow: 1, fontSize: text.xs, lineHeight: leading.xs, color: neutral.n500 },
  tipLabel: { fontWeight: weight.bold, color: violet.v700 },
  /** An example to ask: pressing it puts it in the box. */
  tipExample: {
    borderWidth: 0,
    borderRadius: 6,
    backgroundColor: { default: violet.v50, [env.hoverable]: { default: violet.v50, ":hover": violet.v100 } },
    paddingInline: space.s1,
    fontFamily: "inherit",
    fontSize: "inherit",
    lineHeight: "inherit",
    fontWeight: weight.semibold,
    color: violet.v700,
    textDecorationLine: "underline",
    textDecorationColor: violet.v200,
    textUnderlineOffset: 2,
    cursor: "pointer",
  },
  tipClose: {
    display: "grid",
    width: 24,
    height: 24,
    flexShrink: 0,
    placeItems: "center",
    borderWidth: 0,
    borderRadius: radii.field,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
    color: neutral.n400,
    cursor: "pointer",
  },

  /** Your own thread with Orb, empty: what to ask, a handful at a time. */
  ideas: { display: "flex", width: "100%", flexDirection: "column", gap: space.s1_5, marginTop: space.s3 },
  ideasHead: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  ideasLabel: {
    fontSize: text.xs2,
    fontWeight: weight.bold,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    color: violet.v700,
  },
  ideasMore: {
    display: "inline-flex",
    height: 26,
    alignItems: "center",
    gap: space.s1,
    borderWidth: 0,
    borderRadius: radii.field,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": violet.v50 } },
    paddingInline: space.s2,
    fontFamily: "inherit",
    fontSize: text.xs,
    fontWeight: weight.semibold,
    color: violet.v800,
    cursor: "pointer",
  },
  idea: {
    display: "flex",
    width: "100%",
    minHeight: 40,
    alignItems: "center",
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: violet.v100, [env.hoverable]: { default: violet.v100, ":hover": violet.v300 } },
    backgroundColor: { default: surface.raised, [env.hoverable]: { default: surface.raised, ":hover": violet.v50 } },
    paddingInline: space.s3,
    fontFamily: "inherit",
    fontSize: text.sm,
    textAlign: "start",
    color: violet.v900,
    cursor: "pointer",
  },
  /** Where Orb draws, said where people would otherwise ask it to. */
  drawNote: {
    display: "flex",
    width: "100%",
    boxSizing: "border-box",
    alignItems: "flex-start",
    gap: space.s2_5,
    marginTop: space.s3,
    borderRadius: radii.control,
    backgroundColor: neutral.n100,
    paddingInline: space.s3,
    paddingBlock: space.s2_5,
    textAlign: "start",
  },
  drawNoteIcon: { flexShrink: 0, marginTop: 2, color: accent.a700 },
  drawNoteText: { margin: 0, fontSize: text.xs, lineHeight: leading.xs, color: neutral.n800 },
  drawNoteLink: {
    marginTop: space.s1,
    borderWidth: 0,
    backgroundColor: "transparent",
    padding: 0,
    fontFamily: "inherit",
    fontSize: text.xs,
    fontWeight: weight.semibold,
    color: accent.a700,
    textDecorationLine: "underline",
    textUnderlineOffset: 2,
    cursor: "pointer",
  },
});

function Linkify({ value, onAccent = false }: { value: string; onAccent?: boolean }) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  for (const match of value.matchAll(URL_REGEX)) {
    if (match.index > lastIndex) parts.push(value.slice(lastIndex, match.index));
    const url = match[0];
    parts.push(
      <a
        key={match.index}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        {...stylex.props(styles.link, onAccent && styles.linkOnAccent)}
      >
        {url}
      </a>,
    );
    lastIndex = match.index + url.length;
  }
  if (lastIndex < value.length) parts.push(value.slice(lastIndex));
  return <>{parts}</>;
}

function lastOrbWorkId(items: readonly TimelineItem[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item.kind === "orb-reply" || item.kind === "orb-steps") return item.id;
  }
  return undefined;
}

function clockTime(at: number) {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function EntryHead({ name, at, said = false }: { name: string; at: number; said?: boolean }) {
  return (
    <div {...stylex.props(styles.head)}>
      <span {...stylex.props(styles.name, layout.truncate)}>{name}</span>
      {/* Spoken words sit in the same stream as typed ones; this is what
          tells them apart at a glance, and to a screen reader. */}
      {said && (
        <span {...stylex.props(styles.saidMark)}>
          <Mic size={11} strokeWidth={2.25} aria-hidden="true" />
          said aloud
        </span>
      )}
      <time dateTime={new Date(at).toISOString()} {...stylex.props(styles.time)}>
        {clockTime(at)}
      </time>
    </div>
  );
}

type PersonItem = Extract<TimelineItem, { kind: "chat" | "speech" | "orb-ask" }>;

function TimelineEntry({ item, inPrivate, withOrb = false }: { item: PersonItem; inPrivate: boolean; withOrb?: boolean }) {
  const name = item.mine ? "You" : item.userName;
  if (item.kind === "chat" || item.kind === "orb-ask") {
    const onDark = item.mine;
    return (
      <article {...stylex.props(styles.message, item.mine && styles.messageMine, enter.fade)}>
        <EntryHead name={name} at={item.at} />
        <p {...stylex.props(styles.bubble, item.mine && styles.bubbleMine, item.mine && inPrivate && styles.bubblePrivateMine)}>
          {item.kind === "orb-ask" && !withOrb && (
            <span {...stylex.props(styles.orbToken, onDark && styles.orbTokenOnDark)}>@{ORB_NAME} </span>
          )}
          <Linkify value={item.text} onAccent={onDark} />
        </p>
      </article>
    );
  }
  const saying = item.segments.some((segment) => !segment.isFinal);
  return (
    <article {...stylex.props(styles.said, enter.fade)}>
      <span aria-hidden="true">
        <Avatar name={item.userName} sizePx={24} />
      </span>
      <div>
        <EntryHead name={name} at={item.at} said />
        <p {...stylex.props(styles.saidText)}>
          {item.segments.map((segment, index) => (
            <span key={segment.id} {...stylex.props(!segment.isFinal && styles.saying)}>
              {index > 0 ? " " : ""}
              {segment.text}
            </span>
          ))}
          {saying && (
            <span {...stylex.props(styles.wave)}>
              <SpeechWave />
            </span>
          )}
        </p>
      </div>
    </article>
  );
}

function RaisedHands({
  hands,
  serverClockOffsetMs,
  onApprove,
  onDismiss,
}: {
  hands: HandRaise[];
  serverClockOffsetMs: number;
  onApprove: (userId: string) => void;
  onDismiss: (userId: string) => void;
}) {
  const now = useNow(1000, hands.length > 0);
  const waited = (raisedAt: number) => {
    const seconds = Math.max(0, Math.floor((now + serverClockOffsetMs - raisedAt) / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
  };
  return (
    <section aria-label="Raised hands" {...stylex.props(styles.hands)}>
      <p {...stylex.props(styles.handsHeading)}>
        <Hand size={13} strokeWidth={2} />
        {hands.length === 1 ? "1 hand raised" : `${hands.length} hands raised`}
      </p>
      {hands.map((hand) => (
        <div key={hand.nonce} {...stylex.props(styles.handRow)}>
          <Avatar name={hand.userName} sizePx={24} />
          <span {...stylex.props(styles.handName, layout.truncate)}>{hand.userName}</span>
          <span {...stylex.props(styles.handWait)}>{waited(hand.raisedAt)}</span>
          <Tooltip content={`Let ${hand.userName} speak`} side="bottom">
            <button
              type="button"
              aria-label={`Let ${hand.userName} speak`}
              onClick={() => onApprove(hand.userId)}
              {...stylex.props(pressable.base, motion.tint, focus.ring, styles.handAction, styles.handApprove)}
            >
              Call on
            </button>
          </Tooltip>
          <Tooltip content="Lower their hand" side="bottom">
            <button
              type="button"
              aria-label={`Lower ${hand.userName}'s hand`}
              onClick={() => onDismiss(hand.userId)}
              {...stylex.props(pressable.base, motion.tint, focus.ring, styles.handAction, styles.handDismiss)}
            >
              Lower
            </button>
          </Tooltip>
        </div>
      ))}
    </section>
  );
}

export interface MeetingTimelineProps {
  /** Room messages and this viewer's private ones; `to` marks a private one. */
  messages: readonly TimelineChatInput[];
  currentUserId: string;
  /** Sends to the room, or privately to one person when `to` is given. */
  onSendMessage: (text: string, to: { id: string; name: string } | undefined) => Promise<boolean>;
  /**
   * Orb, the board's assistant. Undefined where Orb has no part in the room;
   * null while it is away — it lives on the board, and the board is closed.
   */
  orb?: MeetingAssistant | null;
  /** Orb's conversations so far, for while Orb is away; Orb's own entries win while it is here. */
  orbHistory?: MeetingAssistant["entries"];
  /** The room's stream and the private ones. Omit for the room's alone. */
  threads?: TimelineThreadsProps;
  /** Asks Orb to catch this viewer up, in their own thread with it. */
  onCatchUp?: () => void;
  /**
   * Teaching Orb: a tip under the box and questions to try in your own thread
   * with it. What the meeting knows that the tips depend on; omit for none.
   */
  orbTeaching?: { transcribing: boolean; paletteShortcut?: string };
  /**
   * What people say. Shown here and nowhere else; the switch is this
   * viewer's, and the spoken language is set from the microphone menu.
   */
  speech: {
    shown: boolean;
    entries: readonly CaptionTranscriptEntry[];
    onToggle: () => void;
  };
  /** Pending raised hands, for a moderator to answer. Omit for anyone else. */
  hands?: {
    queue: HandRaise[];
    serverClockOffsetMs: number;
    onApprove: (userId: string) => void;
    onDismiss: (userId: string) => void;
  };
  onClose?: () => void;
  /** Inside a bottom sheet, which has its own title and close. */
  hideHeader?: boolean;
  /**
   * Docked in the room's side column, whose header already says "Chat" and
   * carries the speech switch: no title, no switch here.
   */
  embedded?: boolean;
  /** The sheet lifts itself above the keyboard; the panel must not add its own offset. */
  embeddedInSheet?: boolean;
  sx?: StyleXStyles;
}

/**
 * The meeting's running record: what was written, what was said, and who is
 * waiting to speak, in one column — and the private threads beside it, one
 * per person and one with Orb.
 */
export function MeetingTimeline({
  messages,
  currentUserId,
  onSendMessage,
  orb,
  orbHistory,
  threads,
  onCatchUp,
  orbTeaching,
  speech,
  hands,
  onClose,
  hideHeader = false,
  embedded = false,
  embeddedInSheet = false,
  sx,
}: MeetingTimelineProps) {
  const [inputValue, setInputValue] = React.useState("");
  const mentionId = React.useId();
  const hintId = React.useId();
  const [sendError, setSendError] = React.useState<string | null>(null);
  const ownKeyboardOffset = useIOSKeyboard();
  const keyboardOffset = embeddedInSheet ? 0 : ownKeyboardOffset;
  const streamRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  // Follow new entries only while the reader is at the bottom, so scrolling
  // back through the meeting is never yanked away by the next sentence.
  const pinnedToBottomRef = React.useRef(true);

  const thread = threads?.active ?? ROOM_THREAD;
  const inRoom = thread.kind === "room";
  const withOrb = thread.kind === "orb";
  const partner =
    thread.kind === "private" ? threads?.threads.find((candidate) => candidate.withId === thread.withId) : undefined;
  const partnerName = partner?.withName ?? "them";
  const partnerAway = thread.kind === "private" && !partner?.present;
  const orbEntries = orb?.entries ?? orbHistory;
  const items = React.useMemo(
    () =>
      buildTimeline({
        chat: messages,
        speech: speech.shown ? speech.entries : [],
        orb: orbEntries ?? [],
        currentUserId,
        thread,
      }),
    [messages, speech.shown, speech.entries, orbEntries, currentUserId, thread],
  );
  // Orb works on one question per thread at a time; this thread's, if any.
  const audience = threadAudience(thread, currentUserId);
  const orbRun = orb?.runs.find((run) => audienceKey(run.audience) === audienceKey(audience)) ?? null;
  // The newest of Orb's entries is the one it is working on while a run lasts.
  const workingOrbItemId = orbRun ? lastOrbWorkId(items) : undefined;
  const speechArriving = speech.shown && speech.entries.some((entry) => !entry.isFinal);
  const pendingHands = React.useMemo(
    () => (hands?.queue ?? []).filter((hand) => hand.status === "pending").sort((a, b) => a.raisedAt - b.raisedAt),
    [hands?.queue],
  );

  const handleScroll = React.useCallback(() => {
    const container = streamRef.current;
    if (!container) return;
    pinnedToBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  }, []);

  React.useEffect(() => {
    const container = streamRef.current;
    // Nothing yet, nothing to follow: an empty thread is read from its top,
    // where Orb's thread puts its title over the questions to try.
    if (!container || !pinnedToBottomRef.current || items.length === 0) return;
    container.scrollTop = container.scrollHeight;
  }, [items]);

  // "@Orb" is offered while it is still being typed, where people write to
  // each other: in the room, Orb answers everyone; in private, the two of you.
  // In your own thread with Orb everything written is for Orb already.
  const orbHere = orb !== undefined;
  const [mentionDismissedFor, setMentionDismissedFor] = React.useState<string | null>(null);
  const offerOrb =
    orbHere && !withOrb && !partnerAway && isOrbMentionPrefix(inputValue) && mentionDismissedFor !== inputValue;
  const addressingOrb = orbHere && (withOrb || orbQuestion(inputValue) !== null);
  const completeMention = () => {
    setInputValue(withOrbMention(inputValue));
    setSendError(null);
    inputRef.current?.focus();
  };

  // One tip per opening of the Chat, and the next after each message you
  // send; the next opening, here or in the next meeting, starts on the one
  // after. Only in the room's stream, only while Orb is here to try it on.
  const [tipTurn, setTipTurn] = React.useState(loadOrbTipTurn);
  const [tipsOff, setTipsOff] = React.useState(loadOrbTipsOff);
  React.useEffect(() => {
    saveOrbTipTurn(tipTurn + 1);
  }, [tipTurn]);
  const tips =
    orb && orb.available && orbTeaching && inRoom && !tipsOff
      ? orbTips({
          canDraw: orb.canDraw,
          transcribing: orbTeaching.transcribing,
          orbThread: Boolean(threads?.orb),
          privateChats: (threads?.people.length ?? 0) > 0,
          paletteShortcut: orbTeaching.paletteShortcut,
        })
      : [];
  const tip = tips.length > 0 ? tips[tipTurn % tips.length] : undefined;
  const putInBox = (text: string) => {
    setInputValue(text);
    setSendError(null);
    inputRef.current?.focus();
  };
  const turnTipsOff = () => {
    saveOrbTipsOff();
    setTipsOff(true);
  };
  // Questions to try in your own thread with Orb: a different handful each
  // time, and another on asking for one.
  const [ideaShift, setIdeaShift] = React.useState(0);
  const ideas = orbQuestionIdeas(tipTurn + ideaShift, orbTeaching?.transcribing ?? false);

  const saidLately = () => recentlySaid(speech.entries, Date.now());
  const askOrb = async (question: string, target: TimelineThread): Promise<string | null> => {
    if (!question) return withOrb ? "Write your question first." : `Write your question after @${ORB_NAME}.`;
    if (!orb) return `${ORB_NAME} works on the board. Open the board, then ask again.`;
    if (!orb.available) return `${ORB_NAME} isn't set up on this server.`;
    if (!orb.live) return `${ORB_NAME} can't be reached right now. Try again in a moment.`;
    const busy = orb.runs.find((run) => audienceKey(run.audience) === audienceKey(threadAudience(target, currentUserId)));
    if (busy) {
      return `${ORB_NAME} is answering ${busy.requesterUserId === currentUserId ? "you" : busy.requesterName}. Ask again in a moment.`;
    }
    const request: AssistantAudienceRequest =
      target.kind === "room"
        ? { kind: "room" }
        : target.kind === "orb"
          ? { kind: "private" }
          : { kind: "private", with: target.withId };
    return orb.prompt(question, { audience: request, said: saidLately() });
  };

  const submit = async () => {
    const trimmed = inputValue.trim();
    if (!trimmed || trimmed.length > MAX_MESSAGE_LENGTH) return;
    if (thread.kind === "private" && partnerAway) return;
    const question = withOrb ? trimmed : orbHere ? orbQuestion(trimmed) : null;
    pinnedToBottomRef.current = true;
    if (question !== null) {
      const error = await askOrb(question, thread);
      if (error) {
        setSendError(error);
        inputRef.current?.focus();
        return;
      }
    } else {
      const to = thread.kind === "private" ? { id: thread.withId, name: partnerName } : undefined;
      const sent = await onSendMessage(trimmed, to);
      if (!sent) {
        setSendError("Message not sent. Wait a moment and try again.");
        inputRef.current?.focus();
        return;
      }
    }
    setSendError(null);
    setInputValue("");
    setTipTurn((turn) => turn + 1);
    setIdeaShift((shift) => shift + 1);
    inputRef.current?.focus();
  };

  // An answer seen in private can be put to the room, as yours.
  const shareWithRoom = async (text: string) => {
    const sent = await onSendMessage(sharedOrbAnswer(text, MAX_MESSAGE_LENGTH), undefined);
    setSendError(sent ? null : "Not shared. Wait a moment and try again.");
  };

  // Short enough to fit a phone or a 300px panel whole: who it goes to, no more.
  const placeholder = withOrb
    ? `Ask ${ORB_NAME}`
    : inRoom
      ? "Message everyone"
      : partnerAway
        ? `${partnerName} has left the meeting`
        : `Message ${partnerName}`;
  // Over the box, only when it says something the placeholder does not: a
  // message to the room is the default and needs no label.
  const audienceLabel = withOrb
    ? null
    : !inRoom
      ? `Private to ${partnerName}`
      : addressingOrb
        ? `To ${ORB_NAME} · everyone sees`
        : null;
  // Under the box, once: who sees it, where that is not everyone.
  const hint = withOrb
    ? "Only you see this. It isn't recorded."
    : !inRoom && orbHere
      ? `@${ORB_NAME} answers just you two`
      : null;
  const orbLabel = (item: Extract<TimelineItem, { kind: "orb-reply" }>) =>
    withOrb
      ? undefined
      : !inRoom
        ? "just you two"
        : item.askedBy
          ? `replying to ${item.askedBy.userId === currentUserId ? "you" : firstName(item.askedBy.userName)}`
          : undefined;

  // What Orb drew: anyone can look at it; whoever asked can take it back, once.
  const [undone, setUndone] = React.useState<ReadonlySet<string>>(() => new Set());
  const stepActions = (item: Extract<TimelineItem, { kind: "orb-steps" }>) => {
    const { pageId, created, changed } = item;
    const drawn = [...created, ...changed];
    if (!orb || !pageId || drawn.length === 0 || item.id === workingOrbItemId) return {};
    return {
      onShow: () => orb.showShapes(pageId, drawn),
      onUndo:
        created.length > 0 && item.askedBy?.userId === currentUserId && !undone.has(item.id)
          ? () => {
              const error = orb.removeShapes(created);
              setSendError(error);
              if (!error) setUndone((current) => new Set(current).add(item.id));
            }
          : undefined,
    };
  };

  const renderItem = (item: TimelineItem) =>
    item.kind === "orb-reply" || item.kind === "orb-steps" || item.kind === "orb-notice" ? (
      <OrbEntry
        key={`${item.kind}:${item.id}`}
        item={item}
        working={item.id === workingOrbItemId}
        label={item.kind === "orb-reply" ? orbLabel(item) : undefined}
        onShare={item.kind === "orb-reply" && item.done && !inRoom ? () => void shareWithRoom(item.text) : undefined}
        {...(item.kind === "orb-steps" ? stepActions(item) : {})}
      />
    ) : (
      <TimelineEntry key={`${item.kind}:${item.id}`} item={item} inPrivate={!inRoom} withOrb={withOrb} />
    );

  return (
    <div {...stylex.props(sidePanel.shell, enter.panel, styles.shell, sx)}>
      {!hideHeader && !embedded && (
        <div {...stylex.props(sidePanel.header)}>
          <div {...stylex.props(styles.headerMain)}>
            <h2 {...stylex.props(styles.title)}>Conversation</h2>
          </div>
          <div {...stylex.props(styles.headerTools)}>
            <SpeechSwitch shown={speech.shown} arriving={speechArriving} onToggle={speech.onToggle} />
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close the conversation"
                {...stylex.props(pressable.base, motion.tint, focus.ring, sidePanel.close)}
              >
                <X size={16} />
              </button>
            )}
          </div>
        </div>
      )}

      {threads && (
        <TimelineThreads
          {...threads}
          end={
            hideHeader && !embedded ? (
              <SpeechSwitch shown={speech.shown} arriving={speechArriving} onToggle={speech.onToggle} />
            ) : undefined
          }
        />
      )}
      {!threads && hideHeader && !embedded && (
        <div {...stylex.props(styles.chipRow)}>
          <SpeechSwitch shown={speech.shown} arriving={speechArriving} onToggle={speech.onToggle} />
        </div>
      )}

      {inRoom && hands && pendingHands.length > 0 && (
        <RaisedHands
          hands={pendingHands}
          serverClockOffsetMs={hands.serverClockOffsetMs}
          onApprove={hands.onApprove}
          onDismiss={hands.onDismiss}
        />
      )}

      <div
        ref={streamRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-label="Conversation"
        {...stylex.props(sidePanel.body, layout.minZero)}
      >
        {withOrb ? (
          <div {...stylex.props(styles.stream)}>
            {items.length === 0 ? (
              <div {...stylex.props(styles.empty)}>
                <OrbMark sizePx={32} />
                <p {...stylex.props(styles.emptyTitle)}>Ask {ORB_NAME} anything</p>
                <p {...stylex.props(styles.emptyBody)}>About the board, or what was said.</p>
                {orbTeaching && (
                  <>
                    <div role="group" aria-label="Questions to try" {...stylex.props(styles.ideas)}>
                      <div {...stylex.props(styles.ideasHead)}>
                        <span {...stylex.props(styles.ideasLabel)}>Try asking</span>
                        <button
                          type="button"
                          onClick={() => setIdeaShift((shift) => shift + 1)}
                          {...stylex.props(pressable.base, motion.tint, focus.ring, styles.ideasMore)}
                        >
                          <RefreshCw size={12} strokeWidth={2.25} aria-hidden="true" />
                          Other ideas
                        </button>
                      </div>
                      {ideas.map((idea) => (
                        <button
                          key={idea}
                          type="button"
                          onClick={() => putInBox(idea)}
                          {...stylex.props(pressable.base, motion.tint, focus.ring, styles.idea)}
                        >
                          {idea}
                        </button>
                      ))}
                    </div>
                    {/* Orb never draws in a private thread — everyone sees the
                        board — so whoever asks for a drawing here would get
                        words and no idea why. Said where they would ask. */}
                    <div {...stylex.props(styles.drawNote)}>
                      <Pencil size={14} strokeWidth={2} aria-hidden="true" {...stylex.props(styles.drawNoteIcon)} />
                      <div>
                        <p {...stylex.props(styles.drawNoteText)}>
                          {orb?.canDraw
                            ? `${ORB_NAME} draws only where everyone can see it. To have it draw, ask with @${ORB_NAME} in Everyone.`
                            : `${ORB_NAME} draws only in Everyone, for people with the pen.`}
                        </p>
                        {threads && (
                          <button
                            type="button"
                            onClick={() => threads.onSelect(ROOM_THREAD)}
                            {...stylex.props(focus.ring, styles.drawNoteLink)}
                          >
                            Go to Everyone
                          </button>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            ) : (
              items.map(renderItem)
            )}
          </div>
        ) : !inRoom ? (
          <div {...stylex.props(styles.stream)}>
            <p {...stylex.props(styles.privacy)}>
              <Lock size={12} strokeWidth={2.5} aria-hidden="true" {...stylex.props(styles.privacyIcon)} />
              {partnerAway
                ? `${partnerName} has left the meeting. You can read this, but new messages can't reach them.`
                : `Only you and ${partnerName} see this. It isn't recorded or in the summary.`}
            </p>
            {items.length === 0 ? (
              <div {...stylex.props(styles.empty)}>
                <MessageSquareLock size={28} strokeWidth={1.5} {...stylex.props(styles.emptyGlyph)} />
                <p {...stylex.props(styles.emptyTitle)}>Private with {partnerName}</p>
                <p {...stylex.props(styles.emptyBody)}>
                  Write something only {partnerName} will see.
                  {orbHere && ` @${ORB_NAME} here answers just the two of you.`}
                </p>
              </div>
            ) : (
              items.map(renderItem)
            )}
          </div>
        ) : items.length === 0 ? (
          <div {...stylex.props(styles.empty)}>
            <MessageSquareText size={28} strokeWidth={1.5} {...stylex.props(styles.emptyGlyph)} />
            <p {...stylex.props(styles.emptyTitle)}>No messages yet</p>
            <p {...stylex.props(styles.emptyBody)}>
              {speech.shown
                ? "Messages and the transcript show up here."
                : "Messages and raised hands show up here."}
              {orbHere && ` Start with @${ORB_NAME} to ask about the board.`}
            </p>
          </div>
        ) : (
          <div {...stylex.props(styles.stream)}>
            {orb && onCatchUp && (
              <button
                type="button"
                onClick={onCatchUp}
                {...stylex.props(pressable.base, motion.tint, focus.ring, styles.catchUp)}
              >
                <OrbMark sizePx={20} />
                {ORB_NAME}, catch me up
              </button>
            )}
            <p {...stylex.props(styles.note)}>Chat is deleted when the meeting ends.</p>
            {items.map(renderItem)}
          </div>
        )}
      </div>

      {orbRun && orb && (
        <OrbRunBar
          run={orbRun}
          currentUserId={currentUserId}
          canCancel={orb.mayCancel(orbRun)}
          onCancel={() => orb.cancel(orbRun.id)}
        />
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (offerOrb) completeMention();
          else void submit();
        }}
        {...stylex.props(
          styles.composer,
          styles.composerForm,
          keyboardOffset > 0 && styles.composerKeyboardOffset(keyboardOffset),
        )}
      >
        {offerOrb && (
          <button
            type="button"
            id={mentionId}
            onMouseDown={(event) => event.preventDefault()}
            onClick={completeMention}
            {...stylex.props(pressable.base, motion.tint, focus.ring, styles.mention, enter.fade)}
          >
            <OrbMark sizePx={28} />
            <span {...stylex.props(styles.mentionText)}>
              <span {...stylex.props(styles.mentionName)}>@{ORB_NAME}</span>
              <span {...stylex.props(styles.mentionHint, layout.truncate)}>
                {!orb
                  ? "Lives on the board. Open the board to ask."
                  : inRoom
                    ? "Answers from the board and the call. Everyone sees the answer."
                    : `Answers just you and ${partnerName}.`}
              </span>
            </span>
          </button>
        )}
        <div
          {...stylex.props(
            styles.field,
            withOrb || addressingOrb ? styles.fieldOrb : !inRoom && styles.fieldPrivate,
          )}
        >
          {audienceLabel && (
            <div {...stylex.props(styles.fieldHead)}>
              <span {...stylex.props(styles.audience, !inRoom ? styles.audiencePrivate : styles.audienceOrb)}>
                {!inRoom && <Lock size={10} strokeWidth={2.75} aria-hidden="true" />}
                {audienceLabel}
              </span>
            </div>
          )}
          <div {...stylex.props(styles.composerRow)}>
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              disabled={partnerAway}
              onChange={(event) => {
                setInputValue(event.target.value);
                if (sendError) setSendError(null);
              }}
              onKeyDown={(event) => {
                if (offerOrb && event.key === "Tab") {
                  event.preventDefault();
                  completeMention();
                } else if (offerOrb && event.key === "Escape") {
                  event.stopPropagation();
                  setMentionDismissedFor(inputValue);
                }
              }}
              aria-label={
                withOrb ? `Private question to ${ORB_NAME}` : inRoom ? "Message everyone" : `Private message to ${partnerName}`
              }
              aria-describedby={[offerOrb ? mentionId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined}
              placeholder={placeholder}
              maxLength={MAX_MESSAGE_LENGTH}
              autoComplete="off"
              {...stylex.props(styles.input)}
            />
            <button
              type="submit"
              aria-label={addressingOrb ? `Ask ${ORB_NAME}` : "Send message"}
              disabled={!inputValue.trim() || partnerAway}
              {...stylex.props(
                pressable.base,
                motion.tint,
                focus.ring,
                styles.send,
                !inRoom && styles.sendPrivate,
                addressingOrb && styles.sendOrb,
              )}
            >
              <Send size={16} />
            </button>
          </div>
        </div>
        {sendError ? (
          <p role="status" {...stylex.props(styles.sendError)}>
            {sendError}
          </p>
        ) : hint ? (
          <p id={hintId} {...stylex.props(styles.hint, withOrb && styles.hintOrb)}>
            {withOrb && <Lock size={11} strokeWidth={2.5} aria-hidden="true" />}
            {hint}
          </p>
        ) : (
          tip && (
            <div {...stylex.props(styles.tip, enter.fade)} key={tip.id}>
              <span {...stylex.props(styles.tipMark)}>
                <OrbMark sizePx={12} />
              </span>
              <p {...stylex.props(styles.tipText)}>
                <span {...stylex.props(styles.tipLabel)}>Tip </span>
                {tip.text}
                {tip.example && (
                  <button
                    type="button"
                    onClick={() => putInBox(tip.example ?? "")}
                    title="Put this in the box"
                    {...stylex.props(focus.ring, styles.tipExample)}
                  >
                    {tip.example}
                  </button>
                )}
              </p>
              <Tooltip content="Turn off tips" side="top">
                <button
                  type="button"
                  onClick={turnTipsOff}
                  aria-label="Turn off tips"
                  {...stylex.props(pressable.base, motion.tint, focus.ring, styles.tipClose)}
                >
                  <X size={13} strokeWidth={2} />
                </button>
              </Tooltip>
            </div>
          )
        )}
      </form>
    </div>
  );
}
