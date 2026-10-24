import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import * as stylex from "@stylexjs/stylex";

import type { Thread } from "@/modules/meetings/contract/threads";
import { archiveMeetingLink, updateMeetingLink } from "@/modules/meetings/server/history/dashboard.functions";
import { getErrorMessage } from "@/lib/error-inspection";
import { queryKeys } from "@/app/query-client/query-keys";
import {
  MeetingEntryModeField,
  type EntryModeChoice,
} from "@/modules/meetings/client/components/meeting-policy-fields";
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@orbmeet/ui/react";
import { focus, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { danger, neutral, warning } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";

const styles = stylex.create({
  settingsBody: { display: "flex", flexDirection: "column", gap: space.s5, paddingBlock: space.s4 },
  error: { margin: 0, fontSize: text.xs, fontWeight: weight.medium, color: danger.d700 },
  dangerZone: { borderTopWidth: 1, borderTopStyle: "solid", borderTopColor: neutral.n100, paddingTop: space.s4 },
  remove: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    fontSize: text.xs,
    fontWeight: weight.medium,
    color: { default: danger.d700, [env.hoverable]: { default: danger.d700, ":hover": danger.d800 } },
  },
  removeBody: { display: "flex", flexDirection: "column", gap: space.s2, paddingBlock: space.s4 },
  removeWarning: { margin: 0, fontSize: text.xs, lineHeight: leading.sm, color: warning.w800 },
});

type RoomThread = Extract<Thread, { kind: "personal" }>;

function entryMode(joinPolicy: RoomThread["joinPolicy"]): EntryModeChoice {
  return joinPolicy === "approval_required" ? "approval_required" : "open";
}

/**
 * Your room's settings: what each meeting in it is called by default, who may
 * walk straight in, and removing the link. A dialog rather than a page: the
 * room is a property of your account, set once and rarely touched.
 */
export function RoomLinkSettings({
  thread,
  open,
  onOpenChange,
}: {
  thread: RoomThread;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [removeOpen, setRemoveOpen] = useState(false);
  const [title, setTitle] = useState(thread.defaultTitle ?? "");
  const [joinPolicy, setJoinPolicy] = useState<EntryModeChoice>(() => entryMode(thread.joinPolicy));
  const activeMeeting = thread.openMeeting;

  // Each opening starts from what is saved, not from an abandoned edit.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setTitle(thread.defaultTitle ?? "");
      setJoinPolicy(entryMode(thread.joinPolicy));
    }
  }

  // The link's title and its archived state also feed the "Rejoin" shortcut.
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.threads() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.meetings.lastReusable() }),
    ]);

  const updateMutation = useMutation({
    mutationFn: () => updateMeetingLink({ data: { meetingLinkId: thread.id, title: title.trim() || null, joinPolicy } }),
    onSuccess: async () => {
      onOpenChange(false);
      await refresh();
    },
  });

  const removeMutation = useMutation({
    mutationFn: () => archiveMeetingLink({ data: { meetingLinkId: thread.id } }),
    onSuccess: async () => {
      setRemoveOpen(false);
      await refresh();
    },
  });

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Your room</DialogTitle>
            <DialogDescription>
              Each new meeting in your room starts with these. A meeting already open keeps what it started with.
            </DialogDescription>
          </DialogHeader>
          <DialogBody sx={styles.settingsBody}>
            <Input
              label="Default meeting title"
              value={title}
              maxLength={200}
              placeholder="Optional"
              onChange={(event) => setTitle(event.target.value)}
            />
            <MeetingEntryModeField
              name="room-join-policy"
              value={joinPolicy}
              onChange={setJoinPolicy}
              audience="link"
            />
            {updateMutation.error ? (
              <p role="alert" {...stylex.props(styles.error)}>
                {getErrorMessage(updateMutation.error, "Couldn’t save your room’s settings.")}
              </p>
            ) : null}
            <div {...stylex.props(styles.dangerZone)}>
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  setRemoveOpen(true);
                }}
                {...stylex.props(pressable.base, motion.tint, focus.ring, styles.remove)}
              >
                <Trash2 size={13} aria-hidden="true" /> Remove room link
              </button>
            </div>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="secondary" size="sm" />}>Cancel</DialogClose>
            <Button size="sm" loading={updateMutation.isPending} onClick={() => updateMutation.mutate()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Remove your room link?</DialogTitle>
            <DialogDescription>
              The address stops working. Past meetings and what came out of them stay in your Library.
            </DialogDescription>
          </DialogHeader>
          <DialogBody sx={styles.removeBody}>
            {activeMeeting ? (
              <p {...stylex.props(styles.removeWarning)}>End the meeting open in your room before removing its link.</p>
            ) : null}
            {removeMutation.error ? (
              <p role="alert" {...stylex.props(styles.error)}>
                {getErrorMessage(removeMutation.error, "Couldn’t remove the room link.")}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="secondary" size="sm" />}>Keep link</DialogClose>
            <Button
              variant="danger"
              size="sm"
              disabled={Boolean(activeMeeting)}
              loading={removeMutation.isPending}
              onClick={() => removeMutation.mutate()}
            >
              Remove link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
