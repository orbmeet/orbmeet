import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { sessionQueryOptions } from "@/modules/identity/client/session.queries";
import { listSpaceMeetings, renameOpenMeeting } from "@/modules/meetings/server/history/space-meeting-queries.functions";
import {
  replaceSpaceMeetingLink,
  type getSpaceDefaultMeetingLink,
} from "@/modules/meetings/server/space-default-meeting-link.functions";
import { queryKeys } from "@/lib/query-keys";
import { getErrorMessage } from "@/lib/error-inspection";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";
import { spaceDefaultMeetingLinkQueryOptions } from "@/modules/meetings/client/meetings.queries";
import { spaceMeetingsQueryOptions } from "@/modules/meetings/client/meetings.queries";
import { spaceWhiteboardsQueryOptions } from "@/modules/whiteboards/client/whiteboards.queries";
import { boardDisplayTitle } from "@/modules/whiteboards/client/board-title";
import { formatActivityDay } from "@/modules/whiteboards/client/whiteboard-activity";
import {
  formatMeetingDate,
  formatMeetingTime,
  peopleInMeeting,
} from "@/modules/meetings/client/components/meeting-format";
import { MeetingStatePill, MeetingStateText } from "@/modules/meetings/client/components/meeting-state";
import { MeetingRow as PastMeetingRow } from "@/modules/meetings/client/components/meeting-row";
import { UpcomingMeetings } from "@/modules/scheduling/client/upcoming-meetings";
import { ScheduleMeetingDialog } from "@/modules/scheduling/client/schedule-meeting-dialog";
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  dialogLayout,
} from "@orbmeet/ui/react";
import {
  Check,
  Copy,
  Pencil,
  RotateCcw,
} from "lucide-react";
import { List, ListRow, WideOnly } from "@/app/shell/list";
import { Section } from "@orbmeet/ui/react";
import { focus, layout, motion, stack, status, touch } from "@orbmeet/ui/styles/atoms";
import { accent, ink, neutral, success } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { panelStyles } from "./space-panel-styles";

const styles = stylex.create({
  layout: { display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: space.s8, paddingTop: space.s2 },
  main: { display: "flex", flexDirection: "column", gap: space.s6, flexGrow: 999, flexShrink: 1, flexBasis: 500, minWidth: 0 },
  aside: { display: "flex", flexDirection: "column", gap: space.s4, flexGrow: 1, flexShrink: 1, flexBasis: 300, minWidth: 0 },
  quiet: { margin: 0, fontSize: text.sm, lineHeight: leading.relaxed, color: ink.muted },

  pastList: { display: "flex", flexDirection: "column", gap: space.s0_5 },

  asideCard: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2_5,
    padding: space.s4,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n150,
    borderRadius: 18,
  },
  asideHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: space.s2 },
  asideTitle: { margin: 0, fontSize: text.base, fontWeight: weight.semibold, color: ink.strong },
  asideLink: { fontSize: "0.84375rem", fontWeight: weight.medium, color: accent.a700, textDecorationLine: "none" },
  boardList: { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column" },
  boardRow: {
    display: "flex",
    alignItems: "baseline",
    gap: space.s3,
    paddingBlock: space.s2_5,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: neutral.n150,
    color: ink.strong,
    fontSize: text.sm,
    textDecorationLine: "none",
  },
  boardName: { flexGrow: 1, minWidth: 0 },
  boardWhen: { flexShrink: 0, fontSize: "0.78125rem", color: ink.muted },

  /* ── The permanent meeting link ────────────────────────────────────────── */
  linkLayout: { display: "flex", flexDirection: "column", gap: space.s3 },
  linkTitle: {
    margin: 0,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s2,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.semibold,
    color: ink.strong,
  },
  linkMeta: {
    marginTop: space.s1,
    marginBottom: 0,
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: ink.muted,
  },
  linkCode: {
    borderRadius: radii.field,
    backgroundColor: neutral.n100,
    paddingInline: space.s1_5,
    paddingBlock: space.s0_5,
    fontFamily: fonts.mono,
    fontSize: text.xs,
    fontWeight: weight.medium,
    color: neutral.n700,
  },
  linkActions: { display: "flex", flexShrink: 0, flexWrap: "wrap", gap: space.s2 },
  copied: { color: success.s600 },
});

type SpaceMeeting = Awaited<ReturnType<typeof listSpaceMeetings>>["meetings"][number];

type SpaceDefaultMeetingLink = Awaited<ReturnType<typeof getSpaceDefaultMeetingLink>>;

export function MeetingsPanel({
  spaceId,
  spaceSlug,
  spaceName,
  timeZone,
  canSchedule,
}: {
  spaceId: string;
  spaceSlug: string;
  spaceName: string;
  timeZone: string;
  canSchedule: boolean;
}) {
  const meetingsQuery = useSuspenseInfiniteQuery(spaceMeetingsQueryOptions(spaceId));
  const defaultMeetingLinkQuery = useSuspenseQuery(spaceDefaultMeetingLinkQueryOptions(spaceId));
  const meetings = meetingsQuery.data.pages.flatMap((p) => p.meetings);
  const open = meetings.filter((meeting) => meeting.status === "open");
  const past = meetings.filter((meeting) => meeting.status !== "open");
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const { data: session } = useQuery(sessionQueryOptions());

  return (
    <div {...stylex.props(styles.layout)}>
      <div {...stylex.props(styles.main)}>
        <UpcomingMeetings
          spaceId={spaceId}
          onSchedule={canSchedule ? () => setScheduleOpen(true) : undefined}
          scheduleActionLabel="Schedule"
          compactEmpty
        />

        {open.length > 0 ? (
          <Section title="Happening now">
            <List label="Open meetings">
              {open.map((meeting) => (
                <OpenMeetingRow key={meeting.id} meeting={meeting} spaceId={spaceId} />
              ))}
            </List>
          </Section>
        ) : null}

        {past.length === 0 ? (
          <p {...stylex.props(styles.quiet)}>
            Nothing here yet. When a meeting in this space ends, it lands here.
          </p>
        ) : (
          <section aria-label="Past meetings" {...stylex.props(styles.pastList)}>
            {past.map((meeting) => (
              <PastMeetingRow
                key={meeting.id}
                meeting={{ ...meeting, meetingId: meeting.id, spaceName, hasWhiteboard: meeting.hasWhiteboardState || meeting.hasWhiteboardPdf }}
                viewerName={session?.user.name ?? undefined}
                fromSpace={spaceSlug}
                showDate
              />
            ))}
          </section>
        )}
        {meetingsQuery.hasNextPage ? (
          <div {...stylex.props(panelStyles.pagerFoot)}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void meetingsQuery.fetchNextPage()}
              loading={meetingsQuery.isFetchingNextPage}
            >
              Show earlier meetings
            </Button>
          </div>
        ) : null}
      </div>

      <aside aria-label="About this space" {...stylex.props(styles.aside)}>
        <DefaultMeetingLinkCard spaceId={spaceId} defaultMeetingLink={defaultMeetingLinkQuery.data} />
        <SpaceBoards spaceId={spaceId} spaceSlug={spaceSlug} />
      </aside>

      <ScheduleMeetingDialog
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        initialSpace={{ id: spaceId, name: spaceName, timeZone }}
      />
    </div>
  );
}

/** The Space's boards, most recently used first, named after the meeting that made them. */
function SpaceBoards({ spaceId, spaceSlug }: { spaceId: string; spaceSlug: string }) {
  const query = useInfiniteQuery(spaceWhiteboardsQueryOptions(spaceId));
  const boards = (query.data?.pages.flatMap((page) => page.whiteboards) ?? []).slice(0, 5);
  return (
    <section aria-labelledby="space-boards" {...stylex.props(styles.asideCard)}>
      <div {...stylex.props(styles.asideHead)}>
        <h2 id="space-boards" {...stylex.props(styles.asideTitle)}>Boards</h2>
        <Link
          to="/space/$spaceSlug"
          params={{ spaceSlug }}
          search={{ tab: "whiteboards" }}
          {...stylex.props(touch.target, styles.asideLink, focus.ring)}
        >
          All boards
        </Link>
      </div>
      {boards.length === 0 ? (
        <p {...stylex.props(panelStyles.quiet)}>{query.isPending ? "Loading…" : "No boards yet."}</p>
      ) : (
        <ol {...stylex.props(styles.boardList)}>
          {boards.map((board) => (
            <li key={board.id}>
              <Link
                to="/whiteboards/$whiteboardId"
                params={{ whiteboardId: board.id }}
                {...stylex.props(styles.boardRow, motion.tint, focus.ring)}
              >
                <span {...stylex.props(styles.boardName, layout.truncate)}>{boardDisplayTitle(board)}</span>
                <span {...stylex.props(styles.boardWhen)}>{formatActivityDay(board.lastUsedAt ?? board.updatedAt)}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function DefaultMeetingLinkCard({
  spaceId,
  defaultMeetingLink,
}: {
  spaceId: string;
  defaultMeetingLink: SpaceDefaultMeetingLink;
}) {
  const { copied, copy } = useCopyToClipboard();
  const queryClient = useQueryClient();
  const [replaceOpen, setReplaceOpen] = useState(false);
  const code = defaultMeetingLink.meetingLink?.code ?? null;

  async function copyLink() {
    if (!code) return;
    await copy(`${window.location.origin}/${code}`);
  }

  const replaceMutation = useMutation({
    mutationFn: () => replaceSpaceMeetingLink({ data: { spaceId } }),
    onSuccess: async () => {
      setReplaceOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.defaultMeetingLink(spaceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.meetings.upcomingSchedules() }),
        // The replaced link is archived; Home and the landing page must not offer it.
        queryClient.invalidateQueries({ queryKey: queryKeys.threads() }),
      ]);
    },
  });

  return (
    // The same quiet box as the Boards beside it, rather than a lifted card.
    <section aria-label="Meeting link" {...stylex.props(styles.asideCard)}>
      <div {...stylex.props(styles.linkLayout)}>
        <div {...stylex.props(layout.minZero)}>
          <p {...stylex.props(styles.linkTitle)}>
            Meeting link
            {code ? <code {...stylex.props(styles.linkCode)}>{code}</code> : null}
          </p>
          <p {...stylex.props(styles.linkMeta)}>
            {code
              ? "The space’s own link, for members only. It stays the same until an admin replaces it."
              : "The permanent meeting link is unavailable."}
          </p>
        </div>
        <div {...stylex.props(styles.linkActions)}>
          {code && defaultMeetingLink.canReplace && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={defaultMeetingLink.hasOpenMeeting}
              onClick={() => setReplaceOpen(true)}
            >
              <RotateCcw size={15} />
              Replace
            </Button>
          )}
          {code && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                void copyLink();
              }}
            >
              {copied ? <Check size={15} {...stylex.props(styles.copied)} /> : <Copy size={15} />}
              {copied ? "Copied" : "Copy link"}
            </Button>
          )}
        </div>
      </div>
      <Dialog open={replaceOpen} onOpenChange={setReplaceOpen}>
        <DialogContent>
          <DialogBody sx={[dialogLayout.padded, stack.x4]}>
            <div>
              <DialogTitle>Replace the permanent meeting link?</DialogTitle>
              <DialogDescription>
                The current member-only address will stop working. Current Space members can use the replacement; external collaborators must first join through the Space invite link.
              </DialogDescription>
            </div>
            {replaceMutation.error && (
              <p {...stylex.props(status.error, status.flush)}>{getErrorMessage(replaceMutation.error)}</p>
            )}
            <div {...stylex.props(dialogLayout.actions)}>
              <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
              <Button
                loading={replaceMutation.isPending}
                onClick={() => replaceMutation.mutate()}
              >
                Replace link
              </Button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function OpenMeetingRow({
  meeting,
  spaceId,
}: {
  meeting: SpaceMeeting;
  spaceId: string;
}) {
  const isLive = meeting.liveParticipantCount > 0;
  const [renameOpen, setRenameOpen] = useState(false);
  const [editedTitle, setEditedTitle] = useState(meeting.title ?? "");
  const titleBaselineRef = useRef(meeting.title);
  useEffect(() => {
    const previous = titleBaselineRef.current;
    setEditedTitle((value) => value === (previous ?? "") ? (meeting.title ?? "") : value);
    titleBaselineRef.current = meeting.title;
  }, [meeting.title]);
  const queryClient = useQueryClient();
  const renameMutation = useMutation({
    mutationFn: () => renameOpenMeeting({
      data: {
        meetingId: meeting.id,
        title: editedTitle || null,
        expectedTitle: titleBaselineRef.current,
      },
    }),
    onSuccess: async () => {
      setRenameOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.spaces.meetings(spaceId) });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.meetings.lists() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.threads() }),
      ]);
    },
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.spaces.meetings(spaceId) });
    },
  });
  const title = meeting.title?.trim() || null;
  const fallbackTitle = meeting.startedAt
    ? `${formatMeetingDate(meeting.startedAt)} · ${formatMeetingTime(meeting.startedAt)}`
    : "Meeting";
  const primary = title ?? fallbackTitle;

  return (
    <>
      <ListRow
        title={
          <>
            {primary}
            <MeetingStatePill live={isLive} />
          </>
        }
        meta={
          <MeetingStateText live={isLive}>
            {isLive ? peopleInMeeting(meeting.liveParticipantCount) : "Waiting for participants"}
            {meeting.starterName ? ` · Started by ${meeting.starterName}` : ""}
          </MeetingStateText>
        }
        trailing={
          <>
            {meeting.canManageMeeting && (
              <Button size="sm" variant="ghost" aria-label="Rename" onClick={() => setRenameOpen(true)}>
                <Pencil size={14} />
                <WideOnly>Rename</WideOnly>
              </Button>
            )}
            <Button size="sm" onClick={() => (window.location.href = `/${meeting.code}`)}>
              Join
            </Button>
          </>
        }
      />
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogBody sx={[dialogLayout.padded, stack.x4]}>
            <div>
              <DialogTitle>Name this Meeting</DialogTitle>
              <DialogDescription>
                This title belongs to this Meeting. It does not rename the Space, its permanent meeting link, or a Whiteboard.
              </DialogDescription>
            </div>
            <form
              {...stylex.props(stack.x4)}
              onSubmit={(event) => { event.preventDefault(); renameMutation.mutate(); }}
            >
              <Input
                label="Meeting title"
                value={editedTitle}
                onChange={(event) => setEditedTitle(event.target.value)}
                maxLength={200}
                placeholder="Leave blank to use the date and time"
              />
              <div {...stylex.props(dialogLayout.actions)}>
                <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
                <Button type="submit" loading={renameMutation.isPending}>Save</Button>
              </div>
              {renameMutation.isError ? (
                <p {...stylex.props(status.error, status.flush)}>{getErrorMessage(renameMutation.error)}</p>
              ) : null}
            </form>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
