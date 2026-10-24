import { getRouteApi } from "@tanstack/react-router";
import { queryKeys } from "@/app/query-client/query-keys";
import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Users, FileText, AlertTriangle, PenTool, RefreshCw } from "lucide-react";
import type { TLAssetStore } from "tldraw";
import { BrandMark, Button, buttonStyles } from "@orbmeet/ui/react";
import { Card } from "@orbmeet/ui/react";
import { Spinner } from "@orbmeet/ui/react";
import { EmptyState } from "@orbmeet/ui/react";
import { enter } from "@orbmeet/ui/styles/animations";
import { pressable, row } from "@orbmeet/ui/styles/atoms";
import { accent, border, ink, neutral, surface, warning } from "@orbmeet/ui/tokens/colors.stylex";
import { bp } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import {
  participantHandoffQueryOptions,
} from "@/app/query-client/queries/meeting-summary";
import { getParticipantHandoffWhiteboard } from "@/modules/transcripts/server/participant-handoff.functions";
import { roomSnapshotToStoreSnapshot } from "@orbmeet/whiteboard-client/react";
import { whiteboardShapeUtils } from "@orbmeet/whiteboard-client/react";
import { WHITEBOARD_TLDRAW_OPTIONS } from "@orbmeet/whiteboard-client/react";
import { WhiteboardTldraw } from "@/modules/whiteboards/client/surface/whiteboard-canvas";
import { useNow } from "@/lib/hooks/use-now";
import { formatDuration, formatTimeAgo } from "@/pages/meeting-summary/lib/format";
import { glass } from "@orbmeet/ui/tokens/wash.stylex";
import { buildWhiteboardAssetViewerUrl } from "@orbmeet/whiteboard-core/whiteboard-asset-key";

const routeApi = getRouteApi("/handoff/$meetingId");

/** How often to look for the Summary while the meeting's summary job owes one. */
const SUMMARY_POLL_MS = 3_000;

type SummaryData = {
  id: string;
  summary: string;
  durationSeconds: number | null;
  participantCount: number | null;
  transcribedParticipantCount: number | null;
  createdAt: Date | null;
};

const styles = stylex.create({
  shell: {
    marginInline: "auto",
    display: "flex",
    minHeight: "100dvh",
    maxWidth: "72rem",
    alignItems: "center",
    paddingInline: { default: space.s4, [bp.sm]: space.s6, [bp.lg]: space.s8 },
    paddingBlock: space.s10,
  },
  brand: {
    display: "inline-flex",
    alignSelf: "flex-start",
    alignItems: "center",
    gap: space.s2_5,
    color: ink.strong,
    textDecorationLine: "none",
    fontFamily: fonts.heading,
    fontSize: text.base,
    fontWeight: weight.semibold,
    letterSpacing: "-0.02em",
  },
  shellColumn: {
    width: "100%",
    display: "flex",
    flexDirection: "column",
    gap: space.s6,
  },

  /* ── Whiteboards ── */
  boardSection: {
    overflow: "hidden",
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    backgroundColor: surface.raised,
  },
  boardHead: {
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: neutral.n100,
    padding: space.s4,
  },
  boardGlyph: { color: accent.a700 },
  boardTitle: {
    margin: 0,
    fontSize: text.sm,
    fontWeight: weight.semibold,
    color: ink.strong,
  },
  boardNote: {
    marginTop: space.s1,
    marginBottom: 0,
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: ink.muted,
  },
  boardTabs: {
    marginTop: space.s3,
    display: "flex",
    gap: space.s2,
    overflowX: "auto",
  },
  boardTab: {
    flexShrink: 0,
    borderRadius: radii.pill,
    paddingInline: space.s3,
    paddingBlock: space.s1_5,
    fontSize: text.xs,
    fontWeight: weight.medium,
  },
  boardTabSelected: { backgroundColor: accent.a100, color: accent.a800 },
  boardTabIdle: { backgroundColor: neutral.n100, color: neutral.n600 },
  boardFrame: {
    height: "min(65vh, 580px)",
    minHeight: 360,
    backgroundColor: neutral.n50,
  },
  boardSpinner: {
    display: "flex",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
  boardError: {
    display: "flex",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    paddingInline: space.s6,
    fontSize: text.sm,
    color: ink.muted,
  },

  /* ── Status banners ── */
  /** The lit panel behind both status banners; one-route art direction. */
  banner: {
    position: "relative",
    overflow: "hidden",
    borderRadius: radii.panel,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: border.subtle,
    backgroundColor: surface.raised,
    paddingInline: space.s6,
    paddingBlock: space.s16,
  },
  bannerMark: { marginBottom: space.s6 },
  bannerBody: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
  },
  bannerPill: {
    borderRadius: radii.pill,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: `color-mix(in oklab, ${accent.a200} 80%, transparent)`,
    backgroundColor: glass.panel,
    paddingInline: space.s3,
    paddingBlock: space.s1,
    fontSize: text.xs,
    fontWeight: weight.medium,
    textTransform: "uppercase",
    letterSpacing: "0.24em",
    color: accent.a700,
  },
  bannerTitle: {
    marginTop: space.s5,
    marginBottom: 0,
    fontFamily: fonts.heading,
    fontSize: "2rem",
    lineHeight: 1.05,
    fontWeight: weight.semibold,
    letterSpacing: "-0.045em",
    color: ink.strong,
  },
  bannerDetail: {
    marginTop: space.s3,
    marginBottom: 0,
    maxWidth: "42rem",
    fontSize: { default: text.sm, [bp.sm]: text.base },
    lineHeight: leading.xl,
    color: neutral.n600,
  },

  /* ── The wrap-up orbit ── */
  wrapUpRow: {
    marginTop: space.s8,
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    fontSize: text.sm,
    color: ink.muted,
  },
  retryIcon: { marginRight: space.s1_5 },

  /* ── The ready summary ── */
  summaryHead: {
    display: "flex",
    alignItems: "center",
    gap: space.s3,
  },
  summaryTitle: {
    margin: 0,
    fontFamily: fonts.heading,
    fontSize: "1.75rem",
    lineHeight: 1.1,
    letterSpacing: "-0.04em",
    fontWeight: weight.semibold,
    color: ink.strong,
  },
  summarySubtitle: { margin: 0, fontSize: text.sm, color: ink.muted },
  notice: {
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    backgroundColor: neutral.n50,
    paddingInline: space.s4,
    paddingBlock: space.s3,
    fontSize: text.xs,
    lineHeight: leading.lg,
    color: neutral.n600,
  },
  summaryCardRow: { alignItems: "flex-start" },
  summaryFileGlyph: {
    borderRadius: radii.field,
    // `primary-100` was an alias for the neutral scale all along.
    backgroundColor: neutral.n100,
    padding: space.s2,
    flexShrink: 0,
  },
  summaryFileGlyphIcon: { color: accent.a700 },
  summaryText: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.relaxed,
    color: neutral.n700,
  },
  metaRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s4,
    fontSize: text.sm,
    color: ink.muted,
  },
  metaItem: { display: "flex", alignItems: "center", gap: space.s1_5 },
  metaPartial: { color: warning.w700 },
});


export function PublicMeetingSummaryPage() {
  const { meetingId } = routeApi.useParams();
  const { admissionId } = routeApi.useSearch();
  const queryClient = useQueryClient();
  const hasAccessParams = Boolean(admissionId);

  const summaryOptions = participantHandoffQueryOptions(
    meetingId,
    admissionId ?? "",
  );

  const handoffQuery = useQuery({
    ...summaryOptions,
    enabled: hasAccessParams,
    refetchInterval: (query) => {
      // The meeting's summary job writes the Summary; watch for it.
      if (query.state.data?.status === "pending") return SUMMARY_POLL_MS;
      const createdAt = query.state.data?.summary?.createdAt;
      return createdAt && Date.now() - new Date(createdAt).getTime() < 60_000 ? 5_000 : false;
    },
  });
  const whiteboards = handoffQuery.data?.whiteboards ?? [];
  const [selectedWhiteboardId, setSelectedWhiteboardId] = useState<string | null>(null);
  const selectedWhiteboard = whiteboards.find(
    (whiteboard) => whiteboard.whiteboardId === selectedWhiteboardId,
  ) ?? whiteboards[0] ?? null;
  const whiteboardQuery = useQuery({
    queryKey: queryKeys.participantHandoffWhiteboard(meetingId, admissionId ?? "", selectedWhiteboard?.whiteboardId),
    queryFn: ({ signal }) => getParticipantHandoffWhiteboard({
      data: {
        meetingId,
        admissionId: admissionId!,
        whiteboardId: selectedWhiteboard.whiteboardId,
      },
      signal,
    }),
    enabled: hasAccessParams && Boolean(selectedWhiteboard),
    staleTime: Infinity,
    // Snapshot reads are immutable once successful, but a transient edge/R2
    // failure must not strand the handoff screen until a manual reload.
    retry: 2,
  });
  const whiteboardSnapshot = useMemo(
    () => whiteboardQuery.data?.snapshot
      ? roomSnapshotToStoreSnapshot(whiteboardQuery.data.snapshot)
      : null,
    [whiteboardQuery.data],
  );
  const selectedWhiteboardIdForAssets = selectedWhiteboard?.whiteboardId;
  const selectedRevisionIdForAssets = selectedWhiteboard?.revisionId;
  const whiteboardAssets = useMemo<TLAssetStore>(() => ({
    async upload() {
      return { src: "" };
    },
    resolve(asset) {
      // A snapshot predating the sync-side source policy can carry an absolute
      // or protocol-relative URL. Returning it unchanged would make opening an
      // old handoff fetch another origin; the live canvas helper refuses those,
      // and so does this.
      const src = asset.props.src ? buildWhiteboardAssetViewerUrl(asset.props.src) : null;
      if (!src) return null;
      if (
        !src.includes("/api/wb-assets/") ||
        !selectedWhiteboardIdForAssets ||
        !selectedRevisionIdForAssets
      ) return src;
      const separator = src.includes("?") ? "&" : "?";
      const params = new URLSearchParams({
        revisionId: selectedRevisionIdForAssets,
        whiteboardId: selectedWhiteboardIdForAssets,
        meetingId,
        admissionId: admissionId ?? "",
      });
      return `${src}${separator}${params.toString()}`;
    },
  }), [
    admissionId,
    meetingId,
    selectedRevisionIdForAssets,
    selectedWhiteboardIdForAssets,
  ]);

  const now = useNow(30_000, handoffQuery.data?.status === "ready");
  const whiteboardSection = whiteboards.length > 0 ? (
    <section {...stylex.props(styles.boardSection)}>
      <div {...stylex.props(styles.boardHead)}>
        <div {...stylex.props(row.x2)}>
          <PenTool size={16} {...stylex.props(styles.boardGlyph)} />
          <h2 {...stylex.props(styles.boardTitle)}>
            Meeting Whiteboard{whiteboards.length === 1 ? "" : "s"}
          </h2>
        </div>
        <p {...stylex.props(styles.boardNote)}>
          The version that was shared when this Meeting ended.
        </p>
        {whiteboards.length > 1 ? (
          <div {...stylex.props(styles.boardTabs)}>
            {whiteboards.map((whiteboard) => (
              <button
                key={whiteboard.whiteboardId}
                type="button"
                onClick={() => setSelectedWhiteboardId(whiteboard.whiteboardId)}
                {...stylex.props(
                  pressable.base,
                  styles.boardTab,
                  selectedWhiteboard?.whiteboardId === whiteboard.whiteboardId
                    ? styles.boardTabSelected
                    : styles.boardTabIdle,
                )}
              >
                {whiteboard.title}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div {...stylex.props(styles.boardFrame)}>
        {whiteboardQuery.isPending ? (
          <div {...stylex.props(styles.boardSpinner)}>
            <Spinner size="md" brand />
          </div>
        ) : whiteboardSnapshot ? (
          <WhiteboardTldraw
            snapshot={whiteboardSnapshot}
            assets={whiteboardAssets}
            shapeUtils={whiteboardShapeUtils}
            onMount={(editor) => {
              editor.updateInstanceState({ isReadonly: true });
            }}
            options={WHITEBOARD_TLDRAW_OPTIONS}
            licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY || undefined}
          />
        ) : (
          <div {...stylex.props(styles.boardError)}>
            This Meeting Whiteboard could not be loaded.
          </div>
        )}
      </div>
    </section>
  ) : null;

  if (!hasAccessParams) {
    return (
      <PageShell>
        <EmptyState
          icon={AlertTriangle}
          title="Summary unavailable"
          titleAs="h1"
          description="This participant handoff is missing the admission details needed to open it."
          action={
            // One control, not a `<button>` nested inside an `<a>` — that was
            // invalid HTML, two tab stops, and a nested-interactive node in the
            // accessibility tree. `buttonStyles` exists for exactly this: a
            // link that should look like a button.
            <Link to="/" {...stylex.props(...buttonStyles({ variant: "secondary", size: "sm" }))}>
              Return home
            </Link>
          }
        />
      </PageShell>
    );
  }

  if (handoffQuery.isPending && !handoffQuery.data) {
    return (
      <PageShell>
        <Spinner size="lg" brand />
      </PageShell>
    );
  }

  if (handoffQuery.error) {
    return (
      <PageShell>
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load this summary"
          description="We couldn't verify access to this meeting summary."
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void queryClient.invalidateQueries({
                  queryKey: summaryOptions.queryKey,
                });
              }}
            >
              Retry
            </Button>
          }
        />
      </PageShell>
    );
  }

  if (handoffQuery.data?.status === "active") {
    return (
      <PageShell>
        <div {...stylex.props(styles.banner, enter.fadeUp)}>
          <div {...stylex.props(styles.bannerBody)}>
            <p {...stylex.props(styles.bannerPill)}>
              Meeting in progress
            </p>
            <h1 {...stylex.props(styles.bannerTitle)}>
              You left the Meeting
            </h1>
            <p {...stylex.props(styles.bannerDetail)}>
              The Meeting is still going. This page will show its shared outputs after it ends.
            </p>
          </div>
        </div>
        {whiteboardSection}
      </PageShell>
    );
  }

  if (handoffQuery.data?.status === "pending") {
    return (
      <PageShell>
        <div {...stylex.props(styles.banner, enter.fadeUp)}>
          <div {...stylex.props(styles.bannerBody)}>
            {/* Orb at work: the mark's light circles it until the summary is ready. */}
            <BrandMark size={56} state="thinking" sx={styles.bannerMark} />

            <p {...stylex.props(styles.bannerPill)}>
              Meeting ended
            </p>
            <h1 {...stylex.props(styles.bannerTitle)}>
              Wrapping up the meeting
            </h1>
            <p {...stylex.props(styles.bannerDetail)}>
              The Meeting has ended. The Transcript is syncing to prepare your guest-safe Summary.
            </p>
            <p {...stylex.props(styles.wrapUpRow)}>This usually takes a few seconds.</p>
          </div>
        </div>
        {whiteboardSection}
      </PageShell>
    );
  }

  const summary = handoffQuery.data?.summary as SummaryData | null;
  if (!summary) {
    return (
      <PageShell>
        <EmptyState
          icon={AlertTriangle}
          title="Summary unavailable"
          titleAs="h1"
          description="We couldn't prepare the meeting summary yet."
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void queryClient.invalidateQueries({
                  queryKey: summaryOptions.queryKey,
                });
              }}
            >
              <RefreshCw size={14} {...stylex.props(styles.retryIcon)} />
              Retry
            </Button>
          }
        />
        {whiteboardSection}
      </PageShell>
    );
  }

  return (
    <PageShell>
      <div {...stylex.props(styles.summaryHead)}>
        <BrandMark size={28} />
        <div>
          <h1 {...stylex.props(styles.summaryTitle)}>Meeting summary</h1>
          <p {...stylex.props(styles.summarySubtitle)}>Written by Orb</p>
        </div>
      </div>

      <p {...stylex.props(styles.notice)}>
        This private guest handoff includes the AI Summary and Whiteboard captures from the Meeting. The full Transcript and recordings are available only in the retained signed-in Meeting record.
        {handoffQuery.data?.retainUntil
          ? ` This handoff is available until ${new Date(handoffQuery.data.retainUntil).toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" })}.`
          : " This handoff has no scheduled expiry."}
      </p>

      <Card variant="glass">
        <div {...stylex.props(row.x3, styles.summaryCardRow)}>
          <div {...stylex.props(styles.summaryFileGlyph)}>
            <FileText size={16} {...stylex.props(styles.summaryFileGlyphIcon)} />
          </div>
          <p {...stylex.props(styles.summaryText)}>{summary.summary}</p>
        </div>
      </Card>

      {whiteboardSection}

      <div {...stylex.props(styles.metaRow)}>
        {summary.durationSeconds != null && (
          <span {...stylex.props(styles.metaItem)}>
            <Clock size={14} />
            {formatDuration(summary.durationSeconds)}
          </span>
        )}
        {summary.participantCount != null && (
          <span {...stylex.props(styles.metaItem)}>
            <Users size={14} />
            {summary.participantCount} {summary.participantCount === 1 ? "participant" : "participants"}
          </span>
        )}
        {summary.transcribedParticipantCount != null &&
          summary.participantCount != null &&
          summary.transcribedParticipantCount < summary.participantCount && (
            <span {...stylex.props(styles.metaPartial)}>
              Transcript includes {summary.transcribedParticipantCount} of {summary.participantCount} participants
            </span>
          )}
        {summary.createdAt && (
          <span>Generated {formatTimeAgo(summary.createdAt, now)}</span>
        )}
      </div>
    </PageShell>
  );
}

/** A guest's page still says whose it is: the mark and name, back to the site. */
function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div {...stylex.props(styles.shell)}>
      <div {...stylex.props(styles.shellColumn)}>
        <a href="/" {...stylex.props(styles.brand)}>
          <BrandMark size={24} />
          Orb Meet
        </a>
        {children}
      </div>
    </div>
  );
}
