import { Activity, AlertTriangle, PenTool, PlugZap, RefreshCw, Video } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { UptimeDataState } from "@/pages/status/server/status.functions";
import { uptimeStatusQueryOptions } from "@/app/query-client/queries/status";
import { UptimeBar } from "@/pages/status/components/uptime-bar";
import type {
  RecentIncident,
  ServiceHealth,
  ServiceUptime,
} from "@/pages/status/server/uptimerobot";
import { useNow } from "@/lib/hooks/use-now";
import { EmptyState } from "@orbmeet/ui/react";
import { enter, progress } from "@orbmeet/ui/styles/animations";
import { focus, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { surfaces } from "@orbmeet/ui/styles/surfaces";
import { accent, border, danger, ink, neutral, success, surface, warning } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { PublicNav } from "@/app/shell/public-nav";
import { PublicFooter } from "@/app/shell/public-footer";
import { MAIN_CONTENT_ID } from "@/app/shell/skip-link";

// ─── Wording ─────────────────────────────────────────────────────────

type Tone = "ok" | "warn" | "bad" | "neutral";

const HEALTH: Record<ServiceHealth, { label: string; tone: Tone }> = {
  operational: { label: "Operational", tone: "ok" },
  degraded: { label: "Degraded", tone: "warn" },
  outage: { label: "Outage", tone: "bad" },
  unknown: { label: "No data", tone: "neutral" },
};

function joinNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The one sentence at the top of the page. */
function summarize(services: ServiceUptime[]): { tone: Tone; title: string; detail: string } {
  const outage = services.filter((s) => s.health === "outage").map((s) => s.name);
  const degraded = services.filter((s) => s.health === "degraded");
  if (outage.length > 0) {
    return {
      tone: "bad",
      title: outage.length === services.length ? "Major outage" : "Partial outage",
      detail: `${joinNames(outage)} ${outage.length === 1 ? "is" : "are"} currently unavailable.`,
    };
  }
  if (degraded.length > 0) {
    const meetings = degraded.some((s) => s.service === "meetings");
    return {
      tone: "warn",
      title: "Degraded performance",
      detail: meetings
        ? "Part of our video infrastructure is down. Meetings continue on the rest, and anyone affected reconnects automatically."
        : `${joinNames(degraded.map((s) => s.name))} ${degraded.length === 1 ? "is" : "are"} partly affected.`,
    };
  }
  if (services.some((s) => s.health === "unknown")) {
    return {
      tone: "neutral",
      title: "Some status data is missing",
      detail: "Not every service is reporting right now. This page only shows what the monitors can see.",
    };
  }
  return { tone: "ok", title: "All systems operational", detail: "Everything is running normally." };
}

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── Styles ──────────────────────────────────────────────────────────

const toneText = stylex.create({
  ok: { color: success.s700 },
  warn: { color: warning.w700 },
  bad: { color: danger.d700 },
  neutral: { color: ink.muted },
});

const toneDot = stylex.create({
  ok: { backgroundColor: success.s500 },
  warn: { backgroundColor: warning.w500 },
  bad: { backgroundColor: danger.d500 },
  neutral: { backgroundColor: neutral.n300 },
});

const summaryTone = stylex.create({
  ok: {
    backgroundColor: `color-mix(in oklab, ${success.s50} 70%, ${surface.raised})`,
    borderColor: `color-mix(in oklab, ${success.s200} 70%, transparent)`,
  },
  warn: {
    backgroundColor: `color-mix(in oklab, ${warning.w50} 70%, ${surface.raised})`,
    borderColor: `color-mix(in oklab, ${warning.w200} 70%, transparent)`,
  },
  bad: {
    backgroundColor: `color-mix(in oklab, ${danger.d50} 70%, ${surface.raised})`,
    borderColor: `color-mix(in oklab, ${danger.d200} 70%, transparent)`,
  },
  neutral: {},
});

const styles = stylex.create({
  page: {
    display: "flex",
    flexDirection: "column",
    minHeight: "100vh",
    backgroundColor: surface.canvas,
    fontFamily: fonts.sans,
    color: ink.strong,
  },
  main: {
    flexGrow: 1,
    marginInline: "auto",
    width: "100%",
    maxWidth: "46rem",
    paddingInline: { default: space.s4, [bp.sm]: space.s6 },
    paddingTop: { default: space.s8, [bp.sm]: space.s12 },
    paddingBottom: space.s12,
  },
  title: {
    margin: 0,
    fontFamily: fonts.heading,
    fontSize: "2.25rem",
    lineHeight: 1.05,
    fontWeight: weight.semibold,
    letterSpacing: "-0.045em",
  },
  subtitle: { marginTop: space.s2, marginBottom: 0, color: neutral.n600, lineHeight: leading.relaxed },

  summary: {
    marginTop: space.s8,
    display: "flex",
    flexDirection: { default: "column", [bp.sm]: "row" },
    alignItems: { default: "stretch", [bp.sm]: "center" },
    justifyContent: "space-between",
    gap: space.s4,
    paddingInline: space.s5,
    paddingBlock: space.s4,
  },
  summaryMain: { display: "flex", alignItems: "flex-start", gap: space.s3 },
  summaryDot: { marginTop: 7, flexShrink: 0, width: 10, height: 10, borderRadius: radii.pill },
  summaryTitle: { margin: 0, fontSize: text.base, fontWeight: weight.semibold, lineHeight: leading.base },
  summaryDetail: { marginTop: space.s0_5, marginBottom: 0, fontSize: text.sm, lineHeight: leading.sm, color: neutral.n600 },
  refreshRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: { default: "space-between", [bp.sm]: "flex-end" },
    gap: space.s3,
    flexShrink: 0,
  },
  updated: { fontSize: text.xs, lineHeight: leading.xs, color: ink.muted, fontVariantNumeric: "tabular-nums" },
  refresh: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    borderRadius: radii.control,
    minHeight: { default: null, [env.touch]: 44 },
    paddingInline: space.s3,
    paddingBlock: space.s1_5,
    fontSize: text.xs,
    fontWeight: weight.semibold,
    color: accent.a700,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": accent.a50 } },
    opacity: { default: 1, ":disabled": 0.6 },
  },

  sectionTitle: {
    marginTop: space.s10,
    marginBottom: space.s3,
    fontSize: text.sm,
    fontWeight: weight.semibold,
    color: neutral.n700,
  },
  list: { margin: 0, padding: 0, listStyle: "none" },
  row: {
    paddingInline: space.s5,
    paddingBlock: space.s5,
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: border.subtle,
  },
  rowHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.s3 },
  name: {
    margin: 0,
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    fontSize: text.sm,
    fontWeight: weight.semibold,
    color: ink.strong,
  },
  nameIcon: { color: neutral.n500, flexShrink: 0 },
  state: { display: "inline-flex", alignItems: "center", gap: space.s2, fontSize: text.sm, fontWeight: weight.medium },
  dot: { width: 8, height: 8, borderRadius: radii.pill, flexShrink: 0 },
  bar: { marginTop: space.s4 },
  noData: { marginTop: space.s3, marginBottom: 0, fontSize: text.xs, color: ink.muted },

  incident: {
    display: "flex",
    flexDirection: { default: "column", [bp.sm]: "row" },
    gap: { default: space.s1, [bp.sm]: space.s4 },
    paddingInline: space.s5,
    paddingBlock: space.s4,
  },
  incidentWhen: {
    flexShrink: 0,
    width: { default: "auto", [bp.sm]: "7.5rem" },
    fontSize: text.xs,
    lineHeight: leading.sm,
    color: ink.muted,
    fontVariantNumeric: "tabular-nums",
  },
  incidentTitle: { margin: 0, fontSize: text.sm, lineHeight: leading.sm, fontWeight: weight.medium, color: ink.strong },
  incidentDetail: { marginTop: space.s0_5, marginBottom: 0, fontSize: text.xs, lineHeight: leading.xs, color: neutral.n600 },
  ongoing: { fontWeight: weight.semibold, color: danger.d700 },
  quiet: { margin: 0, paddingInline: space.s5, paddingBlock: space.s4, fontSize: text.sm, color: ink.muted },

  notice: {
    marginTop: space.s4,
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: warning.w800,
  },
  empty: { paddingBlock: space.s12 },

  skeleton: { borderRadius: radii.field, backgroundColor: neutral.n100 },
  skeletonSize: (width: number | string, height: number) => ({ width, height }),
  skeletonBar: { marginTop: space.s4, height: 32 + 24, borderRadius: radii.field, backgroundColor: neutral.n100 },
});

// ─── Pieces ──────────────────────────────────────────────────────────

function Skeleton({ width, height }: { width: number | string; height: number }) {
  return <span {...stylex.props(styles.skeleton, styles.skeletonSize(width, height), progress.pulse)} />;
}

function Summary({
  services,
  fetchedAt,
  refreshing,
  onRefresh,
}: {
  services: ServiceUptime[] | null;
  fetchedAt: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const summary = services ? summarize(services) : null;
  return (
    <section
      aria-live="polite"
      {...stylex.props(surfaces.card, styles.summary, summaryTone[summary?.tone ?? "neutral"])}
    >
      <div {...stylex.props(styles.summaryMain)}>
        <span aria-hidden="true" {...stylex.props(styles.summaryDot, toneDot[summary?.tone ?? "neutral"])} />
        <div>
          <h2 {...stylex.props(styles.summaryTitle)}>
            {summary ? summary.title : <Skeleton width={180} height={16} />}
          </h2>
          <p {...stylex.props(styles.summaryDetail)}>
            {summary ? summary.detail : <Skeleton width={260} height={12} />}
          </p>
        </div>
      </div>
      <div {...stylex.props(styles.refreshRow)}>
        <span {...stylex.props(styles.updated)}>
          {fetchedAt
            ? `Updated ${new Date(fetchedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
            : "Checking…"}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-busy={refreshing}
          {...stylex.props(pressable.base, focus.ring, motion.move, styles.refresh)}
        >
          <RefreshCw size={13} aria-hidden="true" {...stylex.props(refreshing && progress.spin)} />
          Refresh
        </button>
      </div>
    </section>
  );
}

function ServiceRow({ service }: { service: ServiceUptime }) {
  const health = HEALTH[service.health];
  const Icon = service.service === "whiteboard" ? PenTool : Video;
  const hasHistory = service.days.some((day) => day.uptimePct >= 0);
  return (
    <li {...stylex.props(styles.row)}>
      <div {...stylex.props(styles.rowHead)}>
        <h3 {...stylex.props(styles.name)}>
          <Icon size={16} aria-hidden="true" {...stylex.props(styles.nameIcon)} />
          {service.name}
        </h3>
        <span {...stylex.props(styles.state, toneText[health.tone])}>
          <span aria-hidden="true" {...stylex.props(styles.dot, toneDot[health.tone])} />
          {health.label}
        </span>
      </div>
      {hasHistory ? (
        <div {...stylex.props(styles.bar)}>
          <UptimeBar days={service.days} uptimePct={service.uptimePct} />
        </div>
      ) : (
        <p {...stylex.props(styles.noData)}>No uptime history yet.</p>
      )}
    </li>
  );
}

function ServiceRowSkeleton() {
  return (
    <li {...stylex.props(styles.row)}>
      <div {...stylex.props(styles.rowHead)}>
        <Skeleton width={140} height={16} />
        <Skeleton width={90} height={14} />
      </div>
      <div {...stylex.props(styles.skeletonBar, progress.pulse)} />
    </li>
  );
}

function IncidentRow({ incident, now }: { incident: RecentIncident & { service: string }; now: number }) {
  const ongoing = incident.resolvedAt === null;
  const lasted = (ongoing ? now : Date.parse(incident.resolvedAt!)) - Date.parse(incident.startedAt);
  const server = incident.service === "Video meetings" ? "A video server" : `A ${incident.service.toLowerCase()} server`;
  const subject = incident.scope === "service"
    ? `${incident.service} ${ongoing ? "unavailable" : "outage"}`
    : `${server} ${ongoing ? "is down" : "went down"}`;
  return (
    <li {...stylex.props(styles.row, styles.incident)}>
      <time dateTime={incident.startedAt} {...stylex.props(styles.incidentWhen)}>
        {formatWhen(incident.startedAt)}
      </time>
      <div>
        <p {...stylex.props(styles.incidentTitle)}>{subject}</p>
        <p {...stylex.props(styles.incidentDetail)}>
          {ongoing ? (
            <span {...stylex.props(styles.ongoing)}>Ongoing for {formatDuration(lasted)}</span>
          ) : (
            `Resolved after ${formatDuration(lasted)}`
          )}
          {incident.scope === "server" && (incident.serviceAffected
            ? ` · ${incident.service} unavailable`
            : ` · ${incident.service} ${ongoing ? "continue" : "continued"} normally`)}
          {incident.cause && ` · ${incident.cause}`}
        </p>
      </div>
    </li>
  );
}

function emptyStateFor(dataState: UptimeDataState | "loading") {
  if (dataState === "not_configured") {
    return {
      icon: PlugZap,
      title: "Status monitoring isn’t set up",
      description:
        "This deployment has no uptime provider connected, so there is nothing to report here yet. Everything else about Orb Meet works normally.",
    };
  }
  if (dataState === "error") {
    return {
      icon: AlertTriangle,
      title: "Status data is unavailable",
      description:
        "We couldn’t reach the uptime provider just now. This says nothing about the services themselves — try refreshing in a moment.",
    };
  }
  return {
    icon: Activity,
    title: "No monitors yet",
    description: "The uptime provider is connected but isn’t watching any services, so there is no history to show.",
  };
}

// ─── Page ────────────────────────────────────────────────────────────

export function StatusPage() {
  const query = useQuery(uptimeStatusQueryOptions());
  const services = query.data?.services ?? null;
  const dataState: UptimeDataState | "loading" = query.isError ? "error" : query.data?.state ?? "loading";
  const incidents = (services ?? [])
    .flatMap((service) => service.recentIncidents.map((incident) => ({ ...incident, service: service.name })))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, 10);
  const now = useNow(60_000, incidents.some((incident) => incident.resolvedAt === null));
  const loading = services === null && dataState === "loading";
  const hasServices = loading || (services?.length ?? 0) > 0;
  const empty = emptyStateFor(dataState);

  return (
    <div {...stylex.props(styles.page)}>
      <PublicNav />
      <main id={MAIN_CONTENT_ID} {...stylex.props(styles.main, enter.fade)}>
        <h1 {...stylex.props(styles.title)}>System status</h1>
        <p {...stylex.props(styles.subtitle)}>
          Live status and 90-day history of Orb Meet’s services, checked every minute.
        </p>

        {hasServices ? (
          <>
            <Summary
              services={services}
              fetchedAt={query.data?.fetchedAt ?? null}
              refreshing={query.isFetching}
              onRefresh={() => void query.refetch()}
            />
            {(dataState === "stale" || (dataState === "error" && services)) && (
              <p role="status" {...stylex.props(styles.notice)}>
                <AlertTriangle size={14} aria-hidden="true" />
                Showing the last known status; the latest check could not be loaded.
              </p>
            )}

            <h2 {...stylex.props(styles.sectionTitle)}>Services</h2>
            <ul {...stylex.props(surfaces.card, styles.list)}>
              {services
                ? services.map((service) => <ServiceRow key={service.service} service={service} />)
                : [0, 1].map((i) => <ServiceRowSkeleton key={i} />)}
            </ul>

            <h2 {...stylex.props(styles.sectionTitle)}>Past incidents</h2>
            <div {...stylex.props(surfaces.card)}>
              {loading ? (
                <p {...stylex.props(styles.quiet)}>Loading…</p>
              ) : incidents.length === 0 ? (
                <p {...stylex.props(styles.quiet)}>No incidents in the last 90 days.</p>
              ) : (
                <ul {...stylex.props(styles.list)}>
                  {incidents.map((incident) => (
                    <IncidentRow key={incident.id} incident={incident} now={now} />
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : (
          <EmptyState
            icon={empty.icon}
            title={empty.title}
            titleAs="h2"
            description={empty.description}
            sx={styles.empty}
          />
        )}
      </main>
      <PublicFooter />
    </div>
  );
}
