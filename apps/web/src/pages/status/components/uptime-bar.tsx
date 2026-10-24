import { surfaces } from "@orbmeet/ui/styles/surfaces";
import { danger, ink, neutral, success, warning } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { zIndex } from "@orbmeet/ui/tokens/layers.stylex";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { DayUptime } from "@/pages/status/server/uptimerobot";

/** Narrow screens show the last month, so each bar stays wide enough to read. */
const MOBILE_DAYS = 30;

type DayLevel = "none" | "ok" | "minor" | "major";

/**
 * A day's severity. Minor: a server had trouble, or the service was briefly
 * down. Major: the service was down for more than 1% of the day (~15 min).
 */
function levelOf(day: DayUptime): DayLevel {
  if (day.uptimePct < 0) return "none";
  if (day.uptimePct < 99) return "major";
  if (day.uptimePct < 100 || day.hasIncident) return "minor";
  return "ok";
}

function formatUptimePct(pct: number | null): string {
  if (pct === null) return "—";
  if (pct >= 100) return "100%";
  // Round down, so any downtime never displays as 100.00%.
  return `${(Math.floor(pct * 100) / 100).toFixed(2)}%`;
}

function formatDay(iso: string): string {
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function describeDay(day: DayUptime, level: DayLevel): string {
  if (level === "none") return "No data";
  if (day.uptimePct < 100) return `${formatUptimePct(day.uptimePct)} available`;
  if (day.hasIncident) return "A server had trouble; service stayed up";
  return "No incidents";
}

const fill = stylex.create({
  none: { backgroundColor: neutral.n200 },
  ok: { backgroundColor: success.s400 },
  minor: { backgroundColor: warning.w400 },
  major: { backgroundColor: danger.d500 },
});

const styles = stylex.create({
  root: { position: "relative" },
  strip: { display: "flex", gap: 2, height: 32 },
  bar: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    borderRadius: 2,
    opacity: { default: 1, [env.hoverable]: { default: 1, ":hover": 0.7 } },
  },
  /** Older than a month: hidden on narrow screens. */
  older: { display: { default: "none", [bp.sm]: "block" } },
  scale: {
    marginTop: space.s2,
    display: "flex",
    justifyContent: "space-between",
    gap: space.s3,
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: ink.muted,
  },
  uptime: { fontWeight: weight.medium, color: neutral.n600, fontVariantNumeric: "tabular-nums" },
  wide: { display: { default: "none", [bp.sm]: "inline" } },
  narrow: { display: { default: "inline", [bp.sm]: "none" } },
  tooltip: {
    pointerEvents: "none",
    position: "absolute",
    bottom: "100%",
    zIndex: zIndex.tooltip,
    marginBottom: space.s2,
    transform: "translateX(-50%)",
    paddingInline: space.s3,
    paddingBlock: space.s2,
    whiteSpace: "nowrap",
    borderRadius: radii.card,
    boxShadow: shadows.elevated,
    fontSize: text.xs,
    lineHeight: leading.xs,
  },
  tooltipX: (left: number) => ({ left }),
  tooltipDate: { margin: 0, color: neutral.n300 },
  tooltipDetail: { margin: 0, marginTop: space.s0_5, fontWeight: weight.semibold },
});

const tooltipTone = stylex.create({
  none: { color: neutral.n300 },
  ok: { color: success.s300 },
  minor: { color: warning.w300 },
  major: { color: danger.d300 },
});

/**
 * 90 days of history as a strip of bars. The bars are pictures, not controls:
 * the strip's label carries the summary, and the incident list below the
 * services carries the detail, so keyboard and screen-reader users lose
 * nothing the hover tooltip shows.
 */
export function UptimeBar({ days, uptimePct }: { days: DayUptime[]; uptimePct: number | null }) {
  const [active, setActive] = useState<{ index: number; left: number } | null>(null);
  const incidentDays = days.filter((day) => levelOf(day) === "minor" || levelOf(day) === "major").length;
  const activeDay = active ? days[active.index] : null;
  const activeLevel = activeDay ? levelOf(activeDay) : "none";

  const show = (index: number, element: HTMLElement) =>
    setActive({ index, left: element.offsetLeft + element.offsetWidth / 2 });

  return (
    <div {...stylex.props(styles.root)} onMouseLeave={() => setActive(null)}>
      <div
        role="img"
        aria-label={`${formatUptimePct(uptimePct)} uptime over the last ${days.length} days, ${
          incidentDays === 0 ? "with no incidents" : `with incidents on ${incidentDays} ${incidentDays === 1 ? "day" : "days"}`
        }`}
        {...stylex.props(styles.strip)}
      >
        {days.map((day, index) => (
          <div
            key={day.date}
            onMouseEnter={(event) => show(index, event.currentTarget)}
            {...stylex.props(
              styles.bar,
              fill[levelOf(day)],
              index < days.length - MOBILE_DAYS && styles.older,
            )}
          />
        ))}
      </div>
      {activeDay && active && (
        <div
          aria-hidden="true"
          {...stylex.props(surfaces.glassDark, styles.tooltip, styles.tooltipX(active.left))}
        >
          <p {...stylex.props(styles.tooltipDate)}>{formatDay(activeDay.date)}</p>
          <p {...stylex.props(styles.tooltipDetail, tooltipTone[activeLevel])}>
            {describeDay(activeDay, activeLevel)}
          </p>
        </div>
      )}
      <div {...stylex.props(styles.scale)} aria-hidden="true">
        <span>
          <span {...stylex.props(styles.wide)}>{days.length} days ago</span>
          <span {...stylex.props(styles.narrow)}>{MOBILE_DAYS} days ago</span>
        </span>
        <span {...stylex.props(styles.uptime)}>{formatUptimePct(uptimePct)} uptime</span>
        <span>Today</span>
      </div>
    </div>
  );
}
