import * as React from "react";
import {
  AlertCircle,
  AppWindow,
  CalendarClock,
  DoorClosed,
  LinkIcon,
  LogIn,
  Timer,
  Users,
} from "lucide-react";
import { motion, pressable, safe } from "@orbmeet/ui/styles/atoms";
import { accent, danger, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { safeArea } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, tracking, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";

import type { JoinErrorKind } from "@/modules/meetings/client/join-error-presentation";
import { inkWash } from "@orbmeet/ui/tokens/wash.stylex";

const styles = stylex.create({
  screen: {
    display: "flex",
    height: "100dvh",
    flexDirection: "column",
    overflow: "hidden",
    backgroundColor: surface.canvas,
  },
  center: {
    display: "flex",
    minHeight: 0,
    flexGrow: 1,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    paddingInline: space.s5,
    paddingTop: `calc(${safeArea.top} + 1rem)`,
    paddingBottom: `calc(${safeArea.bottom} + 1rem)`,
  },
  /**
   * The negative bias is the optical centring: a block sitting exactly half-way
   * down a phone screen reads as lower than centre.
   */
  block: {
    width: "100%",
    maxWidth: "24rem",
    transform: "translateY(-1rem)",
    textAlign: "center",
  },
  glyph: {
    marginInline: "auto",
    marginBottom: space.s5,
    display: "flex",
    height: 56,
    width: 56,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.panel,
  },
  /** Calm for "nothing is broken, just not now". */
  glyphNeutral: { backgroundColor: neutral.n200, color: neutral.n600 },
  /** Alarming only when something actually went wrong. */
  glyphAlarm: { backgroundColor: danger.d100, color: danger.d600 },
  title: {
    margin: 0,
    fontSize: text.xl,
    lineHeight: leading.xl,
    fontWeight: weight.semibold,
    letterSpacing: tracking.tight,
    color: ink.strong,
  },
  detail: {
    marginInline: "auto",
    marginTop: space.s2,
    marginBottom: 0,
    fontSize: text.sm,
    lineHeight: leading.relaxed,
    color: ink.body,
  },
  code: {
    marginTop: space.s4,
    marginBottom: 0,
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    backgroundColor: surface.raised,
    paddingInline: space.s3,
    paddingBlock: space.s1,
    fontVariantNumeric: "tabular-nums",
    fontSize: text.xs,
    color: ink.muted,
  },
  actions: { marginTop: space.s7, display: "flex", flexDirection: "column", gap: space.s2 },
  /** Full-width 48pt targets: this screen is read one-handed, on a phone. */
  action: {
    display: "flex",
    height: 48,
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.pill,
    borderWidth: 0,
    fontFamily: "inherit",
    fontSize: text.sm,
  },
  primary: {
    backgroundColor: { default: `${accent.a600}`, ":active": `${accent.a700}` },
    fontWeight: weight.semibold,
    color: ink.onAccent,
    boxShadow: `0 1px 2px ${inkWash.x06}`,
  },
  secondary: {
    backgroundColor: { default: "transparent", ":active": neutral.n200 },
    fontWeight: weight.medium,
    color: ink.body,
  },
});

const KIND_ICONS: Record<JoinErrorKind, React.ElementType> = {
  full: Users,
  busy: CalendarClock,
  ended: DoorClosed,
  "not-started": CalendarClock,
  closed: DoorClosed,
  elsewhere: AppWindow,
  denied: AlertCircle,
  "not-found": LinkIcon,
  auth: LogIn,
  "rate-limited": Timer,
  unknown: AlertCircle,
};

/** Calm for "nothing is broken, just not now"; alarming only when it is. */
const NEUTRAL_KINDS: ReadonlySet<JoinErrorKind> = new Set<JoinErrorKind>([
  "full",
  "busy",
  "ended",
  "not-started",
  "closed",
  "elsewhere",
  "rate-limited",
]);

interface MeetingStatusAction {
  label: string;
  onClick: () => void;
}

export interface MeetingStatusScreenProps {
  kind: JoinErrorKind;
  title: string;
  detail: string;
  primaryAction?: MeetingStatusAction;
  secondaryAction?: MeetingStatusAction;
  /** Meeting code, shown so the reader can confirm they used the right link. */
  meetingCode?: string;
}

/**
 * The screen someone lands on when they can't get into a meeting.
 *
 * The version this replaces was a shrink-to-fit card holding one 16px line of
 * text, centred in a full-height beige field. On a 402×874 phone that rendered
 * as a ~150pt box adrift in empty space — which is why it read as broken rather
 * than as an answer.
 *
 * Three things fix it, and none of them are "make the box bigger":
 *
 * - **Optical centring, not mathematical.** The block sits slightly above the
 *   middle, where the eye expects a headline. Dead-centre content in a tall
 *   viewport looks abandoned.
 * - **A width that means something.** Full-bleed minus a margin on a phone,
 *   capped at a readable measure above it, so the card is sized by its content
 *   rather than shrink-wrapped around one sentence.
 * - **A real hierarchy.** Icon, title, explanation, then actions at full-width
 *   48pt targets — instead of one bold line and two links of equal weight.
 */
export function MeetingStatusScreen({
  kind,
  title,
  detail,
  primaryAction,
  secondaryAction,
  meetingCode,
}: MeetingStatusScreenProps) {
  const Icon = KIND_ICONS[kind];
  const isNeutral = NEUTRAL_KINDS.has(kind);

  return (
    <div {...stylex.props(styles.screen, safe.padX)}>
      <div {...stylex.props(styles.center)}>
        <div {...stylex.props(styles.block)}>
          <div {...stylex.props(styles.glyph, isNeutral ? styles.glyphNeutral : styles.glyphAlarm)}>
            <Icon size={28} strokeWidth={1.75} />
          </div>

          <h1 {...stylex.props(styles.title)}>{title}</h1>
          <p {...stylex.props(styles.detail)}>{detail}</p>

          {meetingCode && <p {...stylex.props(styles.code)}>{meetingCode}</p>}

          <div {...stylex.props(styles.actions)}>
            {primaryAction && (
              <button
                type="button"
                onClick={primaryAction.onClick}
                {...stylex.props(pressable.base, motion.tint, styles.action, styles.primary)}
              >
                {primaryAction.label}
              </button>
            )}
            {secondaryAction && (
              <button
                type="button"
                onClick={secondaryAction.onClick}
                {...stylex.props(pressable.base, motion.tint, styles.action, styles.secondary)}
              >
                {secondaryAction.label}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
