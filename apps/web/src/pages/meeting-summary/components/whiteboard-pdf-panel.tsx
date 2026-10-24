import { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { Button, openExternalUrl } from "@orbmeet/ui/react";
import { AlertTriangle, Copy, Download, FileDown, Loader2, RefreshCw } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import type { Editor, TLAssetId, TLAssetStore, TLShapeId } from "tldraw";
import {
  buildWhiteboardPdfBlob,
  mergeWhiteboardPdfBlobs,
  roomSnapshotToStoreSnapshot,
} from "@orbmeet/whiteboard-client/react";
import { whiteboardShapeUtils } from "@orbmeet/whiteboard-client/react";
import { WHITEBOARD_TLDRAW_OPTIONS } from "@orbmeet/whiteboard-client/react";
import { isPageFrameShape } from "@orbmeet/whiteboard-core/page-frame-model";
import {
  getDrawableShapeEntries,
  getFrameExportContent,
} from "@orbmeet/whiteboard-client/react";
import { progress } from "@orbmeet/ui/styles/animations";
import { focus, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { accent, border, danger, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import {
  getWhiteboardPdfDownloadUrl,
  getWhiteboardSnapshot,
  getMeetingWhiteboardHistory,
  getMeetingWhiteboardSnapshots,
  saveMeetingWhiteboardCopy,
} from "@/modules/whiteboards/server/export.functions";
import { retryWhiteboardCapture } from "@/modules/whiteboards/server/meeting-actions.functions";
import { WhiteboardTldraw } from "@/modules/whiteboards/client/surface/whiteboard-canvas";
import { getWhiteboardClientCapabilities } from "@/lib/browser-capabilities";
import { reportBoundaryError } from "@/lib/telemetry/client-errors";
import type { getEndedMeeting } from "@/modules/transcripts/server/meeting-summary.functions";
import { setMeetingWhiteboardCopyPolicy } from "@/modules/whiteboards/server/api.functions";
import { revisionAssetUrl, type RevisionAssetScope } from "./revision-asset-url";

type EndedMeeting = NonNullable<
  Awaited<ReturnType<typeof getEndedMeeting>>["meeting"]
>;

type StoreSnapshot = ReturnType<typeof roomSnapshotToStoreSnapshot>;

interface PdfExportJob {
  id: number;
  snapshot: StoreSnapshot;
  scope: RevisionAssetScope;
  pageIds: string[];
}

const PDF_RENDERER_READY_TIMEOUT_MS = 15_000;

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
  textAction: { fontSize: text.xs },
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
  return editor
    .getCurrentPageShapesSorted()
    .filter(isPageFrameShape)
    .filter((shape) => included.has(shape.id))
    .sort((a, b) => {
      const ay = typeof a.y === "number" ? a.y : 0;
      const by = typeof b.y === "number" ? b.y : 0;
      if (ay !== by) return ay - by;
      const ax = typeof a.x === "number" ? a.x : 0;
      const bx = typeof b.x === "number" ? b.x : 0;
      return ax - bx;
    })
    .map((shape) => shape.id);
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

function useWhiteboardPdfActions(
  meetingId: string,
  hasCapturedWhiteboards: boolean,
  onGenerated?: () => void,
) {
  const [phase, setPhase] = useState<
    "idle" | "loading" | "rendering" | "uploading" | "opening"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [exportJob, setExportJob] = useState<PdfExportJob | null>(null);
  const nextExportJobIdRef = useRef(0);
  const runningExportJobIdRef = useRef<number | null>(null);
  const queuedExportJobsRef = useRef<PdfExportJob[]>([]);
  const renderedPdfBlobsRef = useRef<Blob[]>([]);
  const prefetchOverrideRef = useRef<Map<TLAssetId, string> | null>(null);
  const assetScopeRef = useRef<RevisionAssetScope | null>(null);
  const exportJobPageIdsRef = useRef<string[]>([]);
  const openAfterGenerateRef = useRef(true);
  const operationInFlightRef = useRef(false);
  const rendererReadyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const failExportJob = useCallback((jobId: number, error: unknown) => {
    if (rendererReadyTimerRef.current) clearTimeout(rendererReadyTimerRef.current);
    rendererReadyTimerRef.current = null;
    if (runningExportJobIdRef.current === jobId) runningExportJobIdRef.current = null;
    setExportJob((current) => (current?.id === jobId ? null : current));
    prefetchOverrideRef.current = null;
    queuedExportJobsRef.current = [];
    renderedPdfBlobsRef.current = [];
    operationInFlightRef.current = false;
    setError(error instanceof Error ? error.message : "Could not generate whiteboard PDF.");
    setPhase("idle");
  }, []);

  useEffect(() => {
    if (!exportJob) return;
    // A child may call onMount before this parent's passive effect runs. In
    // that ordering the renderer is already ready and no watchdog is needed.
    if (runningExportJobIdRef.current === exportJob.id) return;
    if (rendererReadyTimerRef.current) clearTimeout(rendererReadyTimerRef.current);
    rendererReadyTimerRef.current = setTimeout(() => {
      failExportJob(
        exportJob.id,
        new Error("The Whiteboard renderer did not become ready. Please try again."),
      );
    }, PDF_RENDERER_READY_TIMEOUT_MS);
    return () => {
      if (rendererReadyTimerRef.current) clearTimeout(rendererReadyTimerRef.current);
      rendererReadyTimerRef.current = null;
    };
  }, [exportJob, failExportJob]);

  const assetStore = useMemo<TLAssetStore>(() => ({
    async upload(_asset, _file, _abortSignal) {
      return { src: "" };
    },
    resolve(asset, _ctx) {
      const cached = prefetchOverrideRef.current?.get(asset.id);
      if (cached) return cached;
      return revisionAssetUrl(asset.props.src ?? null, assetScopeRef.current);
    },
  }), []);

  const isBusy = phase !== "idle";

  const openExistingPdf = useCallback(async (withinGeneration = false) => {
    if (operationInFlightRef.current && !withinGeneration) return;
    if (!withinGeneration) operationInFlightRef.current = true;
    setError(null);
    setPhase("opening");
    try {
      if (!hasCapturedWhiteboards) throw new Error("This Meeting has no saved Whiteboard.");
      const { downloadUrl } = await getWhiteboardPdfDownloadUrl({ data: { meetingId } });
      openExternalUrl(downloadUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open PDF.");
    } finally {
      if (!withinGeneration) operationInFlightRef.current = false;
      setPhase("idle");
    }
  }, [hasCapturedWhiteboards, meetingId]);

  const startGenerate = useCallback(async (openAfterGenerate = true) => {
    if (operationInFlightRef.current) return;
    operationInFlightRef.current = true;
    setError(null);
    setPhase("loading");
    openAfterGenerateRef.current = openAfterGenerate;
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
      const jobs = available.map((item) => ({
        id: ++nextExportJobIdRef.current,
        snapshot: roomSnapshotToStoreSnapshot(item.snapshot),
        scope: { whiteboardId: item.whiteboard.whiteboardId, revisionId: item.whiteboard.revisionId },
        pageIds: item.pageIds,
      }));
      renderedPdfBlobsRef.current = [];
      queuedExportJobsRef.current = jobs.slice(1);
      assetScopeRef.current = jobs[0].scope;
      exportJobPageIdsRef.current = jobs[0].pageIds;
      setExportJob(jobs[0]);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not load the Meeting capture.",
      );
      operationInFlightRef.current = false;
      setPhase("idle");
    }
  }, [hasCapturedWhiteboards, meetingId]);

  const handleEditorMount = useCallback(
    (editor: Editor, jobId: number) => {
      if (runningExportJobIdRef.current === jobId) return;
      if (rendererReadyTimerRef.current) clearTimeout(rendererReadyTimerRef.current);
      rendererReadyTimerRef.current = null;
      runningExportJobIdRef.current = jobId;

      void (async () => {
        setPhase("rendering");
        try {
          const pageIds = getPdfPageIds(editor, exportJobPageIdsRef.current);
          if (pageIds.length === 0) {
            throw new Error("The saved Whiteboard pages are not present in this version.");
          }
          const boardPdf = await buildWhiteboardPdfBlob(
            editor,
            pageIds,
            {
              capabilities: getWhiteboardClientCapabilities(),
              setPrefetchOverride: (map) => {
                prefetchOverrideRef.current = map;
              },
            },
          );
          renderedPdfBlobsRef.current.push(boardPdf);
          const nextJob = queuedExportJobsRef.current.shift();
          if (nextJob) {
            assetScopeRef.current = nextJob.scope;
            exportJobPageIdsRef.current = nextJob.pageIds;
            runningExportJobIdRef.current = null;
            setExportJob(nextJob);
            return;
          }

          const pdf = renderedPdfBlobsRef.current.length === 1
            ? renderedPdfBlobsRef.current[0]
            : await mergeWhiteboardPdfBlobs(renderedPdfBlobsRef.current);
          setPhase("uploading");
          const uploadEndpoint =
            `/api/whiteboard/pdf-upload?meetingId=${encodeURIComponent(meetingId)}`;
          const grantResponse = await fetch(`${uploadEndpoint}&phase=grant`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fileSize: pdf.size }),
            credentials: "same-origin",
          });
          if (!grantResponse.ok) {
            throw new Error(`PDF upload grant failed: ${grantResponse.status}`);
          }
          const grant = await grantResponse.json() as {
            uploadId: string;
            uploadUrl: string;
          };

          const uploadResponse = await fetch(grant.uploadUrl, {
            method: "PUT",
            headers: {
              "Content-Type": "application/pdf",
            },
            body: pdf,
          });
          if (!uploadResponse.ok) {
            throw new Error(`PDF upload failed: ${uploadResponse.status}`);
          }

          const finalizeResponse = await fetch(`${uploadEndpoint}&phase=finalize`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fileSize: pdf.size, uploadId: grant.uploadId }),
            credentials: "same-origin",
          });
          if (!finalizeResponse.ok) {
            throw new Error(`PDF finalize failed: ${finalizeResponse.status}`);
          }

          setExportJob((current) => (current?.id === jobId ? null : current));
          onGenerated?.();
          if (openAfterGenerateRef.current) await openExistingPdf(true);
        } catch (err) {
          setError(
            err instanceof Error
              ? err.message
              : "Could not generate whiteboard PDF.",
          );
        } finally {
          if (runningExportJobIdRef.current === jobId) {
            runningExportJobIdRef.current = null;
            setExportJob((current) => (current?.id === jobId ? null : current));
            prefetchOverrideRef.current = null;
            queuedExportJobsRef.current = [];
            renderedPdfBlobsRef.current = [];
            operationInFlightRef.current = false;
            setPhase("idle");
          }
        }
      })();
    },
    [meetingId, onGenerated, openExistingPdf],
  );

  const hiddenRenderer = useMemo(() => {
    if (!exportJob) return null;
    return (
      <div
        aria-hidden="true"
        {...stylex.props(styles.hiddenRenderer)}
      >
        <PdfRendererErrorBoundary
          key={exportJob.id}
          onError={(error) => failExportJob(exportJob.id, error)}
        >
          <WhiteboardTldraw
            snapshot={exportJob.snapshot}
            assets={assetStore}
            shapeUtils={whiteboardShapeUtils}
            onMount={(editor) => handleEditorMount(editor, exportJob.id)}
            hideUi
            options={WHITEBOARD_TLDRAW_OPTIONS}
            licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY || undefined}
          />
        </PdfRendererErrorBoundary>
      </div>
    );
  }, [assetStore, exportJob, failExportJob, handleEditorMount]);

  return {
    error,
    phase,
    isBusy,
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
  const [whiteboards, setWhiteboards] = useState<Array<{
    meetingWhiteboardId: string;
    whiteboardId: string;
    revisionId: string;
    title: string;
    capturedAt: string | null;
    attachedAt: string;
    hasPdf: boolean;
    allowParticipantCopy: boolean;
  }>>([]);
  const [selectedWhiteboardId, setSelectedWhiteboardId] = useState<string | null>(null);
  const [hasCapturedWhiteboards, setCanReadDocuments] = useState(false);
  const selectedWhiteboard = whiteboards.find(
    (item) => item.whiteboardId === selectedWhiteboardId,
  ) ?? whiteboards[0] ?? null;
  const selectedDocumentId = selectedWhiteboard?.whiteboardId ?? null;
  const selectedRevisionId = selectedWhiteboard?.revisionId ?? null;
  const selectedAssetScope = useMemo<RevisionAssetScope | null>(
    () => (selectedDocumentId && selectedRevisionId
      ? { whiteboardId: selectedDocumentId, revisionId: selectedRevisionId }
      : null),
    [selectedDocumentId, selectedRevisionId],
  );
  const [localPdfState, setLocalPdfState] = useState(() => ({
    meetingId: meeting.meetingId,
    hasGeneratedPdf: meeting.hasWhiteboardPdf,
  }));
  const hasGeneratedPdf = whiteboards.some((item) => item.hasPdf) || (
    localPdfState.meetingId === meeting.meetingId
      ? localPdfState.hasGeneratedPdf || meeting.hasWhiteboardPdf
      : false
  );
  const actions = useWhiteboardPdfActions(meeting.meetingId, whiteboards.length > 0, () => {
    setLocalPdfState({ meetingId: meeting.meetingId, hasGeneratedPdf: true });
    setWhiteboards((current) => current.map((item) => ({ ...item, hasPdf: true })));
    onGenerated?.();
  });
  const [captureOverride, setCaptureOverride] = useState<{
    meetingId: string;
    state: EndedMeeting["whiteboardCaptureState"];
  } | null>(null);
  const captureState = captureOverride?.meetingId === meeting.meetingId
    ? captureOverride.state
    : meeting.whiteboardCaptureState;
  const [captureRetryState, setCaptureRetryState] = useState<"idle" | "retrying">("idle");
  const [captureRetryError, setCaptureRetryError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "saving" | "saved">("idle");
  const [copyError, setCopyError] = useState<string | null>(null);
  const [copyPolicyState, setCopyPolicyState] = useState<"idle" | "saving">("idle");
  const [copyPolicyError, setCopyPolicyError] = useState<string | null>(null);
  const autoGenerateMeetingIdRef = useRef<string | null>(null);
  const [viewerState, setViewerState] = useState<
    | { phase: "loading"; snapshot: null; error: null }
    | { phase: "ready"; snapshot: StoreSnapshot; pageIds: string[]; error: null }
    | { phase: "error"; snapshot: null; error: string }
  >({ phase: "loading", snapshot: null, error: null });
  const viewerAssets = useMemo<TLAssetStore>(() => ({
    async upload() {
      return { src: "" };
    },
    resolve(asset) {
      return revisionAssetUrl(asset.props.src ?? null, selectedAssetScope);
    },
  }), [selectedAssetScope]);

  const resetCopyFeedback = useCallback(() => {
    setCopyState("idle");
    setCopyError(null);
    setCopyPolicyError(null);
  }, []);

  useEffect(() => {
    if (captureState !== "captured") return;
    let active = true;
    void getMeetingWhiteboardHistory({ data: { meetingId: meeting.meetingId } })
      .then(({ whiteboards: history, hasCapturedWhiteboards: canRead }) => {
        if (!active) return;
        resetCopyFeedback();
        setWhiteboards(history);
        setCanReadDocuments(canRead ?? false);
        setSelectedWhiteboardId((current) =>
          history.some((item) => item.whiteboardId === current)
            ? current
            : history[0]?.whiteboardId ?? null,
        );
        if (history.length === 0) {
          setViewerState({
            phase: "error",
            snapshot: null,
            error: "This Meeting has no completed Whiteboard.",
          });
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        setViewerState({
          phase: "error",
          snapshot: null,
          error: error instanceof Error ? error.message : "Could not load Whiteboard history.",
        });
      });
    return () => {
      active = false;
    };
  }, [captureState, meeting.meetingId, resetCopyFeedback]);

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
    void actions.startGenerate(false);
  }, [
    actions,
    hasCapturedWhiteboards,
    whiteboards.length,
    captureState,
    hasGeneratedPdf,
    meeting.canManageMeeting,
    meeting.meetingId,
  ]);

  useEffect(() => {
    if (captureState !== "captured" || !selectedDocumentId) return;
    if (!hasCapturedWhiteboards) {
      setViewerState({
        phase: "error",
        snapshot: null,
        error: "The Meeting PDF is available to attendees; the editable Whiteboard remains private.",
      });
      return;
    }
    let active = true;
    setViewerState({ phase: "loading", snapshot: null, error: null });
    void getWhiteboardSnapshot({
      data: {
        meetingId: meeting.meetingId,
        whiteboardId: selectedDocumentId,
      },
    })
      .then((result) => {
        if (!active) return;
        if (!result.snapshot) {
          setViewerState({
            phase: "error",
            snapshot: null,
            error: "The Meeting Whiteboard is not available.",
          });
          return;
        }
        if (result.pageIds.length === 0) {
          setViewerState({
            phase: "error",
            snapshot: null,
            error: "No pages from this Whiteboard were presented or edited during the Meeting.",
          });
          return;
        }
        setViewerState({
          phase: "ready",
          snapshot: roomSnapshotToStoreSnapshot(result.snapshot),
          pageIds: result.pageIds,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setViewerState({
          phase: "error",
          snapshot: null,
          error: error instanceof Error ? error.message : "Could not load the Whiteboard.",
        });
      });
    return () => {
      active = false;
    };
  }, [
    hasCapturedWhiteboards,
    captureState,
    meeting.meetingId,
    selectedDocumentId,
    selectedRevisionId,
  ]);

  if (captureState === "none") return null;

  const retryCapture = async () => {
    setCaptureRetryError(null);
    setCaptureRetryState("retrying");
    try {
      const result = await retryWhiteboardCapture({ data: { meetingId: meeting.meetingId } });
      setCaptureOverride({ meetingId: meeting.meetingId, state: result.captureState });
    } catch (error) {
      setCaptureRetryError(error instanceof Error ? error.message : "Could not retry saving the Whiteboard.");
    } finally {
      setCaptureRetryState("idle");
    }
  };

  const saveCopy = async () => {
    if (!selectedWhiteboard) return;
    setCopyError(null);
    setCopyState("saving");
    try {
      await saveMeetingWhiteboardCopy({
        data: {
          meetingId: meeting.meetingId,
          whiteboardId: selectedWhiteboard.whiteboardId,
        },
      });
      setCopyState("saved");
    } catch (error) {
      setCopyState("idle");
      setCopyError(error instanceof Error ? error.message : "Could not save a copy.");
    }
  };

  const toggleCopyPolicy = async () => {
    if (!selectedWhiteboard) return;
    const allowParticipantCopy = !selectedWhiteboard.allowParticipantCopy;
    setCopyPolicyError(null);
    setCopyPolicyState("saving");
    try {
      await setMeetingWhiteboardCopyPolicy({
        data: {
          meetingId: meeting.meetingId,
          whiteboardId: selectedWhiteboard.whiteboardId,
          allowParticipantCopy,
        },
      });
      setWhiteboards((current) => current.map((item) =>
        item.meetingWhiteboardId === selectedWhiteboard.meetingWhiteboardId
          ? { ...item, allowParticipantCopy }
          : item
      ));
    } catch (error) {
      setCopyPolicyError(
        error instanceof Error ? error.message : "Could not update copy access.",
      );
    } finally {
      setCopyPolicyState("idle");
    }
  };

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
            {captureRetryError ? <p role="alert" {...stylex.props(styles.failure)}>{captureRetryError}</p> : null}
            {actions.error ? (
              <p role="alert" {...stylex.props(styles.failure)}>{actions.error}</p>
            ) : null}
            {copyError ? <p role="alert" {...stylex.props(styles.failure)}>{copyError}</p> : null}
            {copyPolicyError ? (
              <p role="alert" {...stylex.props(styles.failure)}>{copyPolicyError}</p>
            ) : null}
            {captureState === "captured" && (meeting.canManageMeeting || selectedWhiteboard?.allowParticipantCopy) && selectedWhiteboard ? (
              <div {...stylex.props(styles.textActions)}>
                {meeting.canManageMeeting ? (
                  <Button
                    variant="link"
                    onClick={() => void toggleCopyPolicy()}
                    disabled={copyPolicyState === "saving"}
                    aria-pressed={selectedWhiteboard.allowParticipantCopy}
                    sx={[styles.textAction, styles.copyPolicy]}
                  >
                    {copyPolicyState === "saving" ? (
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
                    onClick={() => void saveCopy()}
                    disabled={copyState !== "idle"}
                    sx={styles.textAction}
                  >
                    {copyState === "saving" ? (
                      <Loader2 size={13} {...stylex.props(progress.spin)} />
                    ) : (
                      <Copy size={13} />
                    )}
                    {copyState === "saved" ? "Saved to my Whiteboards" : "Save a copy"}
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
            onClick={() => void retryCapture()}
            loading={captureRetryState === "retrying"}
          >
            {captureRetryState === "retrying" ? "Retrying…" : <><RefreshCw size={14} /> Retry capture</>}
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
        ) : viewerState.phase === "loading" ? (
          <div {...stylex.props(styles.statusRow)}>
            <Loader2 size={16} {...stylex.props(progress.spin)} /> Loading Whiteboard…
          </div>
        ) : viewerState.phase === "error" ? (
          <div {...stylex.props(styles.statusError)}>
            {viewerState.error}
          </div>
        ) : (
          <WhiteboardTldraw
            snapshot={viewerState.snapshot}
            assets={viewerAssets}
            shapeUtils={whiteboardShapeUtils}
            onMount={(editor) => {
              limitViewerToHandoutPages(editor, viewerState.pageIds);
              // After the trim, so the fit measures the handout rather than the
              // pages that were just removed from it.
              fitViewerToHandout(editor, viewerState.pageIds);
              editor.updateInstanceState({ isReadonly: true });
            }}
            options={WHITEBOARD_TLDRAW_OPTIONS}
            licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY || undefined}
          />
        )}
      </div>
    </div>
  );
}
