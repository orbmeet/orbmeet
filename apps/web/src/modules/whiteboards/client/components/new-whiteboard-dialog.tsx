import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { Button } from "@orbmeet/ui/react";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@orbmeet/ui/react";
import { Input } from "@orbmeet/ui/react";
import { Select } from "@orbmeet/ui/react";
import { stack, status } from "@orbmeet/ui/styles/atoms";
import { ink } from "@orbmeet/ui/tokens/colors.stylex";
import { leading, text } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";

import { getErrorMessage } from "@/lib/error-inspection";

const styles = stylex.create({
  note: { margin: 0, fontSize: text.xs, lineHeight: leading.sm, color: ink.muted },
});
import { queryKeys } from "@/app/query-client/query-keys";
import { createWhiteboard } from "@/modules/whiteboards/server/api.functions";

/** The Space to create in. `null` means personal work and is never named. */
interface WhiteboardSpaceChoice {
  id: string;
  name: string;
}

interface NewWhiteboardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Fixed target Space, as on a Space's Whiteboards panel. When omitted the
   * dialog offers `spaceChoices` plus personal work.
   */
  spaceId?: string;
  spaceChoices?: WhiteboardSpaceChoice[];
}

const OWN_SPACE = "own";

/**
 * Naming the Whiteboard is the whole point of this dialog: it is the moment a
 * person decides a document exists, which is what keeps the list from filling
 * with rows nobody can tell apart.
 */
export function NewWhiteboardDialog({
  open,
  onOpenChange,
  spaceId,
  spaceChoices,
}: NewWhiteboardDialogProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState(OWN_SPACE);

  const resetForm = () => {
    setTitle("");
    setTarget(OWN_SPACE);
  };
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) resetForm();
    onOpenChange(nextOpen);
  };

  const createMutation = useMutation({
    mutationFn: () =>
      createWhiteboard({
        data: {
          title: title.trim(),
          spaceId: spaceId ?? (target === OWN_SPACE ? null : target),
        },
    }),
    onSuccess: async (result) => {
      const targetSpaceId = spaceId ?? (target === OWN_SPACE ? null : target);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.whiteboards.list() }),
        ...(targetSpaceId
          ? [queryClient.invalidateQueries({
              queryKey: queryKeys.spaces.whiteboards(targetSpaceId),
            })]
          : []),
      ]);
      resetForm();
      onOpenChange(false);
      await navigate({
        to: "/whiteboards/$whiteboardId",
        params: { whiteboardId: result.whiteboardId },
      });
    },
  });

  const canSubmit = title.trim().length > 0 && !createMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="sm">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) createMutation.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>New Whiteboard</DialogTitle>
            <DialogDescription>
              Create a visual document with pages. Use it alone, in a Space, or during a Meeting.
            </DialogDescription>
          </DialogHeader>

          <DialogBody sx={stack.x4}>
            <Input
              autoFocus
              label="Name"
              value={title}
              maxLength={200}
              placeholder="Calculus · Chapter 4"
              onChange={(event) => setTitle(event.target.value)}
            />
            {!spaceId && spaceChoices && spaceChoices.length > 0 && (
              <Select
                label="Where"
                value={target}
                onValueChange={(value) => setTarget(value ?? OWN_SPACE)}
                options={[
                  // Personal work is never rendered by an internal storage name: its absence
                  // elsewhere in the product is what says "mine".
                  { label: "Personal", value: OWN_SPACE },
                  ...spaceChoices.map((space) => ({
                    label: space.name,
                    value: space.id,
                  })),
                ]}
              />
            )}
            <p {...stylex.props(styles.note)}>
              {spaceId || target !== OWN_SPACE
                ? "Every current member of the selected Space can open, rename, and edit this Whiteboard."
                : "A Personal Whiteboard is private to you until you deliberately present it in a Meeting."}
            </p>
            {createMutation.error && (
              <p role="alert" {...stylex.props(status.error, status.flush)}>
                {getErrorMessage(createMutation.error)}
              </p>
            )}
          </DialogBody>

          <DialogFooter>
            <DialogClose
              render={<Button variant="secondary" disabled={createMutation.isPending} />}
            >
              Cancel
            </DialogClose>
            <Button type="submit" disabled={!canSubmit}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
