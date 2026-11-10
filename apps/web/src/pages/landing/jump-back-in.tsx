import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Link2 } from "lucide-react";
import { myThreadsQueryOptions } from "@/app/query-client/queries/meetings";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";
import { beginMeetingEntryFlow } from "@/modules/meetings/client/entry-metrics";
import { formatMeetingDate } from "@/modules/meetings/client/components/meeting-format";
import type { Thread } from "@/modules/meetings/contract/threads";
import { SpaceTile } from "@/modules/spaces/client/components/space-tile";
import { focus, motion, touch } from "@orbmeet/ui/styles/atoms";
import { accent, border, ink, live, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";

/** Enough to cover a personal link, a Space or two and a live room; Home has the rest. */
const MAX_ROWS = 4;

const styles = stylex.create({
  section: { width: "100%" },
  label: { margin: 0, marginBottom: space.s2, marginInlineStart: space.s1, fontSize: text.control, fontWeight: weight.medium, color: ink.muted },
  list: {
    margin: 0,
    padding: 0,
    listStyle: "none",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: border.subtle,
    borderRadius: 16,
    overflow: "hidden",
    textAlign: "start",
  },
  row: {
    display: "grid",
    gridTemplateColumns: "40px minmax(0, 1fr) auto",
    alignItems: "center",
    gap: space.s3_5,
    paddingBlock: space.s3_5,
    paddingInlineStart: space.s5,
    paddingInlineEnd: space.s4,
  },
  divided: { borderTopWidth: 1, borderTopStyle: "solid", borderTopColor: border.subtle },
  liveRow: { backgroundColor: live.l50 },
  icon: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: neutral.n100,
    color: neutral.n600,
  },
  words: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  title: { fontSize: "0.9375rem", fontWeight: weight.medium, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  meta: { display: "flex", alignItems: "center", gap: space.s1_5, fontSize: text.control, color: ink.muted, minWidth: 0 },
  liveMeta: { color: live.l700 },
  liveDot: { width: 7, height: 7, flexShrink: 0, borderRadius: "50%", backgroundColor: live.l500 },
  code: { fontFamily: fonts.mono },
  actions: { display: "flex", alignItems: "center", gap: space.s1 },
  action: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s1_5,
    height: 40,
    paddingInline: space.s4,
    borderWidth: 0,
    borderRadius: 10,
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: text.sm,
    fontWeight: weight.medium,
    textDecorationLine: "none",
    color: ink.strong,
    backgroundColor: { default: neutral.n100, [env.hoverable]: { default: neutral.n100, ":hover": neutral.n150 } },
  },
  actionLive: { color: ink.onDark, backgroundColor: { default: neutral.n900, [env.hoverable]: { default: neutral.n900, ":hover": neutral.n800 } } },
  quiet: { paddingInline: space.s3, color: ink.body, backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": surface.sunken } } },
  more: {
    display: "inline-flex",
    alignItems: "center",
    marginTop: space.s2,
    marginInlineStart: space.s1,
    fontSize: text.sm,
    color: { default: ink.body, [env.hoverable]: { default: ink.body, ":hover": accent.a700 } },
    textDecorationLine: "none",
    borderRadius: 6,
  },
});

function liveCount(thread: Thread): number {
  return thread.openMeeting?.participantCount ?? 0;
}

/** Where pressing the row's button goes: straight into a room, or to a Space to start one there. */
function destination(thread: Thread): { code: string; label: "Join" | "Start" } | { slug: string } {
  if (thread.openMeeting) return { code: thread.openMeeting.code, label: "Join" };
  if (thread.kind === "space") return { slug: thread.slug };
  return { code: thread.code, label: "Start" };
}

function Meta({ thread }: { thread: Thread }) {
  const count = liveCount(thread);
  if (count > 0) {
    return (
      <span {...stylex.props(styles.meta, styles.liveMeta)}>
        <span {...stylex.props(styles.liveDot)} />
        {count === 1 ? "1 person in it now" : `${count} people in it now`}
      </span>
    );
  }
  if (thread.openMeeting) return <span {...stylex.props(styles.meta)}>Open, nobody in it yet</span>;

  const last = thread.latestMeeting?.endedAt ?? null;
  const when = last ? `last met ${formatMeetingDate(last).replace(/^(Today|Yesterday)$/, (day) => day.toLowerCase())}` : null;
  if (thread.kind === "personal") {
    return (
      <span {...stylex.props(styles.meta)}>
        <span {...stylex.props(styles.code)}>{thread.code}</span>
        {when ? <span>· {when}</span> : null}
      </span>
    );
  }
  return <span {...stylex.props(styles.meta)}>{when ? `Space · ${when}` : "Space"}</span>;
}

function RoomRow({ thread, first }: { thread: Thread; first: boolean }) {
  const { copied, copy } = useCopyToClipboard();
  const isLive = liveCount(thread) > 0;
  const target = destination(thread);
  const title = thread.kind === "personal" ? "Your link" : thread.title;

  return (
    <li {...stylex.props(styles.row, !first && styles.divided, isLive && styles.liveRow)}>
      {thread.kind === "space" ? (
        <SpaceTile name={thread.title} size="md" />
      ) : (
        <span aria-hidden="true" {...stylex.props(styles.icon)}>
          <Link2 size={18} strokeWidth={1.9} />
        </span>
      )}
      <span {...stylex.props(styles.words)}>
        <span {...stylex.props(styles.title)}>{title}</span>
        <Meta thread={thread} />
      </span>
      <span {...stylex.props(styles.actions)}>
        {thread.kind === "personal" ? (
          <button
            type="button"
            onClick={() => void copy(`${window.location.origin}/${thread.code}`)}
            aria-label={copied ? "Copied your link" : "Copy your link"}
            {...stylex.props(styles.action, styles.quiet, motion.tint, focus.ring)}
          >
            {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
          </button>
        ) : null}
        {"slug" in target ? (
          <Link
            to="/space/$spaceSlug"
            params={{ spaceSlug: target.slug }}
            aria-label={`Open ${thread.title}`}
            {...stylex.props(styles.action, motion.tint, focus.ring)}
          >
            Open
          </Link>
        ) : (
          // A full page load, as everywhere a meeting is entered: the room needs
          // its own security headers (camera, microphone, media servers).
          <a
            href={`/${target.code}`}
            onClick={() => beginMeetingEntryFlow({ source: "landing-rejoin", code: target.code })}
            aria-label={`${target.label} ${title}`}
            {...stylex.props(styles.action, isLive && styles.actionLive, motion.tint, focus.ring)}
          >
            {target.label}
          </a>
        )}
      </span>
    </li>
  );
}

/**
 * For someone signed in, the landing page is a way back into their rooms:
 * their own link, their Spaces, and any meeting still open — whichever has
 * people in it first, the order Home uses.
 */
export function JumpBackIn() {
  const { data } = useQuery(myThreadsQueryOptions());
  const threads = data?.threads.slice(0, MAX_ROWS) ?? [];
  if (threads.length === 0) return null;

  return (
    <section aria-labelledby="jump-back-in" {...stylex.props(styles.section)}>
      <h2 id="jump-back-in" {...stylex.props(styles.label)}>Jump back in</h2>
      <ul {...stylex.props(styles.list)}>
        {threads.map((thread, index) => (
          <RoomRow key={`${thread.kind}:${thread.id}`} thread={thread} first={index === 0} />
        ))}
      </ul>
      <Link to="/home" {...stylex.props(touch.target, styles.more, focus.ring, motion.tint)}>
        All meetings and spaces →
      </Link>
    </section>
  );
}
