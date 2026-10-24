import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, History, RotateCcw, Undo2, X } from "lucide-react";

import { Spinner } from "@orbmeet/ui/react";
import { layout, motion, pressable, row } from "@orbmeet/ui/styles/atoms";
import { accent, danger, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { env, bp } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";

import { getErrorMessage } from "@/lib/error-inspection";

const styles = stylex.create({
  /**
   * A side column beside the board from `sm`; on a phone, 320px would leave
   * the board a sliver, so the panel covers it instead and closes back to it.
   */
  panel: {
    display: "flex",
    height: "100%",
    width: { default: "100%", [bp.sm]: 320 },
    position: { default: "absolute", [bp.sm]: "static" },
    inset: { default: 0, [bp.sm]: "auto" },
    zIndex: { default: 10, [bp.sm]: "auto" },
    flexShrink: 0,
    flexDirection: "column",
    borderLeftWidth: 1,
    borderLeftStyle: "solid",
    borderLeftColor: neutral.n200,
    backgroundColor: surface.raised,
  },
  head: {
    display: "flex",
    height: 48,
    flexShrink: 0,
    alignItems: "center",
    gap: space.s2,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: neutral.n200,
    paddingInline: space.s4,
  },
  headGlyph: { color: neutral.n500 },
  headTitle: {
    margin: 0,
    flexGrow: 1,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.semibold,
    color: ink.strong,
  },
  close: {
    borderRadius: radii.field,
    padding: space.s1,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
    color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, ":hover": ink.strong } },
  },

  body: { minHeight: 0, flexGrow: 1, overflowY: "auto", padding: space.s3 },
  failure: {
    marginTop: 0,
    marginBottom: space.s2,
    borderRadius: radii.field,
    backgroundColor: danger.d50,
    paddingInline: space.s3,
    paddingBlock: space.s2,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: danger.d700,
  },
  loading: { display: "flex", height: "6rem", alignItems: "center", justifyContent: "center" },
  message: {
    margin: 0,
    paddingInline: space.s2,
    paddingBlock: space.s4,
    fontSize: text.sm,
    lineHeight: leading.relaxed,
    color: ink.muted,
  },
  messageError: { color: danger.d700 },

  list: {
    margin: 0,
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    listStyleType: "none",
    padding: 0,
  },
  entry: {
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    paddingInline: space.s3,
    paddingBlock: space.s2_5,
  },
  entryTitle: {
    margin: 0,
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    color: ink.strong,
  },
  restoreGlyph: { flexShrink: 0, color: ink.muted },
  entryFoot: { marginTop: space.s0_5 },
  stamp: {
    margin: 0,
    display: "flex",
    flexGrow: 1,
    alignItems: "center",
    gap: space.s1,
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: ink.muted,
  },
  /**
   * Restore is revealed by hovering its row rather than shown on every one.
   * Keyboard focus reveals it too — an action that only exists under a pointer
   * is an action half the people here cannot reach.
   */
  restore: {
    display: "flex",
    alignItems: "center",
    gap: space.s1,
    borderRadius: radii.field,
    paddingInline: space.s1_5,
    paddingBlock: space.s0_5,
    fontSize: text.xs,
    fontWeight: weight.medium,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover:not(:disabled)": neutral.n100 } },
    color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, ":hover:not(:disabled)": ink.strong } },
    opacity: {
      default: 0,
      [env.hoverable]: { default: 0, [stylex.when.ancestor(":hover")]: 1 },
      ":focus-visible": 1,
      ":disabled": 0.5,
    },
  },
  restored: {
    marginTop: space.s1,
    marginBottom: 0,
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: accent.a700,
  },
});
import { queryKeys } from "@/app/query-client/query-keys";
import { listWhiteboardSnapshots, restoreWhiteboardSnapshot } from "@/modules/whiteboards/server/api.functions";

type Snapshot = Awaited<
  ReturnType<typeof listWhiteboardSnapshots>
>["snapshots"][number];

const SNAPSHOT_DATE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * A Snapshot is worth reading only if you know which occasion produced it.
 * Falling back to the date beats "revision 4", and a restore point says so
 * outright — it is the one entry someone comes back here looking for.
 */
function snapshotLabel(snapshot: Snapshot): string {
  if (snapshot.kind === "pre_restore") return "Before restore";
  return snapshot.meetingTitle
    ?? (snapshot.kind === "meeting_end" ? "A Meeting" : "Manual snapshot");
}

/**
 * A Whiteboard's history: one immutable revision per Meeting that used it.
 *
 * Snapshots are a byproduct, never a choice — a teacher editing on Tuesday must
 * not silently rewrite what Monday's class saw. They appear here and on the
 * Meeting page, and in no picker: choosing between frozen copies is not a
 * decision anyone should make with a class waiting.
 *
 * Restoring one is a choice, and it lives here rather than anywhere a class is
 * being taught from. It is offered without a confirmation dialog because the
 * server freezes the current state as its own Snapshot first: the way back is
 * this same list, one row further up, which is a better answer than "are you
 * sure?" to someone who is not.
 */
export function WhiteboardHistoryPanel({
  whiteboardId,
  onClose,
}: {
  whiteboardId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [restoredRevisionId, setRestoredRevisionId] = React.useState<string | null>(null);
  const [undoSaved, setUndoSaved] = React.useState(false);

  const snapshots = useQuery({
    queryKey: queryKeys.whiteboards.snapshots(whiteboardId),
    queryFn: ({ signal }) =>
      listWhiteboardSnapshots({ data: { whiteboardId }, signal }),
    staleTime: 30_000,
  });

  const restore = useMutation({
    mutationFn: (revisionId: string) =>
      restoreWhiteboardSnapshot({ data: { whiteboardId, revisionId } }),
    onSuccess: async (result, revisionId) => {
      setRestoredRevisionId(revisionId);
      setUndoSaved(result.restorePointRevisionId !== null);
      // The restore point the server just minted belongs at the top of this
      // list — it is the only route back — and the document now names it as
      // its latest revision.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.whiteboards.snapshots(whiteboardId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.whiteboards.detail(whiteboardId), exact: true }),
      ]);
    },
  });

  return (
    <aside {...stylex.props(styles.panel)}>
      <header {...stylex.props(styles.head)}>
        <History size={15} {...stylex.props(styles.headGlyph)} />
        <h2 {...stylex.props(styles.headTitle)}>History</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close history"
          {...stylex.props(pressable.base, motion.tint, styles.close)}
        >
          <X size={15} />
        </button>
      </header>

      <div {...stylex.props(styles.body)}>
        {restore.error && (
          <p role="alert" {...stylex.props(styles.failure)}>
            {getErrorMessage(restore.error)}
          </p>
        )}
        {snapshots.isPending ? (
          <div {...stylex.props(styles.loading)}>
            <Spinner size="md" brand />
          </div>
        ) : snapshots.error ? (
          <p role="alert" {...stylex.props(styles.message, styles.messageError)}>
            {getErrorMessage(snapshots.error)}
          </p>
        ) : snapshots.data.snapshots.length === 0 ? (
          <p {...stylex.props(styles.message)}>
            No history yet. A snapshot is saved automatically when a Meeting that
            used this Whiteboard ends.
          </p>
        ) : (
          <ol {...stylex.props(styles.list)}>
            {snapshots.data.snapshots.map((snapshot) => (
              <li
                key={snapshot.id}
                {...stylex.props(styles.entry, stylex.defaultMarker())}
              >
                <p {...stylex.props(styles.entryTitle, layout.truncate)}>
                  {snapshot.kind === "pre_restore" && (
                    <Undo2 size={12} {...stylex.props(styles.restoreGlyph)} />
                  )}
                  {snapshotLabel(snapshot)}
                </p>
                <div {...stylex.props(row.x2, styles.entryFoot)}>
                  <p {...stylex.props(styles.stamp)}>
                    <Clock3 size={11} />
                    {SNAPSHOT_DATE_TIME_FORMATTER.format(new Date(snapshot.createdAt))}
                  </p>
                  <button
                    type="button"
                    disabled={restore.isPending}
                    onClick={() => restore.mutate(snapshot.id)}
                    {...stylex.props(pressable.base, motion.tint, styles.restore)}
                  >
                    {restore.isPending && restore.variables === snapshot.id ? (
                      <Spinner size="sm" />
                    ) : (
                      <RotateCcw size={11} />
                    )}
                    Restore
                  </button>
                </div>
                {restoredRevisionId === snapshot.id && !restore.isPending && (
                  <p {...stylex.props(styles.restored)}>
                    {undoSaved ? "Restored. The previous state is saved above." : "Restored."}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}
