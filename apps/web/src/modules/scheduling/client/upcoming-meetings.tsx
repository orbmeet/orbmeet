import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { ArrowRight, CalendarDays, CalendarPlus, Check, Copy, Pencil, X } from "lucide-react";
import * as stylex from "@stylexjs/stylex";

import { beginMeetingEntryFlow } from "@/modules/meetings/client/entry-metrics";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";
import { myUpcomingMeetingSchedulesQueryOptions } from "@/app/query-client/queries/meetings";
import {
  CancelScheduledMeetingDialog,
  ScheduleMeetingDialog,
  type UpcomingMeetingSchedule,
} from "@/modules/scheduling/client/schedule-meeting-dialog";
import { Button, EmptyState, buttonStyles } from "@orbmeet/ui/react";
import { focus, layout, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { surfaces } from "@orbmeet/ui/styles/surfaces";
import { accent, neutral, success } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { Section } from "@/app/shell/section";

const styles = stylex.create({
  list: { padding: space.s1, borderRadius: 20 },
  dateMonth: { fontSize: text.xs2, fontWeight: weight.semibold, textTransform: "uppercase" },
  dateDay: { fontSize: text.xl, lineHeight: leading.xl, fontWeight: weight.medium },
  row: {
    display: "flex",
    flexWrap: { default: "wrap", [bp.lg]: "nowrap" },
    alignItems: "center",
    gap: space.s3,
    paddingInline: space.s4,
    paddingBlock: space.s3_5,
    // The old `divide-y`: every row but the first carries the hairline.
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: neutral.n100,
  },
  tile: {
    display: "flex",
    height: 52,
    width: 52,
    flexDirection: "column",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    backgroundColor: accent.a50,
    color: accent.a700,
  },
  title: {
    fontSize: text.sm,
    fontWeight: weight.semibold,
    color: neutral.n800,
  },
  details: { marginTop: space.s0_5, fontSize: text.xs, color: neutral.n500 },
  body: { minWidth: 0, flexGrow: 1, flexBasis: { default: "calc(100% - 5rem)", [bp.lg]: "auto" } },
  /**
   * On a phone the actions wrap below the text; the margin keeps them clear of
   * the wrapped title line until the row goes single-line at `sm`.
   */
  actions: {
    marginLeft: { default: "4rem", [bp.lg]: 0 },
    display: "flex",
    alignItems: "center",
    gap: space.s1,
  },
  copy: {
    display: "flex",
    height: 32,
    width: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.control,
    color: { default: neutral.n400, [env.hoverable]: { default: neutral.n400, ":hover": neutral.n700 } },
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
  },
  copied: { color: success.s600 },
  /** Icon-only on a phone; the label arrives once there is room for it. */
  compactButton: { paddingInline: { default: space.s2, [bp.lg]: space.s3 } },
  compactLabel: { display: { default: "none", [bp.lg]: "inline" } },
  allLink: {
    fontSize: text.xs,
    lineHeight: leading.xs,
    fontWeight: weight.medium,
    color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, ":hover": accent.a700 } },
    textDecorationLine: "none",
  },
  loadMore: { marginTop: space.s3, display: "flex", justifyContent: "center" },
});

function formatMeetingTime(meeting: UpcomingMeetingSchedule): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: meeting.timeZone,
    timeZoneName: "short",
  }).format(new Date(meeting.startsAt));
}

function UpcomingMeetingRow({
  meeting,
  onReschedule,
  onCancel,
}: {
  meeting: UpcomingMeetingSchedule;
  onReschedule: () => void;
  onCancel: () => void;
}) {
  const { copied, copy } = useCopyToClipboard();
  const title = meeting.title?.trim() || formatMeetingTime(meeting);
  const details = [
    ...(meeting.title?.trim() ? [formatMeetingTime(meeting)] : []),
    meeting.spaceName ?? `Organized by ${meeting.organizerName}`,
    ...(meeting.attendeeCount > 0 ? [`${meeting.attendeeCount} invited`] : []),
  ];

  return (
    <div {...stylex.props(styles.row)}>
      <span {...stylex.props(styles.tile)} aria-hidden="true">
        <span {...stylex.props(styles.dateMonth)}>{new Intl.DateTimeFormat(undefined, { month: "short", timeZone: meeting.timeZone }).format(new Date(meeting.startsAt))}</span>
        <span {...stylex.props(styles.dateDay)}>{new Intl.DateTimeFormat(undefined, { day: "numeric", timeZone: meeting.timeZone }).format(new Date(meeting.startsAt))}</span>
      </span>
      <div {...stylex.props(styles.body)}>
        <p {...stylex.props(styles.title, layout.truncate)}>{title}</p>
        <p {...stylex.props(styles.details, layout.truncate)}>{details.join(" · ")}</p>
      </div>
      <div {...stylex.props(styles.actions)}>
        <button
          type="button"
          onClick={() => void copy(`${window.location.origin}/${meeting.code}`)}
          aria-label="Copy join link"
          title="Copy join link"
          {...stylex.props(pressable.base, motion.tint, focus.ring, styles.copy)}
        >
          {copied
            ? <Check size={14} {...stylex.props(styles.copied)} />
            : <Copy size={14} />}
        </button>
        {meeting.canManage ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Reschedule Meeting"
              onClick={onReschedule}
              sx={styles.compactButton}
            >
              <Pencil size={13} /> <span {...stylex.props(styles.compactLabel)}>Reschedule</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Cancel Meeting"
              onClick={onCancel}
              sx={styles.compactButton}
            >
              <X size={14} /> <span {...stylex.props(styles.compactLabel)}>Cancel</span>
            </Button>
          </>
        ) : null}
      </div>
      <a
        href={`/${meeting.code}`}
        onClick={() => beginMeetingEntryFlow({ source: "meetings-upcoming", code: meeting.code })}
        {...stylex.props(...buttonStyles({ size: "sm", variant: "secondary" }))}
      >
        Open
        <ArrowRight size={12} />
      </a>
    </div>
  );
}

export function UpcomingMeetings({
  limit,
  showAllLink = false,
  onSchedule,
  scheduleActionLabel,
  spaceId,
  compactEmpty = false,
}: {
  limit?: number;
  showAllLink?: boolean;
  onSchedule?: () => void;
  scheduleActionLabel?: string;
  spaceId?: string;
  /**
   * When nothing is scheduled, say so in one line under the section heading
   * instead of a full empty state — for pages where upcoming meetings are one
   * section among several, not the page's whole subject.
   */
  compactEmpty?: boolean;
}) {
  const query = useSuspenseInfiniteQuery(myUpcomingMeetingSchedulesQueryOptions(spaceId));
  const [editing, setEditing] = useState<UpcomingMeetingSchedule | null>(null);
  const [canceling, setCanceling] = useState<UpcomingMeetingSchedule | null>(null);
  const meetings = query.data.pages.flatMap((page) => page.schedules)
    .filter((meeting) => meeting.state === "upcoming" || meeting.state === "late_start")
    .slice(0, limit);

  if (meetings.length === 0 && compactEmpty) {
    return (
      <Section
        title="Upcoming"
        description="Nothing scheduled yet."
        action={onSchedule ? (
          <Button variant="secondary" size="sm" onClick={onSchedule}>
            <CalendarPlus size={14} />{scheduleActionLabel ?? "Schedule a meeting"}
          </Button>
        ) : undefined}
      >
        {null}
      </Section>
    );
  }

  if (meetings.length === 0) return onSchedule ? (
    <EmptyState
      icon={CalendarDays}
      title={spaceId ? "No upcoming meetings" : "Nothing on the calendar yet"}
      description={spaceId
        ? "Schedule the next time this Space will meet."
        : "Set a time, invite your people, and we’ll keep the details here."}
      action={(
        <Button variant="secondary" onClick={onSchedule}>
          <CalendarPlus size={16} />{scheduleActionLabel ?? "Schedule a meeting"}
        </Button>
      )}
    />
  ) : null;

  return (
    <Section
      title="Upcoming"
      action={onSchedule && scheduleActionLabel ? (
        <Button variant="secondary" size="sm" onClick={onSchedule}>
          <CalendarPlus size={14} />{scheduleActionLabel}
        </Button>
      ) : showAllLink ? (
          <Link to="/calendar" {...stylex.props(styles.allLink, motion.tint)}>
            Open calendar →
          </Link>
        ) : undefined}
    >
      <div {...stylex.props(surfaces.card, styles.list)}>
        {meetings.map((meeting) => (
          <UpcomingMeetingRow
            key={meeting.id}
            meeting={meeting}
            onReschedule={() => setEditing(meeting)}
            onCancel={() => setCanceling(meeting)}
          />
        ))}
      </div>
      {!limit && query.hasNextPage ? (
        <div {...stylex.props(styles.loadMore)}>
          <Button
            variant="secondary"
            size="sm"
            loading={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            Load more upcoming Meetings
          </Button>
        </div>
      ) : null}
      <ScheduleMeetingDialog
        open={Boolean(editing)}
        onOpenChange={(open) => !open && setEditing(null)}
        schedule={editing}
      />
      <CancelScheduledMeetingDialog
        open={Boolean(canceling)}
        onOpenChange={(open) => !open && setCanceling(null)}
        schedule={canceling}
      />
    </Section>
  );
}
