/**
 * Day-level grouping and time-range formatting for the meetings archive.
 *
 * The archive groups rows by calendar day so the date is never implicit:
 * "Today" and "Yesterday" keep their familiar names, the rest of the last
 * seven days go by weekday, and anything older lands in "Earlier" where each
 * row carries its own date (the group header can't).
 */

export interface DayGroupable {
  startedAt: string | null;
}

export interface MeetingDayGroup<T extends DayGroupable> {
  key: string;
  /** "Today", "Yesterday", a weekday name, or "Earlier". */
  label: string;
  /** Concrete date ("Jul 10"), absent for "Earlier" which spans many days. */
  dateLabel?: string;
  /** True when rows must self-identify their date (the "Earlier" group). */
  showRowDate: boolean;
  rows: T[];
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "Jul 10", with the year appended only when it isn't the current one. */
export function formatDayLabel(date: Date, now = new Date()): string {
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

/**
 * Rows are assumed newest-first (the query orders by startedAt desc), so day
 * groups fall out in encounter order; "Earlier" collects everything older than
 * seven days plus rows with no start time, and always renders last.
 */
export function groupMeetingsByDay<T extends DayGroupable>(
  rows: T[],
  now = new Date(),
): MeetingDayGroup<T>[] {
  const todayStart = startOfDay(now);
  const dayMs = 86_400_000;
  const groups: MeetingDayGroup<T>[] = [];
  const byKey = new Map<string, MeetingDayGroup<T>>();

  const earlier: MeetingDayGroup<T> = {
    key: "earlier",
    label: "Earlier",
    showRowDate: true,
    rows: [],
  };

  for (const row of rows) {
    const started = row.startedAt ? new Date(row.startedAt) : null;
    if (!started || Number.isNaN(started.getTime())) {
      earlier.rows.push(row);
      continue;
    }
    const dayStart = startOfDay(started);
    const daysAgo = Math.round((todayStart - dayStart) / dayMs);
    if (daysAgo >= 7) {
      earlier.rows.push(row);
      continue;
    }
    const key = String(dayStart);
    let group = byKey.get(key);
    if (!group) {
      const label =
        daysAgo === 0
          ? "Today"
          : daysAgo === -1
            ? "Tomorrow"
          : daysAgo === 1
            ? "Yesterday"
            : started.toLocaleDateString([], { weekday: "long" });
      group = {
        key,
        label,
        dateLabel: formatDayLabel(started, now),
        showRowDate: false,
        rows: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.rows.push(row);
  }

  if (earlier.rows.length > 0) groups.push(earlier);
  return groups;
}
