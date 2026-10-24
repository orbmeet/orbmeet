import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarCheck, Check, Copy } from "lucide-react";
import * as stylex from "@stylexjs/stylex";

import { cancelMeetingSchedule, createMeetingSchedule, rescheduleMeeting } from "@/modules/scheduling/server/api.functions";
import type { getMyUpcomingMeetingSchedules } from "@/modules/scheduling/server/queries.functions";
import { getErrorMessage } from "@/lib/error-inspection";
import { queryKeys } from "@/app/query-client/query-keys";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";
import { Button } from "@orbmeet/ui/react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@orbmeet/ui/react";
import { Input } from "@orbmeet/ui/react";
import { Select } from "@orbmeet/ui/react";
import { TimeZoneSelect } from "@orbmeet/ui/react";
import { focus, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { accent, danger, ink, neutral, success, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { mySpacesQueryOptions } from "@/app/query-client/queries/spaces";
import { myThreadsQueryOptions } from "@/app/query-client/queries/meetings";
import { sessionQueryOptions } from "@/app/query-client/queries/session";
import {
  MeetingEntryModeField,
  type EntryModeChoice,
} from "@/modules/meetings/client/components/meeting-policy-fields";

const MAX_NOTIFICATIONS = 10;

const styles = stylex.create({
  body: { display: "flex", flexDirection: "column", gap: space.s4 },
  cancelBody: { display: "flex", flexDirection: "column", gap: space.s3 },
  grid: {
    display: "grid",
    gap: space.s3,
    gridTemplateColumns: { default: "minmax(0, 1fr)", [bp.sm]: "repeat(2, minmax(0, 1fr))" },
  },
  startGrid: {
    display: "grid",
    gap: space.s3,
    gridTemplateColumns: { default: "minmax(0, 1fr)", [bp.sm]: "minmax(0, 1fr) 8rem" },
  },
  /** A label that wraps its control, for the native inputs without a component. */
  label: {
    display: "block",
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    color: neutral.n700,
  },
  optional: { fontWeight: weight.normal, color: neutral.n400 },
  labelControl: { marginTop: space.s1_5 },
  /**
   * The native duration select and guest textarea: the same focus surface the
   * `Input` component draws, restated because these predate it.
   */
  nativeControl: {
    height: 40,
    width: "100%",
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: neutral.n300, ":focus-visible": accent.a400 },
    backgroundColor: surface.raised,
    paddingInline: space.s3,
    fontFamily: "inherit",
    // 16px under a finger: iOS zooms the page into a smaller focused field (see styles.css).
    fontSize: { default: text.sm, [env.touch]: text.base },
    lineHeight: leading.sm,
    color: ink.strong,
    outlineStyle: "none",
    boxShadow: { default: "none", ":focus-visible": `0 0 0 2px color-mix(in oklab, ${accent.a500} 20%, transparent)` },
  },
  textarea: {
    height: "auto",
    paddingBlock: space.s2,
    resize: "none",
    "::placeholder": { color: neutral.n400 },
  },
  count: {
    marginTop: space.s1,
    display: "block",
    fontSize: text.xs,
    lineHeight: leading.sm,
  },
  countOver: { fontWeight: weight.medium, color: danger.d600 },
  countOk: { fontWeight: weight.normal, color: neutral.n500 },
  note: {
    margin: 0,
    fontSize: text.xs,
    lineHeight: leading.sm,
    color: neutral.n500,
  },
  finePrint: { margin: 0, fontSize: text.xs, lineHeight: leading.sm, color: neutral.n400 },
  error: {
    margin: 0,
    fontSize: text.xs,
    fontWeight: weight.semibold,
    color: danger.d600,
  },

  confirmTitle: { display: "inline-flex", alignItems: "center", gap: space.s2 },
  confirmGlyph: { color: success.s600 },
  copyButton: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s3,
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: neutral.n200, [env.hoverable]: { default: neutral.n200, ":hover": accent.a300 } },
    backgroundColor: { default: neutral.n50, [env.hoverable]: { default: neutral.n50, ":hover": surface.raised } },
    paddingInline: space.s3,
    paddingBlock: space.s2_5,
    textAlign: "left",
  },
  copyCode: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: fonts.mono,
    fontSize: text.sm,
    color: neutral.n700,
  },
  copiedLabel: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s1_5,
    fontSize: text.xs,
    fontWeight: weight.medium,
    color: success.s600,
  },
  /** Colours when the whole row is hovered, not just the label under the pointer. */
  copyLabel: { color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, [stylex.when.ancestor(":hover")]: accent.a700 } } },
});

export type UpcomingMeetingSchedule = Awaited<
  ReturnType<typeof getMyUpcomingMeetingSchedules>
>["schedules"][number];

interface WallClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function formatInTimeZone(date: Date, timeZone: string): WallClockParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
  };
}

function wallClockValue(parts: WallClockParts): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

function isoToWallClock(iso: string, timeZone: string): string {
  return wallClockValue(formatInTimeZone(new Date(iso), timeZone));
}

function wallClockToIso(value: string, timeZone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Choose a valid date and time.");
  const desired: WallClockParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
  const desiredUtc = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute,
  );
  let instant = new Date(desiredUtc);
  for (let attempt = 0; attempt < 3; attempt++) {
    const observed = formatInTimeZone(instant, timeZone);
    const observedUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
    );
    instant = new Date(instant.getTime() + desiredUtc - observedUtc);
  }
  if (wallClockValue(formatInTimeZone(instant, timeZone)) !== value) {
    throw new Error("That local time does not exist in the selected time zone.");
  }
  return instant.toISOString();
}

function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function defaultStart(timeZone: string): string {
  // Keep the default one-hour reminder in the future even after rounding the
  // meeting start down to second precision at an exact quarter hour.
  const next = new Date(Date.now() + 61 * 60_000);
  next.setMinutes(Math.ceil(next.getMinutes() / 15) * 15, 0, 0);
  return isoToWallClock(next.toISOString(), timeZone);
}

function durationMinutes(schedule: UpcomingMeetingSchedule): number {
  return Math.round((Date.parse(schedule.endsAt) - Date.parse(schedule.startsAt)) / 60_000);
}

export function ScheduleMeetingDialog({
  open,
  onOpenChange,
  schedule,
  initialSpace,
  initialStartsAt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedule?: UpcomingMeetingSchedule | null;
  initialSpace?: { id: string; name: string; timeZone: string };
  /** A new meeting's proposed start, as an instant — the slot picked on the Calendar. */
  initialStartsAt?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <ScheduleMeetingDialogForm
          key={schedule?.id ?? initialSpace?.id ?? initialStartsAt ?? "new"}
          schedule={schedule}
          initialSpace={initialSpace}
          initialStartsAt={initialStartsAt}
          onOpenChange={onOpenChange}
        />
      </DialogContent>
    </Dialog>
  );
}

/** What the create call hands back — enough to share the link without email. */
interface CreatedSchedule {
  code: string;
  startsAt: string;
  timeZone: string;
  attendeeCount: number;
  spaceName: string | null;
  reminderMinutesBefore: number | null;
}

function ScheduleMeetingDialogForm({
  schedule,
  initialSpace,
  initialStartsAt,
  onOpenChange,
}: {
  schedule?: UpcomingMeetingSchedule | null;
  initialSpace?: { id: string; name: string; timeZone: string };
  initialStartsAt?: string;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const spacesQuery = useQuery(mySpacesQueryOptions());
  const threadsQuery = useQuery(myThreadsQueryOptions());
  const sessionQuery = useQuery(sessionQueryOptions());
  const isRescheduling = Boolean(schedule);
  const homeTimeZone = sessionQuery.data?.user.timeZone ?? null;
  const initialTimeZone = schedule?.timeZone
    ?? initialSpace?.timeZone
    ?? homeTimeZone
    ?? browserTimeZone();

  const [startsAt, setStartsAt] = useState(() =>
    schedule
      ? isoToWallClock(schedule.startsAt, schedule.timeZone)
      : // A picked slot that is already past (or about to be) falls back to the
        // next quarter hour, as if nothing had been picked.
        initialStartsAt && Date.parse(initialStartsAt) > Date.now() + 61 * 60_000
        ? isoToWallClock(initialStartsAt, initialTimeZone)
        : defaultStart(initialTimeZone),
  );
  const [duration, setDuration] = useState(schedule ? durationMinutes(schedule) : 30);
  const [timeZone, setTimeZone] = useState(initialTimeZone);
  const [title, setTitle] = useState(schedule?.title ?? "");
  const [context, setContext] = useState(
    schedule?.spaceId
      ? `space:${schedule.spaceId}`
      : initialSpace
        ? `space:${initialSpace.id}`
        : schedule?.meetingLinkReusePolicy === "reusable"
          ? `link:${schedule.meetingLinkId}`
          : "new-personal",
  );
  const [attendeeText, setAttendeeText] = useState("");
  const [joinPolicy, setJoinPolicy] = useState<EntryModeChoice>("open");
  const [reminder, setReminder] = useState(
    schedule?.reminderMinutesBefore == null
      ? schedule ? "off" : "60"
      : String(schedule.reminderMinutesBefore),
  );
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedSchedule | null>(null);
  // One key per intent. A submit whose response never arrived — a dropped
  // connection, a reloaded tab, a second click while the first request is
  // still in flight — replays the schedule that was already created instead of
  // putting a second identical meeting on the calendar and mailing every
  // attendee twice. Retying the *same* form keeps the key; changing any field
  // makes it a different request, which the server refuses to fold into the
  // first, so it has to mint a new one. Two deliberately identical meetings
  // scheduled in separate sittings come from separate dialogs, and so from
  // separate keys.
  const idempotency = useRef<{ signature: string; key: string } | null>(null);
  const destinationTouched = useRef(false);
  const startsAtTouched = useRef(false);
  const timeZoneTouched = useRef(false);
  const createIdempotencyKey = (signature: string): string => {
    if (idempotency.current?.signature !== signature) {
      idempotency.current = { signature, key: crypto.randomUUID() };
    }
    return idempotency.current.key;
  };

  const mutation = useMutation({
    mutationFn: async (): Promise<CreatedSchedule | null> => {
      const startsAtIso = wallClockToIso(startsAt, timeZone.trim());
      if (schedule) {
        await rescheduleMeeting({
          data: {
            scheduleId: schedule.id,
            expectedRevision: schedule.revision,
            startsAt: startsAtIso,
            durationMinutes: duration,
            timeZone: timeZone.trim(),
            reminderMinutesBefore: reminder === "off" ? null : Number(reminder),
          },
        });
        return null;
      }
      const attendees = attendeeText
        .split(/[\n,;]+/)
        .map((email) => email.trim())
        .filter(Boolean)
        .map((email) => ({ email }));
      const request = {
        title: title.trim() || undefined,
        startsAt: startsAtIso,
        durationMinutes: duration,
        timeZone: timeZone.trim(),
        spaceId: context.startsWith("space:") ? context.slice("space:".length) : undefined,
        meetingLinkId: context.startsWith("link:") ? context.slice("link:".length) : undefined,
        attendees: context.startsWith("space:") ? [] : attendees,
        joinPolicy,
        reminderMinutesBefore: reminder === "off" ? null : Number(reminder),
      };
      const result = await createMeetingSchedule({
        data: {
          ...request,
          idempotencyKey: createIdempotencyKey(JSON.stringify(request)),
        },
      });
      return {
        code: result.code,
        startsAt: result.startsAt,
        timeZone: result.timeZone,
        attendeeCount: result.attendeeCount,
        spaceName: result.spaceName,
        reminderMinutesBefore: result.reminderMinutesBefore,
      };
    },
    onMutate: () => setError(null),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.meetings.upcomingSchedules(),
      });
      if (!result) {
        onOpenChange(false);
        return;
      }
      setCreated(result);
    },
    onError: (caught) => {
      setError(getErrorMessage(caught, "Could not save the scheduled meeting."));
    },
  });

  const attendeeCount = useMemo(
    () => attendeeText.split(/[\n,;]+/).map((value) => value.trim()).filter(Boolean).length,
    [attendeeText],
  );
  const manageableSpaces = useMemo(
    () => (spacesQuery.data?.spaces ?? []).filter((space) => space.capabilities.canManage),
    [spacesQuery.data?.spaces],
  );
  const personalLinks = useMemo(
    () => (threadsQuery.data?.threads ?? []).filter((thread) => thread.kind === "personal"),
    [threadsQuery.data?.threads],
  );
  useEffect(() => {
    const personalLink = personalLinks[0];
    if (!schedule && !initialSpace && personalLink && !destinationTouched.current) {
      setContext(`link:${personalLink.id}`);
    }
  }, [initialSpace, personalLinks, schedule]);
  useEffect(() => {
    if (
      !schedule
      && !initialSpace
      && homeTimeZone
      && !destinationTouched.current
      && !timeZoneTouched.current
    ) {
      setTimeZone(homeTimeZone);
      if (!startsAtTouched.current) setStartsAt(defaultStart(homeTimeZone));
    }
  }, [homeTimeZone, initialSpace, schedule]);

  const isSpaceMeeting = context.startsWith("space:");
  const isReusablePersonalMeeting = context.startsWith("link:");
  const selectedSpace = manageableSpaces.find(
    (space) => space.id === context.slice("space:".length),
  );
  const selectedSpaceName = selectedSpace?.name
    ?? (context === `space:${initialSpace?.id}` ? initialSpace?.name : undefined);
  const dialogTitle = isRescheduling
    ? isSpaceMeeting
      ? `Reschedule the Meeting in ${selectedSpaceName ?? "this Space"}`
      : "Reschedule a personal Meeting"
    : isSpaceMeeting
      ? `Schedule the next Meeting in ${selectedSpaceName ?? "this Space"}`
      : "Schedule a personal Meeting";

  if (created) {
    return (
      <ScheduledConfirmation
        created={created}
        onDone={() => onOpenChange(false)}
      />
    );
  }

  return (
    <>
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>
            {isRescheduling
              ? isSpaceMeeting
                ? "Current Space members will receive the updated time after you save."
                : "Guests will receive the updated time after you save."
              : isSpaceMeeting
                ? "Pick a time for the Space's current members."
                : "Pick a time and invite guests by email or share the join link yourself."}
          </DialogDescription>
        </DialogHeader>

        <DialogBody sx={styles.body}>
          {!isRescheduling && (
            <div {...stylex.props(styles.grid)}>
              <Input
                label={<>Title <span {...stylex.props(styles.optional)}>(optional)</span></>}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={200}
                placeholder="Weekly planning"
              />
              <Select
                label="Meet using"
                value={context}
                onValueChange={(value) => {
                  destinationTouched.current = true;
                  const nextContext = value ?? "new-personal";
                  setContext(nextContext);
                  const nextSpace = nextContext.startsWith("space:")
                    ? manageableSpaces.find(
                        (space) => space.id === nextContext.slice("space:".length),
                      )
                    : null;
                  const nextTimeZone = nextSpace?.timeZone ?? homeTimeZone ?? browserTimeZone();
                  setTimeZone(nextTimeZone);
                  if (!startsAtTouched.current) setStartsAt(defaultStart(nextTimeZone));
                }}
                options={[
                  ...personalLinks.map((link) => ({
                    label: `Your permanent link · ${link.code}`,
                    value: `link:${link.id}`,
                  })),
                  { label: "New one-time link", value: "new-personal" },
                  ...manageableSpaces.map((space) => ({
                    label: `Space · ${space.name}`,
                    value: `space:${space.id}`,
                  })),
                ]}
              />
            </div>
          )}

          <div {...stylex.props(styles.startGrid)}>
            <Input
              label="Starts"
              type="datetime-local"
              value={startsAt}
              onChange={(event) => {
                startsAtTouched.current = true;
                setStartsAt(event.target.value);
              }}
              required
            />
            <label {...stylex.props(styles.label)}>
              Duration
              <select
                value={duration}
                onChange={(event) => setDuration(Number(event.target.value))}
                {...stylex.props(styles.labelControl, styles.nativeControl, motion.tint)}
              >
                <option value={15}>15 min</option>
                <option value={30}>30 min</option>
                <option value={45}>45 min</option>
                <option value={60}>1 hour</option>
                <option value={90}>1.5 hours</option>
                <option value={120}>2 hours</option>
              </select>
            </label>
          </div>

          <div>
            <TimeZoneSelect
              label="Time zone"
              value={timeZone}
              onChange={(value) => {
                timeZoneTouched.current = true;
                setTimeZone(value);
              }}
            />
            <p {...stylex.props(styles.count, styles.countOk)}>
              {isSpaceMeeting
                ? "Defaults to this Space’s time zone. This meeting can override it."
                : homeTimeZone
                  ? "Defaults to your home time zone. This meeting can override it."
                  : "Using this device’s time zone. Save a home time zone in Settings to keep it consistent across devices and the CLI."}
            </p>
          </div>

          <label {...stylex.props(styles.label)}>
              Email reminder
              <select
                value={reminder}
                onChange={(event) => setReminder(event.target.value)}
                {...stylex.props(styles.labelControl, styles.nativeControl, motion.tint)}
              >
                <option value="off">No reminder</option>
                <option value="10">10 minutes before</option>
                <option value="30">30 minutes before</option>
                <option value="60">1 hour before</option>
                <option value="120">2 hours before</option>
                <option value="1440">1 day before</option>
              </select>
              <span {...stylex.props(styles.count, styles.countOk)}>
                Sent to the same people as the invitation. Default is 1 hour before.
              </span>
          </label>

          {!isRescheduling && !isSpaceMeeting && (
            <label {...stylex.props(styles.label)}>
              Notify by email <span {...stylex.props(styles.optional)}>(optional)</span>
              <textarea
                value={attendeeText}
                onChange={(event) => setAttendeeText(event.target.value)}
                rows={2}
                placeholder="maruf@example.com, sam@example.com"
                {...stylex.props(styles.labelControl, styles.nativeControl, styles.textarea, motion.tint)}
              />
              <span
                {...stylex.props(
                  styles.count,
                  attendeeCount > MAX_NOTIFICATIONS ? styles.countOver : styles.countOk,
                )}
              >
                {attendeeCount > MAX_NOTIFICATIONS
                  ? `Email notifications are limited to ${MAX_NOTIFICATIONS} per Meeting — remove ${attendeeCount - MAX_NOTIFICATIONS}.`
                  : attendeeCount > 0
                    ? `${attendeeCount} of ${MAX_NOTIFICATIONS} — each person gets the scheduled time and join link. Orb Meet does not collect RSVPs.`
                    : "Skip this to share the join link yourself — you'll get it next."}
              </span>
            </label>
          )}

          {!isRescheduling && (
            <MeetingEntryModeField
              name="schedule-join-policy"
              value={joinPolicy}
              onChange={setJoinPolicy}
              audience={isSpaceMeeting ? "space" : "link"}
            />
          )}

          {!isRescheduling && isSpaceMeeting && (
            <p {...stylex.props(styles.note)}>
              Current Space members are emailed the scheduled time. The permanent meeting link remains member-only, and membership at entry controls access.
            </p>
          )}

          <p {...stylex.props(styles.finePrint)}>
            {isSpaceMeeting
              ? "Can start 15 minutes early · the Space keeps the same permanent meeting link."
              : isReusablePersonalMeeting
                ? "Can start 15 minutes early · your permanent link also remains available for unscheduled Meetings."
                : "Can start 15 minutes early · if unused, the one-time link expires 24 hours after the scheduled end."}
          </p>

          {error && <p role="alert" {...stylex.props(styles.error)}>{error}</p>}
        </DialogBody>

        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
          <Button
            size="sm"
            loading={mutation.isPending}
            disabled={!startsAt || !timeZone.trim() || (!isSpaceMeeting && attendeeCount > MAX_NOTIFICATIONS)}
            onClick={() => mutation.mutate()}
          >
            {isRescheduling
              ? "Save new time"
              : isSpaceMeeting
                ? "Schedule Space Meeting"
                : "Schedule personal Meeting"}
          </Button>
        </DialogFooter>
    </>
  );
}

/** The moment email becomes optional: the join link is right here to copy. */
function ScheduledConfirmation({
  created,
  onDone,
}: {
  created: CreatedSchedule;
  onDone: () => void;
}) {
  const { copied, copy } = useCopyToClipboard();
  const when = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: created.timeZone,
    timeZoneName: "short",
  }).format(new Date(created.startsAt));
  const reminderCopy = created.attendeeCount > 0 && created.reminderMinutesBefore
    ? ` A reminder will be sent ${created.reminderMinutesBefore === 60 ? "1 hour" : created.reminderMinutesBefore === 1440 ? "1 day" : `${created.reminderMinutesBefore} minutes`} before it starts.`
    : "";

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          <span {...stylex.props(styles.confirmTitle)}>
            <CalendarCheck size={18} {...stylex.props(styles.confirmGlyph)} />
            Scheduled for {when}
          </span>
        </DialogTitle>
        <DialogDescription>
          {created.spaceName
            ? `Current members of ${created.spaceName} were notified.${reminderCopy} Its permanent meeting link works only for people who are Space members when they enter:`
            : created.attendeeCount > 0
              ? `${created.attendeeCount === 1 ? "One person was notified" : `${created.attendeeCount} people were notified`} with the scheduled time and join link.${reminderCopy} Orb Meet does not collect RSVPs:`
              : "Share the join link with everyone you want there:"}
        </DialogDescription>
      </DialogHeader>

      <DialogBody>
        <button
          onClick={() => {
            void copy(`${window.location.origin}/${created.code}`);
          }}
          {...stylex.props(pressable.base, motion.tint, focus.ring, styles.copyButton, stylex.defaultMarker())}
          title="Copy link"
        >
          <span {...stylex.props(styles.copyCode)}>
            {typeof window === "undefined" ? created.code : `${window.location.host}/${created.code}`}
          </span>
          {copied ? (
            <span {...stylex.props(styles.copiedLabel)}>
              <Check size={14} /> Copied
            </span>
          ) : (
            <span {...stylex.props(styles.copiedLabel, styles.copyLabel)}>
              <Copy size={14} /> Copy
            </span>
          )}
        </button>
      </DialogBody>

      <DialogFooter>
        <Button size="sm" onClick={onDone}>Done</Button>
      </DialogFooter>
    </>
  );
}

export function CancelScheduledMeetingDialog({
  schedule,
  open,
  onOpenChange,
}: {
  schedule: UpcomingMeetingSchedule | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <CancelScheduledMeetingDialogForm
          key={schedule?.id ?? "missing"}
          schedule={schedule}
          onOpenChange={onOpenChange}
        />
      </DialogContent>
    </Dialog>
  );
}

function CancelScheduledMeetingDialogForm({
  schedule,
  onOpenChange,
}: {
  schedule: UpcomingMeetingSchedule | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => {
      if (!schedule) throw new Error("Scheduled meeting not found.");
      return cancelMeetingSchedule({
        data: {
          scheduleId: schedule.id,
          expectedRevision: schedule.revision,
          reason: reason.trim() || undefined,
        },
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.meetings.upcomingSchedules(),
      });
      onOpenChange(false);
    },
    onError: (caught) => {
      setError(getErrorMessage(caught, "Could not cancel the scheduled meeting."));
    },
  });

  return (
    <>
        <DialogHeader>
          <DialogTitle>Cancel scheduled meeting?</DialogTitle>
          <DialogDescription>
            The join link will stop working and every guest will receive a cancellation email.
          </DialogDescription>
        </DialogHeader>
        <DialogBody sx={styles.cancelBody}>
          <label {...stylex.props(styles.label)}>
            Reason <span {...stylex.props(styles.optional)}>(optional)</span>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              rows={3}
              {...stylex.props(styles.labelControl, styles.nativeControl, styles.textarea, motion.tint)}
            />
          </label>
          {error && <p role="alert" {...stylex.props(styles.error)}>{error}</p>}
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm" />}>Keep meeting</DialogClose>
          <Button
            variant="danger"
            size="sm"
            loading={mutation.isPending}
            disabled={!schedule}
            onClick={() => mutation.mutate()}
          >
            Cancel meeting
          </Button>
        </DialogFooter>
    </>
  );
}
