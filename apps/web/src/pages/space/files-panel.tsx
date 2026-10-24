import { useState } from "react";
import {
  useMutation,
  useQueryClient,
  useSuspenseInfiniteQuery,
} from "@tanstack/react-query";
import { openExternalUrl } from "@orbmeet/ui/react";
import { deleteFile, getFileDownloadUrl } from "@/modules/spaces/server/files.functions";
import { queryKeys } from "@/app/query-client/query-keys";
import { getErrorMessage } from "@/lib/error-inspection";
import { filesInfiniteQueryOptions } from "@/app/query-client/queries/files";
import { EmptyState } from "@orbmeet/ui/react";
import { List, ListGlyph, ListRow } from "@/app/shell/list";
import { Button, dialogLayout } from "@orbmeet/ui/react";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@orbmeet/ui/react";
import {
  Download,
  FolderOpen,
  FileText,
  Trash,
  Video,
} from "lucide-react";
import { stack, status } from "@orbmeet/ui/styles/atoms";
import { danger, neutral } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import * as stylex from "@stylexjs/stylex";
import { panelStyles } from "./space-panel-styles";

const styles = stylex.create({
  rowError: { color: danger.d600 },
  remove: {
    color: { default: neutral.n600, [env.hoverable]: { default: neutral.n600, ":hover:not(:disabled)": danger.d700 } },
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover:not(:disabled)": danger.d50 } },
  },
});

const fileTypeLabels = {
  pdf: "PDF",
  recording: "Recording",
  whiteboard_pdf: "Whiteboard PDF",
};

const fileIcons = {
  pdf: FileText,
  recording: Video,
  whiteboard_pdf: FileText,
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilesPanel({
  spaceId,
  viewerId,
  canManageFiles,
}: {
  spaceId: string;
  viewerId: string;
  canManageFiles: boolean;
}) {
  const query = useSuspenseInfiniteQuery(filesInfiniteQueryOptions(spaceId));
  const files = query.data.pages.flatMap((page) => page.files);

  if (files.length === 0) {
    return (
      <EmptyState
        icon={FolderOpen}
        title="No files yet"
        description="Reusable PDFs added from a Whiteboard will appear here."
      />
    );
  }

  return (
    <div {...stylex.props(stack.x3)}>
      <p {...stylex.props(panelStyles.quiet)}>
        Files are reusable sources owned by this Space. Meeting recordings, Summaries, Transcripts, captures, and handouts stay with their originating Meeting.
      </p>
      <List label="Files">
        {files.map((file) => (
          <FileRow
            key={file.id}
            file={file}
            spaceId={spaceId}
            canRemove={canManageFiles || file.uploadedByUserId === viewerId}
          />
        ))}
      </List>
      {query.hasNextPage && (
        <div {...stylex.props(panelStyles.pagerFoot)}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void query.fetchNextPage();
            }}
            loading={query.isFetchingNextPage}
          >
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}

interface ListedFile {
  id: string;
  type: string;
  filename: string;
  size: number | null;
  uploadedByUserId: string | null;
}

function FileRow({
  file,
  spaceId,
  canRemove,
}: {
  file: ListedFile;
  spaceId: string;
  canRemove: boolean;
}) {
  const Icon = fileIcons[file.type as keyof typeof fileIcons] || FolderOpen;
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const downloadMutation = useMutation({
    mutationFn: () => getFileDownloadUrl({ data: { fileId: file.id } }),
    onSuccess: (result) => openExternalUrl(result.url),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteFile({ data: { fileId: file.id } }),
    onSuccess: async () => {
      setDeleteOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.files.bySpace(spaceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.storage.usage() }),
      ]);
    },
  });

  return (
    <>
    <ListRow
      leading={<ListGlyph><Icon size={18} /></ListGlyph>}
      title={file.filename}
      meta={
        <>
          <span>
            {fileTypeLabels[file.type as keyof typeof fileTypeLabels] ?? file.type.replaceAll("_", " ")}
            {" · "}
            {file.size ? formatBytes(file.size) : "—"}
          </span>
          {downloadMutation.isError && (
            <span {...stylex.props(styles.rowError)}>Couldn&apos;t open this file. Try again.</span>
          )}
        </>
      }
      trailing={
        <>
          <Button
            variant="ghost"
            size="iconSm"
            onClick={() => downloadMutation.mutate()}
            loading={downloadMutation.isPending}
            aria-label="Download file"
            title="Download"
          >
            {downloadMutation.isPending ? null : <Download size={16} />}
          </Button>
          {canRemove ? (
            <Button
              variant="ghost"
              size="iconSm"
              sx={styles.remove}
              onClick={() => setDeleteOpen(true)}
              aria-label="Remove file"
              title="Remove"
            >
              <Trash size={16} />
            </Button>
          ) : null}
        </>
      }
    />
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent size="sm">
          <DialogBody sx={dialogLayout.padded}>
            <DialogTitle>Remove File?</DialogTitle>
            <DialogDescription>
              Removes &ldquo;{file.filename}&rdquo; from this Space&apos;s reusable File
              library. Whiteboard pages already imported from it stay intact.
            </DialogDescription>
            <div {...stylex.props(dialogLayout.actions)}>
              <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
              <Button
                variant="danger"
                loading={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate()}
              >
                Remove File
              </Button>
            </div>
            {deleteMutation.isError ? (
              <p {...stylex.props(status.error)}>
                {getErrorMessage(deleteMutation.error)}
              </p>
            ) : null}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
