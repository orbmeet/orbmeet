import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Clock3, PenTool, Plus, Search } from "lucide-react";

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
import { FilterInput } from "@orbmeet/ui/react";
import { Spinner } from "@orbmeet/ui/react";
import { layout } from "@orbmeet/ui/styles/atoms";
import { accent, danger, neutral, warning } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { queryKeys } from "@/app/query-client/query-keys";
import { deviceTimeZone } from "@/lib/time-zone";
import type { MeetingSurfaceState } from "@/modules/meetings/contract/live-state";
import { createNewWhiteboard, listPresentableWhiteboards, presentWhiteboard } from "@/modules/whiteboards/server/api.functions";

const styles = stylex.create({
  newButton: { marginBottom: space.s4, width: "100%" },
  searchWrap: { marginBottom: space.s3 },
  loading: { display: "flex", height: 128, alignItems: "center", justifyContent: "center" },
  list: {
    maxHeight: "20rem",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
  },
  /** One presentable board: glyph, its names, and the action. */
  choice: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: space.s3,
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    paddingInline: space.s4,
    paddingBlock: space.s3,
  },
  choiceGlyph: {
    display: "flex",
    height: 36,
    width: 36,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.control,
    backgroundColor: accent.a100,
    color: accent.a700,
  },
  choiceBody: { minWidth: 0, flexGrow: 1 },
  choiceTitle: {
    display: "block",
    fontSize: text.sm,
    fontWeight: weight.medium,
    color: neutral.n900,
  },
  choiceContext: { display: "block", fontSize: text.xs, color: neutral.n500 },
  choiceUsed: {
    marginTop: space.s0_5,
    display: "flex",
    alignItems: "center",
    gap: space.s1,
    fontSize: text.xs,
    color: neutral.n500,
  },
  /** Crossing a Space boundary is a consequence the host should see before pressing. */
  choiceCopyNote: {
    marginTop: space.s1,
    display: "block",
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: warning.w700,
  },
  presenting: { flexShrink: 0, fontSize: text.xs, fontWeight: weight.medium, color: neutral.n500 },
  presentButton: { flexShrink: 0 },
  /** Dashed: the shape says "nothing here yet", not "a card you can press". */
  empty: {
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: neutral.n300,
    paddingInline: space.s5,
    paddingBlock: space.s8,
    textAlign: "center",
  },
  emptyGlyph: { display: "inline-flex", color: neutral.n400 },
  emptyTitle: { marginTop: space.s2, marginBottom: 0, fontSize: text.sm, fontWeight: weight.medium, color: neutral.n800 },
  emptyBody: { marginTop: space.s1, marginBottom: 0, fontSize: text.xs, color: neutral.n500 },
  loadMore: { marginTop: space.s3, textAlign: "center" },
  error: { marginTop: space.s3, marginBottom: 0, fontSize: text.sm, color: danger.d600 },
});

interface MeetingWhiteboardPickerProps {
  meetingId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The board is presented: the room's surface as it now stands. */
  onSelected: (surface: MeetingSurfaceState) => void;
  currentWhiteboardId: string | null;
}

/**
 * "Last used in Calculus · Jul 27, 3:50 PM" — provenance, not a precondition.
 * With the time: an untitled meeting's boards are all named for its date, and
 * three from one day were otherwise three identical rows.
 */
function describeLastUse(lastUsedAt: string | null, lastUsedIn: string | null) {
  if (!lastUsedAt) return "Not presented yet";
  const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
    .format(new Date(lastUsedAt));
  return lastUsedIn ? `Last used in ${lastUsedIn} · ${when}` : `Last used ${when}`;
}

/**
 * One action: Present. Crossing a Space boundary transparently creates the
 * Meeting-owned copy required by the ownership model.
 */
export function MeetingWhiteboardPicker({
  meetingId,
  open,
  onOpenChange,
  onSelected,
  currentWhiteboardId,
}: MeetingWhiteboardPickerProps) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const normalizedSearch = search.trim();
  const [debouncedSearch, setDebouncedSearch] = useState(normalizedSearch);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(normalizedSearch), 250);
    return () => window.clearTimeout(timer);
  }, [normalizedSearch]);

  const choices = useInfiniteQuery({
    queryKey: queryKeys.whiteboards.meetingChoiceSearch(meetingId, debouncedSearch),
    queryFn: ({ pageParam, signal }) =>
      listPresentableWhiteboards({
        data: {
          meetingId,
          cursor: pageParam,
          search: debouncedSearch || undefined,
        },
        signal,
      }),
    initialPageParam: undefined as { updatedAt: number; id: string } | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: open,
    staleTime: 10_000,
  });

  const boards = useMemo(() => {
    return choices.data?.pages.flatMap((page) => page.whiteboards) ?? [];
  }, [choices.data]);
  const searchSettling = normalizedSearch !== debouncedSearch;

  const selectMutation = useMutation({
    mutationFn: async (selection: { whiteboardId: string } | { whiteboardId: null }) => {
      const presented = selection.whiteboardId === null
        ? await createNewWhiteboard({
            data: { meetingId, clientTimeZone: deviceTimeZone() },
          })
        : await presentWhiteboard({ data: { meetingId, whiteboardId: selection.whiteboardId } });
      onSelected(presented.surface);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.whiteboards.meetingChoices(meetingId),
          refetchType: "none",
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.whiteboards.list(),
          refetchType: "none",
        }),
      ]);
      onOpenChange(false);
    },
  });

  const error = choices.error ?? selectMutation.error;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Present a Whiteboard</DialogTitle>
          <DialogDescription>
            Continue a Whiteboard from your personal work or a Space you belong to.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <Button
            sx={styles.newButton}
            disabled={selectMutation.isPending}
            onClick={() => selectMutation.mutate({ whiteboardId: null })}
          >
            <Plus size={15} />
            New blank Whiteboard
          </Button>

          <div {...stylex.props(styles.searchWrap)}>
            <FilterInput
              label="Search Whiteboards"
              value={search}
              onChange={(value) => setSearch(value.slice(0, 100))}
              placeholder="Search Whiteboards…"
            />
          </div>

          {choices.isPending || searchSettling ? (
            <div {...stylex.props(styles.loading)}>
              <Spinner size="md" brand />
            </div>
          ) : boards.length ? (
            <div {...stylex.props(styles.list)}>
              {boards.map((whiteboard) => (
                <div
                  key={whiteboard.whiteboardId}
                  {...stylex.props(styles.choice)}
                >
                  <span {...stylex.props(styles.choiceGlyph)}>
                    <PenTool size={17} />
                  </span>
                  <span {...stylex.props(styles.choiceBody)}>
                    <span {...stylex.props(styles.choiceTitle, layout.truncate)}>
                      {whiteboard.title}
                    </span>
                    {whiteboard.contextName && (
                      <span {...stylex.props(styles.choiceContext, layout.truncate)}>
                        {whiteboard.contextName}
                      </span>
                    )}
                    <span {...stylex.props(styles.choiceUsed)}>
                      <Clock3 size={12} />
                      {describeLastUse(whiteboard.lastUsedAt, whiteboard.lastUsedIn)}
                    </span>
                    {whiteboard.isFromAnotherSpace ? (
                      <span {...stylex.props(styles.choiceCopyNote)}>
                        A separate copy will be added to this Meeting's Space. The original stays in {whiteboard.contextName ?? "your personal work"}.
                      </span>
                    ) : null}
                  </span>
                  {currentWhiteboardId === whiteboard.whiteboardId ? (
                    <span {...stylex.props(styles.presenting)}>
                      Presenting
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      sx={styles.presentButton}
                      disabled={selectMutation.isPending}
                      onClick={() => selectMutation.mutate({
                        whiteboardId: whiteboard.whiteboardId,
                      })}
                    >
                      {whiteboard.isFromAnotherSpace ? "Copy & present" : "Present"}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div {...stylex.props(styles.empty)}>
              {debouncedSearch ? (
                <>
                  <span {...stylex.props(styles.emptyGlyph)}><Search size={18} /></span>
                  <p {...stylex.props(styles.emptyTitle)}>
                    No matching Whiteboards
                  </p>
                  <p {...stylex.props(styles.emptyBody)}>Try a different name.</p>
                </>
              ) : (
                <>
                  <p {...stylex.props(styles.emptyTitle)}>
                    No Whiteboards available yet
                  </p>
                  <p {...stylex.props(styles.emptyBody)}>
                    Start a new one above.
                  </p>
                </>
              )}
            </div>
          )}

          {choices.hasNextPage ? (
            <div {...stylex.props(styles.loadMore)}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => { void choices.fetchNextPage(); }}
                loading={choices.isFetchingNextPage}
              >
                {debouncedSearch ? "Load more results" : "Load more Whiteboards"}
              </Button>
            </div>
          ) : null}

          {error && (
            <p {...stylex.props(styles.error)} role="alert">
              {error instanceof Error ? error.message : "Could not load Whiteboards"}
            </p>
          )}
        </DialogBody>

        <DialogFooter>
          <DialogClose
            render={<Button variant="secondary" disabled={selectMutation.isPending} />}
          >
            Cancel
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
