import type * as React from "react";
import { Lock, MessageSquareLock } from "lucide-react";
import { Avatar, MenuContent, MenuGroup, MenuGroupLabel, MenuItem, MenuRoot, MenuTrigger, Tooltip } from "@orbmeet/ui/react";
import { focus, layout, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { accent, ink, neutral, surface, violet } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { ORB_NAME } from "@/modules/meetings/client/orb";
import type { TimelineThread } from "@/modules/meetings/client/timeline-model";
import { OrbMark } from "./timeline-orb";

const styles = stylex.create({
  bar: {
    display: "flex",
    alignItems: "center",
    gap: space.s1,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: neutral.n100,
    paddingInline: space.s3,
    paddingBlock: space.s2,
  },
  tabs: {
    display: "flex",
    minWidth: 0,
    flexGrow: 1,
    gap: space.s1,
    overflowX: "auto",
    scrollbarWidth: "none",
  },
  tab: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s1_5,
    height: 30,
    maxWidth: "11rem",
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent",
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
    paddingInline: space.s2_5,
    fontSize: text.xs,
    fontWeight: weight.semibold,
    color: ink.muted,
    cursor: "pointer",
  },
  /** The room's stream: the accent, like every other "everyone" in the room. */
  roomOn: {
    borderColor: accent.a100,
    backgroundColor: { default: accent.a50, [env.hoverable]: { default: accent.a50, ":hover": accent.a50 } },
    color: accent.a800,
  },
  /** A private stream: slate and a lock, the one colour the room spends on privacy. */
  privateOn: {
    borderColor: neutral.n800,
    backgroundColor: { default: neutral.n800, [env.hoverable]: { default: neutral.n800, ":hover": neutral.n800 } },
    color: ink.onDark,
  },
  /** Your own thread with Orb: Orb's violet, and private all the same. */
  orbOn: {
    borderColor: violet.v800,
    backgroundColor: { default: violet.v800, [env.hoverable]: { default: violet.v800, ":hover": violet.v800 } },
    color: ink.onDark,
  },
  away: { opacity: 0.6 },
  badge: {
    display: "inline-grid",
    minWidth: 16,
    height: 16,
    placeItems: "center",
    borderRadius: radii.pill,
    backgroundColor: accent.a600,
    paddingInline: 4,
    fontSize: text.xs3,
    fontWeight: weight.bold,
    fontVariantNumeric: "tabular-nums",
    color: ink.onAccent,
  },
  /**
   * Starting a private thread, said in a word. It was a lock in a dashed box,
   * which read as a placeholder, not as a way to write to one person.
   */
  start: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s1,
    height: 30,
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    backgroundColor: { default: surface.raised, [env.hoverable]: { default: surface.raised, ":hover": neutral.n50 } },
    paddingInline: space.s2,
    fontFamily: "inherit",
    fontSize: text.xs,
    fontWeight: weight.semibold,
    color: neutral.n700,
    cursor: "pointer",
  },
  menu: { minWidth: "14rem", maxHeight: "18rem", overflowY: "auto" },
  person: { display: "flex", alignItems: "center", gap: space.s2 },
});

interface TimelineThreadSummary {
  withId: string;
  withName: string;
  unread: number;
  /** Still in the meeting. */
  present: boolean;
}

export interface TimelineThreadsProps {
  active: TimelineThread;
  threads: readonly TimelineThreadSummary[];
  roomUnread: number;
  /** Your own thread with Orb; undefined where Orb has no part in the room. */
  orb?: { unread: number };
  /** Everyone else here, who a private thread may be started with. */
  people: readonly { id: string; name: string }[];
  onSelect: (thread: TimelineThread) => void;
  onStart: (person: { id: string; name: string }) => void;
  /** At the bar's end, after the + button: the captions chip, where no header carries it. */
  end?: React.ReactNode;
}

function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span aria-label={`${count} unread`} {...stylex.props(styles.badge)}>
      {count > 9 ? "9+" : count}
    </span>
  );
}

/**
 * The Timeline's streams: the room's, one per private conversation, and your
 * own with Orb. A private thread is between you and one other person; nobody
 * else, the recording included, receives it.
 */
export function TimelineThreads({ active, threads, roomUnread, orb, people, onSelect, onStart, end }: TimelineThreadsProps) {
  const inRoom = active.kind === "room";
  const inOrb = active.kind === "orb";
  return (
    <div {...stylex.props(styles.bar)}>
      <div role="tablist" aria-label="Conversations" {...stylex.props(styles.tabs)}>
        <button
          type="button"
          role="tab"
          aria-selected={inRoom}
          onClick={() => onSelect({ kind: "room" })}
          {...stylex.props(pressable.base, motion.tint, focus.ring, styles.tab, inRoom && styles.roomOn)}
        >
          Everyone
          {!inRoom && <UnreadBadge count={roomUnread} />}
        </button>
        {threads.map((thread) => {
          const selected = active.kind === "private" && active.withId === thread.withId;
          return (
            <button
              key={thread.withId}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-label={`Private with ${thread.withName}${thread.present ? "" : ", who has left"}`}
              onClick={() => onSelect({ kind: "private", withId: thread.withId })}
              {...stylex.props(
                pressable.base,
                motion.tint,
                focus.ring,
                styles.tab,
                selected && styles.privateOn,
                !thread.present && !selected && styles.away,
              )}
            >
              <Lock size={11} strokeWidth={2.5} aria-hidden="true" />
              <span {...stylex.props(layout.truncate)}>{thread.withName}</span>
              {!selected && <UnreadBadge count={thread.unread} />}
            </button>
          );
        })}
        {orb && (
          <button
            type="button"
            role="tab"
            aria-selected={inOrb}
            aria-label={`Private with ${ORB_NAME}`}
            onClick={() => onSelect({ kind: "orb" })}
            {...stylex.props(pressable.base, motion.tint, focus.ring, styles.tab, inOrb && styles.orbOn)}
          >
            {inOrb ? <Lock size={11} strokeWidth={2.5} aria-hidden="true" /> : <OrbMark sizePx={14} />}
            {ORB_NAME}
            {!inOrb && <UnreadBadge count={orb.unread} />}
          </button>
        )}
      </div>
      {people.length > 0 && (
        <MenuRoot>
          <Tooltip content="Message someone privately" side="bottom">
            <MenuTrigger
              // The visible word leads the name, so saying "Private" presses it.
              aria-label="Private message to someone"
              {...stylex.props(pressable.base, motion.tint, focus.ring, styles.start)}
            >
              <MessageSquareLock size={14} strokeWidth={2} aria-hidden="true" />
              Private
            </MenuTrigger>
          </Tooltip>
          <MenuContent side="bottom" align="end" sx={styles.menu}>
            <MenuGroup>
              <MenuGroupLabel>Message privately</MenuGroupLabel>
              {people.map((person) => (
                <MenuItem key={person.id} onClick={() => onStart(person)}>
                  <span {...stylex.props(styles.person)}>
                    <Avatar name={person.name} sizePx={20} />
                    <span {...stylex.props(layout.truncate)}>{person.name}</span>
                  </span>
                </MenuItem>
              ))}
            </MenuGroup>
          </MenuContent>
        </MenuRoot>
      )}
      {end}
    </div>
  );
}
