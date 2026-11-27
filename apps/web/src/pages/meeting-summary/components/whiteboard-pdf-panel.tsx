import { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button, buttonStyles, openExternalUrl } from "@orbmeet/ui/react";
import { AlertTriangle, Copy, Download, FileDown, Loader2, RefreshCw, SquarePen } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import type { Editor, TLAssetId, TLAssetStore, TLShapeId } from "tldraw";
import {
  buildWhiteboardPdfBlob,
  getDrawableShapeEntries,
  getFrameExportContent,
  mergeWhiteboardPdfBlobs,
  roomSnapshotToStoreSnapshot,
  WHITEBOARD_TLDRAW_OPTIONS,
  whiteboardShapeUtils,
} from "@orbmeet/whiteboard-client/react";
import { isPageFrameShape, sortPageFrames } from "@orbmeet/whiteboard-core/page-frame-model";
import { progress } from "@orbmeet/ui/styles/animations";
import { focus, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { accent, border, danger, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { getWhiteboardPdfDownloadUrl } from "@/modules/meetings/server/history/output-downloads.functions";
import {
  getMeetingWhiteboardHistory,
  getMeetingWhiteboardSnapshots,
  getWhiteboardSnapshot,
  saveMeetingWhiteboardCopy,
} from "@/modules/whiteboards/server/export.functions";
import { retryWhiteboardCapture } from "@/modules/whiteboards/server/meeting-actions.functions";
import { WhiteboardTldraw } from "@/modules/whiteboards/client/surface/whiteboard-canvas";
import { uploadMeetingWhiteboardPdf } from "@/modules/whiteboards/client/upload-meeting-whiteboard-pdf";
import { getWhiteboardClientCapabilities } from "@/lib/browser-capabilities";
import { queryKeys } from "@/lib/query-keys";
import { reportBoundaryError } from "@/lib/telemetry/client-errors";
import type { getEndedMeeting } from "@/modules/transcripts/server/meeting-summary.functions";
import { setMeetingWhiteboardCopyPolicy } from "@/modules/whiteboards/server/api.functions";
import { publishMeetingPreview } from "@/modules/whiteboards/client/publish-meeting-preview";
import { revisionAssetUrl, type RevisionAssetScope } from "./revision-asset-url";

const PREVIEW_DELAY_MS = 2_500;
const PDF_RENDERER_READY_TIMEOUT_MS = 15_000;

type EndedMeeting = NonNullable<
  Awaited<ReturnType<typeof getEndedMeeting>>["meeting"]
>;

type StoreSnapshot = ReturnType<typeof roomSnapshotToStoreSnapshot>;
type MeetingWhiteboardHistoryResult = Awaited<ReturnType<typeof getMeetingWhiteboardHistory>>;

interface ActivePdfRender {
  id: number;
  snapshot: StoreSnapshot;
  assets: TLAssetStore;
  onEditorReady: (editor: Editor) => void;
  onError: (error: Error) => void;
}

class PdfRendererErrorBoundary extends Component<{
  children: ReactNode;
  onError: (error: Error) => void;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportBoundaryError("summary-pdf", error, info.componentStack);
    this.props.onError(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const styles = stylex.create({
  /**
   * The off-screen renderer PDF export draws into. Fixed and far left rather
   * than `display: none`, because tldraw measures the DOM it is given.
   */
  hiddenRenderer: {
    pointerEvents: "none",
    position: "fixed",
    left: -10000,
    top: 0,
    height: 900,
    width: 1200,
    overflow: "hidden",
    opacity: 0,
  },
  panel: {
    overflow: "hidden",
    borderRadius: radii.card,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: border.subtle,
    backgroundColor: surface.raised,
    boxShadow: shadows.hairline,
  },
  head: {
    display: "flex",
    flexDirection: { default: "column", [bp.sm]: "row" },
    alignItems: { default: "stretch", [bp.sm]: "center" },
    justifyContent: { default: "flex-start", [bp.sm]: "space-between" },
    gap: space.s4,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: neutral.n100,
    paddingInline: { default: space.s4, [bp.sm]: space.s5 },
    paddingBlock: space.s4,
  },
  identity: { minWidth: 0 },
  heading: {
    margin: 0,
    fontSize: text.sm,
    fontWeight: weight.semibold,
    color: ink.strong,
  },
  description: { marginTop: space.s1, marginBottom: 0, fontSize: text.sm, color: neutral.n500 },
  failure: { marginTop: space.s2, marginBottom: 0, fontSize: text.xs, color: danger.d600 },
  /** Quiet actions under the description: the copy toggle and the copy link. */
  textActions: {
    marginTop: space.s3,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space.s4,
    rowGap: space.s2,
  },
  textAction: { fontSize: text.xs, gap: space.s1, textDecorationLine: "none" },
  copyPolicy: { color: { default: neutral.n600, [env.hoverable]: { default: neutral.n600, ":hover:not(:disabled)": ink.strong } } },
  pending: { marginTop: 0, fontSize: text.xs, color: neutral.n500 },
  /** The strip of board switchers when a Meeting used more than one board. */
  boardTabs: {
    display: "flex",
    gap: space.s2,
    overflowX: "auto",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: neutral.n100,
    backgroundColor: surface.raised,
    paddingInline: space.s5,
    paddingBlock: space.s3,
  },
  boardTab: {
    flexShrink: 0,
    borderRadius: radii.pill,
    paddingInline: space.s3,
    paddingBlock: space.s1_5,
    fontSize: text.xs,
    fontWeight: weight.medium,
  },
  /** Teal in the old palette; the chosen board wears the whiteboard accent. */
  boardTabSelected: { backgroundColor: accent.a100, color: accent.a800 },
  boardTabIdle: {
    backgroundColor: { default: neutral.n100, [env.hoverable]: { default: neutral.n100, ":hover": neutral.n200 } },
    color: neutral.n600,
  },
  /** Tall enough to read a page, never taller than most viewports. */
  canvas: {
    height: "min(70vh, 640px)",
    minHeight: 420,
    backgroundColor: neutral.n50,
  },
  statusRow: {
    display: "flex",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s2,
    fontSize: text.sm,
    color: neutral.n500,
  },
  statusColumn: {
    display: "flex",
    height: "100%",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s3,
    paddingInline: space.s6,
    textAlign: "center",
    fontSize: text.sm,
    color: neutral.n500,
  },
  statusError: {
    display: "flex",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    paddingInline: space.s6,
    textAlign: "center",
    fontSize: text.sm,
    color: neutral.n500,
  },
  failureGlyph: { color: danger.d500 },
});

function getPdfPageIds(editor: Editor, includedPageIds: readonly string[]): TLShapeId[] {
  const included = new Set(includedPageIds);
  return sortPageFrames(
    editor
      .getCurrentPageShapesSorted()
      .filter(isPageFrameShape)
      .filter((shape) => included.has(shape.id)),
  ).map((shape) => shape.id);
}

function limitViewerToHandoutPages(editor: Editor, pageIds: readonly string[]): void {
  const included = new Set(pageIds);
  const frames = editor.getCurrentPageShapesSorted().filter(isPageFrameShape);
  const entries = getDrawableShapeEntries(editor);
  const keptTopLevelShapes = new Set<TLShapeId>();
  for (const frame of frames) {
    if (!included.has(frame.id)) continue;
    const bounds = editor.getShapePageBounds(frame.id);
    if (!bounds) continue;
    for (const shapeId of getFrameExportContent(editor, frame.id, bounds, entries).shapeIds) {
      keptTopLevelShapes.add(shapeId);
    }
  }

  const remove = editor.getCurrentPageShapesSorted()
    .filter((shape) => {
      if (isPageFrameShape(shape)) return !included.has(shape.id);
      if (typeof shape.parentId === "string" && shape.parentId.startsWith("shape:")) {
        return false;
      }
      return !keptTopLevelShapes.has(shape.id);
    })
    .map((shape) => shape.id);
  if (remove.length > 0) {
    // This is a projection of an immutable capture, not an edit. Keeping it out
    // of history prevents undo from revealing pages that were not handed out.
    editor.run(() => editor.deleteShapes(remove), { history: "ignore" });
  }
}

/**
 * Rest the capture at a zoom that shows its first page whole.
 *
 * Nothing else sets this viewer's camera, so it opened wherever the capture's
 * own camera left it — at 100% in a panel a fraction of the width the board was
 * drawn on, which cut the page off at the right and bottom edges. A capture
 * billed as "frozen as participants saw it" was showing less than participants
 * saw. Fitting the whole handout instead shrank a seven-page board to a column
 * of thumbnails nobody could read; the first page, whole, is both honest and
 * legible, and the rest are a scroll away.
 */
function fitViewerToHandout(editor: Editor, pageIds: readonly string[]): void {
  const [first] = getPdfPageIds(editor, pageIds);
  const bounds = (first && editor.getShapePageBounds(first)) || editor.getCurrentPageBounds();
  if (!bounds) return;
  // Tighter than tldraw's 128px `zoomToFitPadding` default, which on a panel
  // this size spends more of the frame on margin than on the board.
  editor.zoomToBounds(bounds, { inset: 16 });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function useWhiteboardPdfActions(
  meetingId: string,
  hasCapturedWhiteboards: boolean,
  onGenerated?: () => void,
) {
  const [phase, setPhase] = useState<
    "idle" | "loading" | "rendering" | "uploading" | "opening"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [activeRender, setActiveRender] = useState<ActivePdfRender | null>(null);
  const nextRenderIdRef = useRef(0);
  const operationInFlightRef = useRef(false);

  const renderBoardPdf = useCallback(
    async (
      snapshot: StoreSnapshot,
      scope: RevisionAssetScope,
      includedPageIds: readonly string[],
    ): Promise<Blob> => {
      let prefetchOverride: Map<TLAssetId, string> | null = null;
      const assets: TLAssetStore = {
        async upload() {
          return { src: "" };
        },
        resolve(asset) {
          const cached = prefetchOverride?.get(asset.id);
          if (cached) return cached;
          return revisionAssetUrl(asset.props.src ?? null, scope);
        },
      };

      const renderId = ++nextRenderIdRef.current;
      const editor = await new Promise<Editor>((resolve, reject) => {
        let settled = false;
        const finish = (cb: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cb();
        };
        const timer = setTimeout(() => {
          finish(() => {
            setActiveRender((current) => (current?.id === renderId ? null : current));
            reject(new Error("The Whiteboard renderer did not become ready. Please try again."));
          });
        }, PDF_RENDERER_READY_TIMEOUT_MS);

        setActiveRender({
          id: renderId,
          snapshot,
          assets,
          onEditorReady: (mountedEditor) => finish(() => resolve(mountedEditor)),
          onError: (err) => finish(() => {
            setActiveRender((current) => (current?.id === renderId ? null : current));
            reject(err);
          }),
        });
      });

      try {
        const pageIds = getPdfPageIds(editor, includedPageIds);
        if (pageIds.length === 0) {
          throw new Error("The saved Whiteboard pages are not present in this version.");
        }
        return await buildWhiteboardPdfBlob(editor, pageIds, {
          capabilities: getWhiteboardClientCapabilities(),
          setPrefetchOverride: (map) => {
            prefetchOverride = map;
          },
        });
      } finally {
        prefetchOverride = null;
        setActiveRender((current) => (current?.id === renderId ? null : current));
      }
    },
    [],
  );

  const openExistingPdf = useCallback(async () => {
    if (operationInFlightRef.current) return;
    operationInFlightRef.current = true;
    setError(null);
    setPhase("opening");
    try {
      if (!hasCapturedWhiteboards) throw new Error("This Meeting has no saved Whiteboard.");
      const { downloadUrl } = await getWhiteboardPdfDownloadUrl({ data: { meetingId } });
      openExternalUrl(downloadUrl);
    } catch (err) {
      setError(errorMessage(err, "Could not open PDF."));
    } finally {
      operationInFlightRef.current = false;
      setPhase("idle");
    }
  }, [hasCapturedWhiteboards, meetingId]);

  // Generating never opens the PDF itself: by the time it is saved, the click
  // that asked for it is long past what any browser lets open a tab, and the
  // button it leaves behind, "Download PDF", opens it on a click of its own.
  const startGenerate = useCallback(async () => {
    if (operationInFlightRef.current) return;
    operationInFlightRef.current = true;
    setError(null);
    setPhase("loading");
    try {
      if (!hasCapturedWhiteboards) throw new Error("This Meeting has no saved Whiteboard.");
      const result = await getMeetingWhiteboardSnapshots({ data: { meetingId } });
      const available = result.whiteboards.filter(
        (item): item is typeof item & { snapshot: NonNullable<typeof item.snapshot> } =>
          item.snapshot !== null && item.pageIds.length > 0,
      );
      if (available.length === 0) {
        throw new Error(
          result.omittedForSize > 0
            ? "This Meeting's Whiteboards are too large to export together. Open a Whiteboard to export it on its own."
            : "No Whiteboard pages were presented or edited during this Meeting.",
        );
      }

      setPhase("rendering");
      const blobs: Blob[] = [];
      for (const item of available) {
        blobs.push(
          await renderBoardPdf(
            roomSnapshotToStoreSnapshot(item.snapshot),
            {
              whiteboardId: item.whiteboard.whiteboardId,
              revisionId: item.whiteboard.revisionId,
            },
            item.pageIds,
          ),
        );
      }

      const pdf = blobs.length === 1 ? blobs[0] : await mergeWhiteboardPdfBlobs(blobs);
      setPhase("uploading");
      await uploadMeetingWhiteboardPdf(meetingId, pdf);
      onGenerated?.();
    } catch (err) {
      setError(errorMessage(err, "Could not generate whiteboard PDF."));
    } finally {
      operationInFlightRef.current = false;
      setPhase("idle");
    }
  }, [hasCapturedWhiteboards, meetingId, onGenerated, renderBoardPdf]);

  const hiddenRenderer = useMemo(() => {
    if (!activeRender) return null;
    return (
      <div
        aria-hidden="true"
        {...stylex.props(styles.hiddenRenderer)}
      >
        <PdfRendererErrorBoundary
          key={activeRender.id}
          onError={activeRender.onError}
        >
          <WhiteboardTldraw
            snapshot={activeRender.snapshot}
            assets={activeRender.assets}
            shapeUtils={whiteboardShapeUtils}
            onMount={activeRender.onEditorReady}
            hideUi
            options={WHITEBOARD_TLDRAW_OPTIONS}
            licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY || undefined}
          />
        </PdfRendererErrorBoundary>
      </div>
    );
  }, [activeRender]);

  return {
    error,
    phase,
    isBusy: phase !== "idle",
    hiddenRenderer,
    openExistingPdf,
    startGenerate,
  };
}

/** What the PDF button says while it works — each phase in its own words. */
const pdfPhaseLabel: Record<string, string> = {
  idle: "Generate PDF",
  loading: "Loading…",
  rendering: "Rendering pages…",
  uploading: "Saving PDF…",
  opening: "Opening…",
};

export function MeetingWhiteboardPanel({
  meeting,
  onGenerated,
}: {
  meeting: EndedMeeting;
  /** Fired after a PDF is generated so callers can refresh meeting lists. */
  onGenerated?: () => void;
}) {
  const queryClient = useQueryClient();
  const [selectedWhiteboardId, setSelectedWhiteboardId] = useState<string | null>(null);
  const [captureOverride, setCaptureOverride] = useState<{
    meetingId: string;
    state: EndedMeeting["whiteboardCaptureState"];
  } | null>(null);
  const captureState = captureOverride?.meetingId === meeting.meetingId
    ? captureOverride.state
    : meeting.whiteboardCaptureState;

  const historyQueryKey = useMemo(
    () => queryKeys.whiteboards.meetingHistory(meeting.meetingId),
    [meeting.meetingId],
  );
  const historyQuery = useQuery({
    queryKey: historyQueryKey,
    queryFn: () => getMeetingWhiteboardHistory({ data: { meetingId: meeting.meetingId } }),
    enabled: captureState === "captured",
  });

  const whiteboards = useMemo(
    () => historyQuery.data?.whiteboards ?? [],
    [historyQuery.data],
  );
  const hasCapturedWhiteboards = historyQuery.data?.hasCapturedWhiteboards ?? false;

  const selectedWhiteboard = whiteboards.find(
    (item) => item.whiteboardId === selectedWhiteboardId,
  ) ?? whiteboards[0] ?? null;
  const selectedDocumentId = selectedWhiteboard?.whiteboardId ?? null;
  const selectedBoardOpenable = meeting.whiteboardsShown.some(
    (board) => board.whiteboardId === selectedDocumentId && board.openable,
  );
  const selectedRevisionId = selectedWhiteboard?.revisionId ?? null;
  const selectedAssetScope = useMemo<RevisionAssetScope | null>(
    () => (selectedDocumentId && selectedRevisionId
      ? { whiteboardId: selectedDocumentId, revisionId: selectedRevisionId }
      : null),
    [selectedDocumentId, selectedRevisionId],
  );

  const [localPdfState, setLocalPdfState] = useState(() => ({
    meetingId: meeting.meetingId,
    hasGeneratedPdf: false,
  }));
  // What this view generated counts only for the meeting it generated it for;
  // after moving to another meeting, the server's word is all there is.
  const hasGeneratedPdf = whiteboards.some((item) => item.hasPdf)
    || meeting.hasWhiteboardPdf
    || (localPdfState.meetingId === meeting.meetingId && localPdfState.hasGeneratedPdf);

  const handlePdfGenerated = useCallback(() => {
    setLocalPdfState({ meetingId: meeting.meetingId, hasGeneratedPdf: true });
    queryClient.setQueryData<MeetingWhiteboardHistoryResult>(historyQueryKey, (current) => {
      if (!current || current.whiteboard === null) return current;
      return {
        ...current,
        whiteboards: current.whiteboards.map((item) => ({ ...item, hasPdf: true })),
      };
    });
    onGenerated?.();
  }, [historyQueryKey, meeting.meetingId, onGenerated, queryClient]);

  const actions = useWhiteboardPdfActions(
    meeting.meetingId,
    whiteboards.length > 0,
    handlePdfGenerated,
  );

  const snapshotQuery = useQuery({
    queryKey: queryKeys.whiteboards.meetingSnapshot(
      meeting.meetingId,
      selectedDocumentId,
      selectedRevisionId,
    ),
    queryFn: async () => {
      const result = await getWhiteboardSnapshot({
        data: {
          meetingId: meeting.meetingId,
          whiteboardId: selectedDocumentId,
        },
      });
      if (!result.snapshot) {
        throw new Error("The Meeting Whiteboard is not available.");
      }
      if (result.pageIds.length === 0) {
        throw new Error("No pages from this Whiteboard were presented or edited during the Meeting.");
      }
      return {
        snapshot: roomSnapshotToStoreSnapshot(result.snapshot),
        pageIds: result.pageIds,
      };
    },
    enabled: captureState === "captured" && Boolean(selectedDocumentId) && hasCapturedWhiteboards,
  });

  const retryCaptureMutation = useMutation({
    mutationFn: () => retryWhiteboardCapture({ data: { meetingId: meeting.meetingId } }),
    onSuccess: (result) => {
      setCaptureOverride({ meetingId: meeting.meetingId, state: result.captureState });
    },
  });

  const saveCopyMutation = useMutation({
    mutationFn: (whiteboardId: string) =>
      saveMeetingWhiteboardCopy({
        data: { meetingId: meeting.meetingId, whiteboardId },
      }),
  });

  const copyPolicyMutation = useMutation({
    mutationFn: ({
      whiteboardId,
      allowParticipantCopy,
    }: {
      meetingWhiteboardId: string;
      whiteboardId: string;
      allowParticipantCopy: boolean;
    }) =>
      setMeetingWhiteboardCopyPolicy({
        data: { meetingId: meeting.meetingId, whiteboardId, allowParticipantCopy },
      }),
    onSuccess: (_, { meetingWhiteboardId, allowParticipantCopy }) => {
      queryClient.setQueryData<MeetingWhiteboardHistoryResult>(historyQueryKey, (current) => {
        if (!current || current.whiteboard === null) return current;
        return {
          ...current,
          whiteboards: current.whiteboards.map((item) =>
            item.meetingWhiteboardId === meetingWhiteboardId
              ? { ...item, allowParticipantCopy }
              : item,
          ),
        };
      });
    },
  });

  const { reset: resetSaveCopy } = saveCopyMutation;
  const { reset: resetCopyPolicy } = copyPolicyMutation;
  const resetCopyFeedback = useCallback(() => {
    resetSaveCopy();
    resetCopyPolicy();
  }, [resetSaveCopy, resetCopyPolicy]);

  useEffect(() => {
    resetCopyFeedback();
  }, [meeting.meetingId, resetCopyFeedback]);

  const autoGenerateMeetingIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      captureState !== "captured" ||
      !meeting.canManageMeeting ||
      !hasCapturedWhiteboards ||
      whiteboards.length === 0 ||
      hasGeneratedPdf ||
      actions.isBusy ||
      autoGenerateMeetingIdRef.current === meeting.meetingId
    ) return;
    autoGenerateMeetingIdRef.current = meeting.meetingId;
    void actions.startGenerate();
  }, [
    actions,
    hasCapturedWhiteboards,
    whiteboards.length,
    captureState,
    hasGeneratedPdf,
    meeting.canManageMeeting,
    meeting.meetingId,
  ]);

  const viewerAssets = useMemo<TLAssetStore>(() => ({
    async upload() {
      return { src: "" };
    },
    resolve(asset) {
      return revisionAssetUrl(asset.props.src ?? null, selectedAssetScope);
    },
  }), [selectedAssetScope]);

  if (captureState === "none") return null;

  const viewerStatus:
    | { phase: "loading" }
    | { phase: "error"; error: string }
    | { phase: "ready"; snapshot: StoreSnapshot; pageIds: string[] } =
    historyQuery.isPending
      ? { phase: "loading" }
      : historyQuery.isError
        ? { phase: "error", error: errorMessage(historyQuery.error, "Could not load Whiteboard history.") }
        : whiteboards.length === 0
          ? { phase: "error", error: "This Meeting has no completed Whiteboard." }
          : !hasCapturedWhiteboards
            ? { phase: "error", error: "The Meeting PDF is available to attendees; the editable Whiteboard remains private." }
            : snapshotQuery.isPending
              ? { phase: "loading" }
              : snapshotQuery.isError
                ? { phase: "error", error: errorMessage(snapshotQuery.error, "Could not load the Whiteboard.") }
                : { phase: "ready", snapshot: snapshotQuery.data.snapshot, pageIds: snapshotQuery.data.pageIds };

  return (
    <div {...stylex.props(styles.panel)}>
      {captureState === "captured" ? actions.hiddenRenderer : null}
      <div {...stylex.props(styles.head)}>
        <div {...stylex.props(styles.identity)}>
          <div>
            {/* h3: this panel sits inside the "Whiteboards used" section, so an
                h2 made it a sibling of its own container and put two
                near-identical "Whiteboards" headings at the same level. */}
            <h3 {...stylex.props(styles.heading)}>
              {whiteboards.length === 1 ? selectedWhiteboard?.title ?? "Whiteboard" : "Whiteboards"}
            </h3>
            <p {...stylex.props(styles.description)}>
              {captureState === "captured"
                ? whiteboards.length > 1
                  ? `${whiteboards.length} Whiteboards were used in this Meeting. The PDF combines only pages presented or edited here.`
                  : "The board as it was when the meeting ended. The board itself can still be edited."
                : captureState === "capturing"
                  ? "Saving the Meeting Whiteboards. They will become available here shortly."
                  : "The Meeting Whiteboards could not be saved. Retry before this Meeting's temporary history is cleaned up."}
            </p>
            {retryCaptureMutation.error ? (
              <p role="alert" {...stylex.props(styles.failure)}>
                {errorMessage(retryCaptureMutation.error, "Could not retry saving the Whiteboard.")}
              </p>
            ) : null}
            {actions.error ? (
              <p role="alert" {...stylex.props(styles.failure)}>{actions.error}</p>
            ) : null}
            {saveCopyMutation.error ? (
              <p role="alert" {...stylex.props(styles.failure)}>
                {errorMessage(saveCopyMutation.error, "Could not save a copy.")}
              </p>
            ) : null}
            {copyPolicyMutation.error ? (
              <p role="alert" {...stylex.props(styles.failure)}>
                {errorMessage(copyPolicyMutation.error, "Could not update copy access.")}
              </p>
            ) : null}
            {captureState === "captured" && (meeting.canManageMeeting || selectedWhiteboard?.allowParticipantCopy || selectedBoardOpenable) && selectedWhiteboard ? (
              <div {...stylex.props(styles.textActions)}>
                {selectedBoardOpenable ? (
                  <Link
                    to="/whiteboards/$whiteboardId"
                    params={{ whiteboardId: selectedWhiteboard.whiteboardId }}
                    {...stylex.props(...buttonStyles({ variant: "link", sx: styles.textAction }))}
                  >
                    <SquarePen size={13} aria-hidden="true" />
                    Open board
                  </Link>
                ) : null}
                {meeting.canManageMeeting ? (
                  <Button
                    variant="link"
                    onClick={() =>
                      copyPolicyMutation.mutate({
                        meetingWhiteboardId: selectedWhiteboard.meetingWhiteboardId,
                        whiteboardId: selectedWhiteboard.whiteboardId,
                        allowParticipantCopy: !selectedWhiteboard.allowParticipantCopy,
                      })
                    }
                    disabled={copyPolicyMutation.isPending}
                    aria-pressed={selectedWhiteboard.allowParticipantCopy}
                    sx={[styles.textAction, styles.copyPolicy]}
                  >
                    {copyPolicyMutation.isPending ? (
                      <Loader2 size={13} {...stylex.props(progress.spin)} />
                    ) : (
                      <Copy size={13} />
                    )}
                    Attendees can save a copy: {selectedWhiteboard.allowParticipantCopy ? "On" : "Off"}
                  </Button>
                ) : null}
                {selectedWhiteboard.allowParticipantCopy ? (
                  <Button
                    variant="link"
                    onClick={() => saveCopyMutation.mutate(selectedWhiteboard.whiteboardId)}
                    disabled={saveCopyMutation.isPending || saveCopyMutation.isSuccess}
                    sx={styles.textAction}
                  >
                    {saveCopyMutation.isPending ? (
                      <Loader2 size={13} {...stylex.props(progress.spin)} />
                    ) : (
                      <Copy size={13} />
                    )}
                    {saveCopyMutation.isSuccess ? "Saved to my Whiteboards" : "Save a copy"}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        {captureState === "failed" && meeting.canManageMeeting ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => retryCaptureMutation.mutate()}
            loading={retryCaptureMutation.isPending}
          >
            {retryCaptureMutation.isPending ? "Retrying…" : <><RefreshCw size={14} /> Retry capture</>}
          </Button>
        ) : captureState !== "captured" ? null : hasGeneratedPdf ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void actions.openExistingPdf();
            }}
            loading={actions.isBusy}
          >
            {actions.isBusy ? "Opening…" : <><Download size={14} /> Download PDF</>}
          </Button>
        ) : !hasCapturedWhiteboards ? (
          // Reached only when the Meeting captured no Whiteboard at all, so
          // there is nothing to generate from and never will be.
          <span {...stylex.props(styles.pending)}>No Whiteboard was used in this Meeting</span>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void actions.startGenerate();
            }}
            loading={actions.isBusy}
          >
            {actions.isBusy ? pdfPhaseLabel[actions.phase] : <><FileDown size={14} /> Generate PDF</>}
          </Button>
        )}
      </div>
      {captureState === "captured" && whiteboards.length > 1 ? (
        <div {...stylex.props(styles.boardTabs)}>
          {whiteboards.map((item) => (
            <button
              key={item.meetingWhiteboardId}
              type="button"
              onClick={() => {
                resetCopyFeedback();
                setSelectedWhiteboardId(item.whiteboardId);
              }}
              {...stylex.props(
                pressable.base,
                motion.tint,
                focus.ring,
                styles.boardTab,
                selectedWhiteboard?.meetingWhiteboardId === item.meetingWhiteboardId
                  ? styles.boardTabSelected
                  : styles.boardTabIdle,
              )}
            >
              {item.title}
            </button>
          ))}
        </div>
      ) : null}
      <div {...stylex.props(styles.canvas)}>
        {captureState === "capturing" ? (
          <div {...stylex.props(styles.statusRow)}>
            <Loader2 size={16} {...stylex.props(progress.spin)} /> Saving Whiteboards…
          </div>
        ) : captureState === "failed" ? (
          <div {...stylex.props(styles.statusColumn)}>
            <AlertTriangle size={22} {...stylex.props(styles.failureGlyph)} />
            The Meeting Whiteboards could not be saved. The editable originals remain unchanged in their Spaces.
          </div>
        ) : viewerStatus.phase === "loading" ? (
          <div {...stylex.props(styles.statusRow)}>
            <Loader2 size={16} {...stylex.props(progress.spin)} /> Loading Whiteboard…
          </div>
        ) : viewerStatus.phase === "error" ? (
          <div {...stylex.props(styles.statusError)}>
            {viewerStatus.error}
          </div>
        ) : (
          <WhiteboardTldraw
            key={selectedDocumentId}
            snapshot={viewerStatus.snapshot}
            assets={viewerAssets}
            shapeUtils={whiteboardShapeUtils}
            onMount={(editor) => {
              limitViewerToHandoutPages(editor, viewerStatus.pageIds);
              // After the trim, so the fit measures the handout rather than the
              // pages that were just removed from it.
              fitViewerToHandout(editor, viewerStatus.pageIds);
              editor.updateInstanceState({ isReadonly: true });
              // The meeting's first board stands for it in lists. A moment's
              // wait lets the page's images arrive before it is drawn.
              const [firstPage] = getPdfPageIds(editor, viewerStatus.pageIds);
              if (!meeting.canManageMeeting || !firstPage || selectedDocumentId !== whiteboards[0]?.whiteboardId) return;
              const timer = window.setTimeout(() => {
                publishMeetingPreview(editor, meeting.meetingId, firstPage).catch(() => {});
              }, PREVIEW_DELAY_MS);
              return () => window.clearTimeout(timer);
            }}
            options={WHITEBOARD_TLDRAW_OPTIONS}
            licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY || undefined}
          />
        )}
      </div>
    </div>
  );
}
