import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { deleteArchivedWhiteboard, restoreArchivedWhiteboard } from "@/modules/whiteboards/server/api.functions";
import { ListGlyph, ListRow } from "@/app/shell/list";
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  dialogLayout,
} from "@orbmeet/ui/react";
import { getErrorMessage } from "@/lib/error-inspection";
import { queryKeys } from "@/app/query-client/query-keys";
import { danger, neutral } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";

const styles = stylex.create({
  error: { color: danger.d700 },
  remove: {
    color: {
      default: neutral.n600,
      [env.hoverable]: { default: neutral.n600, ":hover:not(:disabled)": danger.d700 },
    },
    backgroundColor: {
      default: "transparent",
      [env.hoverable]: { default: "transparent", ":hover:not(:disabled)": danger.d50 },
    },
  },
});

/**
 * An archived board: why it is kept, and — for whoever may — restore it, or
 * delete it for good when no history depends on it.
 */
type ArchivedWhiteboard = Awaited<
  ReturnType<typeof import("@/modules/whiteboards/server/api.functions").listMyWhiteboards>
>["whiteboards"][number];

export function ArchivedBoardRow({ whiteboard }: { whiteboard: ArchivedWhiteboard }) {
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const restoreMutation = useMutation({
    mutationFn: () => restoreArchivedWhiteboard({ data: { whiteboardId: whiteboard.id } }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.whiteboards.list() }),
        ...(whiteboard.spaceId
          ? [
              queryClient.invalidateQueries({
                queryKey: queryKeys.spaces.whiteboards(whiteboard.spaceId),
              }),
            ]
          : []),
      ]),
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteArchivedWhiteboard({ data: { whiteboardId: whiteboard.id } }),
    onSuccess: async () => {
      setDeleteOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.whiteboards.list() }),
        ...(whiteboard.spaceId
          ? [
              queryClient.invalidateQueries({
                queryKey: queryKeys.spaces.whiteboards(whiteboard.spaceId),
              }),
            ]
          : []),
      ]);
      queryClient.removeQueries({
        queryKey: queryKeys.whiteboards.detail(whiteboard.id),
        exact: true,
      });
      queryClient.removeQueries({
        queryKey: queryKeys.whiteboards.standaloneAccess(whiteboard.id),
        exact: true,
      });
      queryClient.removeQueries({ queryKey: queryKeys.whiteboards.snapshots(whiteboard.id) });
    },
  });
  const error = restoreMutation.error ?? deleteMutation.error;
  return (
    <>
      <ListRow
        leading={<ListGlyph><Archive size={16} /></ListGlyph>}
        title={whiteboard.title}
        meta={
          <>
            <span>
              {whiteboard.contextName ?? "Personal"} ·{" "}
              {whiteboard.hasMeetingUses
                ? "Kept for meeting history"
                : whiteboard.hasDependentHistory
                  ? "Kept because another board’s history uses its content"
                  : "Never used in a meeting"}
            </span>
            {error ? <span {...stylex.props(styles.error)}>{getErrorMessage(error)}</span> : null}
          </>
        }
        trailing={
          whiteboard.canManageLifecycle ? (
            <>
              <Button
                variant="ghost"
                size="iconSm"
                onClick={() => restoreMutation.mutate()}
                loading={restoreMutation.isPending}
                title="Restore board"
                aria-label={`Restore ${whiteboard.title}`}
              >
                {restoreMutation.isPending ? null : <ArchiveRestore size={16} />}
              </Button>
              <Button
                variant="ghost"
                size="iconSm"
                sx={styles.remove}
                onClick={() => setDeleteOpen(true)}
                disabled={!whiteboard.canPermanentlyDelete}
                title={
                  whiteboard.canPermanentlyDelete
                    ? "Delete permanently"
                    : "Kept archived: meeting history or another board still uses it"
                }
                aria-label={`Delete ${whiteboard.title} permanently`}
              >
                <Trash2 size={16} />
              </Button>
            </>
          ) : undefined
        }
      />
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent size="sm">
          <DialogBody sx={dialogLayout.padded}>
            <DialogTitle>Delete this board for good?</DialogTitle>
            <DialogDescription>
              “{whiteboard.title}” and everything on it will be removed. This can’t be undone.
            </DialogDescription>
            <div {...stylex.props(dialogLayout.actions)}>
              <DialogClose render={<Button variant="secondary" size="sm" />}>Cancel</DialogClose>
              <Button
                variant="danger"
                size="sm"
                loading={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate()}
              >
                Delete permanently
              </Button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
