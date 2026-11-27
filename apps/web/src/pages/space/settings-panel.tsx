import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { updateSpace } from "@/modules/spaces/server/crud.functions";
import { deleteSpace } from "@/workflows/space-deletion/delete-space.functions";
import { queryKeys } from "@/lib/query-keys";
import { evictSpaceQueryCache } from "@/modules/spaces/client/space-query-cache";
import { getErrorMessage } from "@/lib/error-inspection";
import { Button, dialogLayout, Switch, TimeZoneSelect } from "@orbmeet/ui/react";
import { useSpaceTranscriptionDefault } from "@/modules/spaces/client/use-space-transcription";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@orbmeet/ui/react";
import { Input } from "@orbmeet/ui/react";
import {
  Trash,
} from "lucide-react";
import { stack, status } from "@orbmeet/ui/styles/atoms";
import { danger, ink, neutral } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { measure, space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { ActivityPanel } from "./activity-panel";

const styles = stylex.create({

  /* ── Settings panel ────────────────────────────────────────────────────── */
  settingsColumn: { maxWidth: measure.form },
  planNote: {
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    backgroundColor: neutral.n50,
    padding: space.s4,
    fontSize: text.xs,
    lineHeight: leading.sm,
    color: ink.body,
  },
  formTitle: {
    margin: 0,
    fontSize: text.base,
    lineHeight: leading.base,
    fontWeight: weight.semibold,
    color: ink.strong,
  },
  formHint: { margin: 0, fontSize: text.xs, lineHeight: leading.xs, color: ink.muted },
  submit: { alignSelf: "flex-start" },
  switchRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.s4 },
  dangerZone: {
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: danger.d200,
    backgroundColor: danger.d50,
    padding: space.s4,
  },
  dangerTitle: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.semibold,
    color: danger.d800,
  },
  dangerNote: {
    marginTop: space.s1,
    marginBottom: 0,
    fontSize: text.xs,
    lineHeight: leading.sm,
    color: danger.d700,
  },
  dangerAction: { marginTop: space.s3, gap: space.s1_5 },
});

export function SettingsPanel({
  spaceId,
  spaceSlug,
  name,
  description,
  timeZone,
  transcribeMeetings,
  organizationName,
  canDelete,
}: {
  spaceId: string;
  spaceSlug: string;
  name: string;
  description: string | null;
  timeZone: string;
  transcribeMeetings: boolean;
  organizationName: string | null;
  canDelete: boolean;
}) {
  const queryClient = useQueryClient();
  const transcription = useSpaceTranscriptionDefault({ spaceId, on: transcribeMeetings });
  const transcriptionLabelId = useId();
  const navigate = useNavigate();
  const [editName, setEditName] = useState(name);
  const [editDesc, setEditDesc] = useState(description || "");
  const [editTimeZone, setEditTimeZone] = useState(timeZone);
  const baselineRef = useRef({ name, description, timeZone });
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    const previous = baselineRef.current;
    setEditName((value) => value === previous.name ? name : value);
    setEditDesc((value) => value === (previous.description ?? "") ? (description ?? "") : value);
    setEditTimeZone((value) => value === previous.timeZone ? timeZone : value);
    baselineRef.current = { name, description, timeZone };
  }, [name, description, timeZone]);

  const updateMutation = useMutation({
    mutationFn: (input: { name?: string; description?: string; timeZone?: string }) =>
      updateSpace({ data: { spaceId, ...input, expected: baselineRef.current } }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.detail(spaceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.bySlug(spaceSlug) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.all() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.threads() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all() }),
        // Lists across Spaces label their rows with the Space's name.
        queryClient.invalidateQueries({ queryKey: queryKeys.meetings.lists() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.meetings.upcomingSchedules() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.whiteboards.list() }),
      ]);
    },
    onError: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.detail(spaceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.bySlug(spaceSlug) }),
      ]);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteSpace({ data: { spaceId } }),
    onSuccess: async () => {
      // Leave first, then drop the archived space's cache, and only then
      // refresh the lists. Invalidating while the detail/audit queries are
      // still mounted would refetch a space the viewer can no longer read.
      await navigate({ to: "/spaces" });
      await evictSpaceQueryCache(queryClient, spaceId, spaceSlug);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.all() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.threads() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all() }),
      ]);
    },
  });

  function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    const nextName = editName.trim();
    const nextDesc = editDesc.trim();
    const nextTimeZone = editTimeZone.trim();
    const input: { name?: string; description?: string; timeZone?: string } = {};
    const baseline = baselineRef.current;
    if (nextName !== baseline.name) input.name = nextName;
    if (nextDesc !== (baseline.description ?? "")) input.description = nextDesc;
    if (nextTimeZone !== baseline.timeZone) input.timeZone = nextTimeZone;
    if (Object.keys(input).length === 0) return;
    updateMutation.mutate(input);
  }

  return (
    <div {...stylex.props(stack.x8, styles.settingsColumn)}>
      <div {...stylex.props(styles.planNote)}>
        Space Meetings, active Whiteboards, and storage use {organizationName ? `${organizationName}’s Organization plan` : "the Space owner’s plan"}. Every member may create and edit Space Whiteboards; admins control membership, schedules, and settings.
      </div>
      <form onSubmit={handleUpdate} {...stylex.props(stack.x4)}>
        <h3 {...stylex.props(styles.formTitle)}>Space details</h3>
        <Input label="Name" value={editName} onChange={(e) => setEditName(e.target.value)} />
        <Input
          label="Description"
          value={editDesc}
          onChange={(e) => setEditDesc(e.target.value)}
          placeholder="Add a description..."
        />
        {/* A picker, like the profile's: typing "UTC" or "Asia/Dhaka" by
            hand let a misspelt zone reach every invite this Space sends. */}
        <TimeZoneSelect label="Time zone" value={editTimeZone} onChange={setEditTimeZone} />
        <p {...stylex.props(styles.formHint)}>
          Used for this Space’s scheduled Meetings. Members still see times in their own zone.
        </p>
        <Button
          type="submit"
          sx={styles.submit}
          loading={updateMutation.isPending}
          disabled={!editName.trim()}
        >
          Save changes
        </Button>
        {updateMutation.isSuccess && !updateMutation.isPending && (
          <p {...stylex.props(status.success, status.flush)}>Changes saved!</p>
        )}
        {updateMutation.isError && (
          <p {...stylex.props(status.error, status.flush)}>{getErrorMessage(updateMutation.error)}</p>
        )}
      </form>

      {transcription && (
        <div {...stylex.props(stack.x2)}>
          <h3 {...stylex.props(styles.formTitle)}>Meetings</h3>
          <div {...stylex.props(styles.switchRow)}>
            <p id={transcriptionLabelId} {...stylex.props(styles.formHint)}>
              {transcription.on
                ? "This Space’s meetings begin with transcription on, whoever starts them: what people say is sent to Deepgram for captions, the transcript and the summary."
                : "This Space’s meetings begin with transcription off, whoever starts them: nothing anyone says is sent to Deepgram."}{" "}
              A host or co-host can change it during a meeting.
            </p>
            <Switch
              checked={transcription.on}
              pending={transcription.pending}
              onCheckedChange={(next) => void transcription.set(next)}
              aria-label="Transcribe this Space’s meetings"
              aria-describedby={transcriptionLabelId}
            />
          </div>
          {transcription.failed && (
            <p role="alert" {...stylex.props(status.error, status.flush)}>That change didn&rsquo;t save. Try again.</p>
          )}
        </div>
      )}

      <ActivityPanel spaceId={spaceId} />

      {canDelete && (
        <div {...stylex.props(styles.dangerZone)}>
          <h3 {...stylex.props(styles.dangerTitle)}>Danger zone</h3>
          <p {...stylex.props(styles.dangerNote)}>
            Permanently removes its membership, Meetings, Whiteboards, recordings, files, and activity history.
          </p>
          <Button variant="danger" size="sm" sx={styles.dangerAction} onClick={() => setDeleteOpen(true)}>
            <Trash size={14} />
            Delete space
          </Button>
        </div>
      )}

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent size="sm">
          <DialogBody sx={dialogLayout.padded}>
            <DialogTitle>Delete Space</DialogTitle>
            <DialogDescription>
              Deleting &ldquo;{name}&rdquo; permanently removes its membership, Meetings, Whiteboards and their history, recordings, files, and activity history. This cannot be undone.
            </DialogDescription>
            {deleteMutation.isError && (
              <p {...stylex.props(status.error)}>
                {getErrorMessage(deleteMutation.error, "Failed to delete Space. Please try again.")}
              </p>
            )}
            <div {...stylex.props(dialogLayout.actions)}>
              <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
              <Button
                variant="danger"
                onClick={() => deleteMutation.mutate()}
                loading={deleteMutation.isPending}
              >
                Delete
              </Button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}
