import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { leaveSpace } from "@/modules/spaces/server/membership.functions";
import { queryKeys } from "@/app/query-client/query-keys";
import { evictSpaceQueryCache } from "@/modules/spaces/client/space-query-cache";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";
import { beginMeetingEntryFlow } from "@/modules/meetings/client/entry-metrics";
import { SpaceTile } from "./space-tile";
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DotList,
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from "@orbmeet/ui/react";
import { focus, layout, motion, row } from "@orbmeet/ui/styles/atoms";
import { accent, border, danger, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { Copy, Lock, LogOut, MoreHorizontal, Video } from "lucide-react";

const styles = stylex.create({
  header: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.s5, paddingTop: { default: space.s4, [bp.lg]: space.s7 } },
  identity: { display: "flex", flexDirection: "column", gap: space.s2, flexGrow: 1, flexShrink: 1, flexBasis: 320, minWidth: 0 },
  name: {
    margin: 0,
    fontFamily: fonts.heading,
    fontWeight: weight.semibold,
    fontSize: { default: "2rem", [bp.sm]: "2.5rem" },
    lineHeight: 1.05,
    letterSpacing: "-0.045em",
    color: ink.strong,
    overflowWrap: "anywhere",
  },
  meta: { fontSize: text.sm, color: ink.muted },
  metaItem: { display: "inline-flex", alignItems: "center", gap: space.s1_5 },
  code: { fontFamily: fonts.mono, color: ink.body },
  description: { margin: 0, maxWidth: "60ch", fontSize: text.sm, lineHeight: leading.relaxed, color: ink.body },
  actions: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.s2 },
  meet: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s2,
    height: 42,
    paddingInline: space.s4,
    borderRadius: 12,
    fontSize: text.sm,
    fontWeight: weight.semibold,
    color: ink.onAccent,
    textDecorationLine: "none",
    backgroundColor: { default: accent.a600, [env.hoverable]: { default: accent.a600, ":hover": accent.a700 } },
  },
  more: {
    display: "grid",
    placeItems: "center",
    width: 42,
    height: 42,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: border.subtle,
    borderRadius: 12,
    cursor: "pointer",
    color: ink.body,
    backgroundColor: { default: surface.raised, [env.hoverable]: { default: surface.raised, ":hover": neutral.n50 } },
  },
  leaveItem: { color: danger.d700 },
  dialogBody: { padding: space.s6 },
  dialogActions: { marginTop: space.s5, justifyContent: "flex-end" },
  error: { marginTop: space.s3, marginBottom: 0, fontSize: text.sm, lineHeight: leading.sm, color: danger.d600 },
});

interface SpaceHeaderProps {
  spaceId: string;
  // Needed purely so leaving can evict the slug-keyed entry too: the route
  // loader re-enters through spaceBySlugQueryOptions, so a surviving
  // ["spaces","slug",…] entry would re-render the ex-member's payload —
  // admin controls included — for the rest of its 5-minute staleTime.
  spaceSlug: string;
  name: string;
  description?: string | null;
  memberCount: number;
  /** "Owner", "Admin", or nothing for a member — what the viewer may do here. */
  roleLabel: string | null;
  billingLabel: string | null;
  /** The Space's own room: its permanent link, and whether a meeting is open in it. */
  room: { code: string | null; hasOpenMeeting: boolean };
  canLeaveSpace: boolean;
  onInvite: () => void;
}

/**
 * Who this Space is, and its one action: meet in it. The room's link is the
 * Space's permanent address, so it sits in the header beside its name.
 */
export function SpaceHeader({
  spaceId,
  spaceSlug,
  name,
  description,
  memberCount,
  roleLabel,
  billingLabel,
  room,
  canLeaveSpace,
  onInvite,
}: SpaceHeaderProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [leaveOpen, setLeaveOpen] = useState(false);
  const { copied, copy } = useCopyToClipboard();

  const leaveMutation = useMutation({
    mutationFn: () => leaveSpace({ data: { spaceId } }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.spaces.all(),
          exact: true,
          refetchType: "none",
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.threads() }),
      ]);
      await navigate({ to: "/home" });
      await evictSpaceQueryCache(queryClient, spaceId, spaceSlug);
    },
  });

  return (
    <header {...stylex.props(styles.header)}>
      <SpaceTile name={name} size="lg" />
      <div {...stylex.props(styles.identity)}>
        <h1 {...stylex.props(styles.name)}>{name}</h1>
        <DotList sx={styles.meta}>
          <span {...stylex.props(styles.metaItem)}>
            <Lock size={14} strokeWidth={1.9} aria-hidden="true" />
            Members only
          </span>
          <span>{memberCount === 1 ? "1 person" : `${memberCount} people`}</span>
          {roleLabel ? <span>{roleLabel}</span> : null}
          {room.code ? (
            <span>
              Room <span {...stylex.props(styles.code)}>{room.code}</span>
            </span>
          ) : null}
          {billingLabel ? <span>{billingLabel}</span> : null}
        </DotList>
        {description ? <p {...stylex.props(styles.description)}>{description}</p> : null}
      </div>
      <div {...stylex.props(styles.actions)}>
        <Button variant="secondary" onClick={onInvite}>
          Invite
        </Button>
        {room.code ? (
          <a
            href={`/${room.code}`}
            onClick={() => beginMeetingEntryFlow({ source: "home-join", code: room.code! })}
            {...stylex.props(styles.meet, motion.tint, focus.ring)}
          >
            <Video size={17} strokeWidth={1.9} aria-hidden="true" />
            {room.hasOpenMeeting ? "Join the meeting" : "Meet in this space"}
          </a>
        ) : null}
        <MenuRoot>
          <MenuTrigger aria-label="More for this space" {...stylex.props(styles.more, motion.tint, focus.ring)}>
            <MoreHorizontal size={18} aria-hidden="true" />
          </MenuTrigger>
          <MenuContent>
            {room.code ? (
              <MenuItem onClick={() => void copy(`${window.location.origin}/${room.code}`)}>
                <Copy size={15} aria-hidden="true" />
                {copied ? "Copied" : "Copy room link"}
              </MenuItem>
            ) : null}
            {canLeaveSpace ? (
              <>
                {room.code ? <MenuSeparator /> : null}
                <MenuItem onClick={() => setLeaveOpen(true)}>
                  <span {...stylex.props(row.x2, styles.leaveItem, layout.minZero)}>
                    <LogOut size={15} aria-hidden="true" />
                    Leave space
                  </span>
                </MenuItem>
              </>
            ) : null}
          </MenuContent>
        </MenuRoot>
      </div>

      <Dialog open={leaveOpen} onOpenChange={setLeaveOpen}>
        <DialogContent size="sm">
          <DialogBody sx={styles.dialogBody}>
            <DialogTitle>Leave this space?</DialogTitle>
            <DialogDescription>
              You’ll lose access to its meetings, boards and files. Past meetings you joined while signed in stay in
              your Library.
            </DialogDescription>
            <div {...stylex.props(row.x3, styles.dialogActions)}>
              <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
              <Button variant="danger" loading={leaveMutation.isPending} onClick={() => leaveMutation.mutate()}>
                Leave space
              </Button>
            </div>
            {leaveMutation.error ? (
              <p role="alert" {...stylex.props(styles.error)}>
                Couldn’t leave the space. Try again in a moment.
              </p>
            ) : null}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </header>
  );
}
