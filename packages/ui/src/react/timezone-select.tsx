import { Combobox } from "@base-ui/react/combobox";
import * as stylex from "@stylexjs/stylex";
import { Check, ChevronDown, Search } from "lucide-react";
import * as React from "react";

import { layout } from "../styles/atoms";
import { control, listbox } from "../styles/controls";
import { ink } from "../tokens/colors.stylex";
import { space } from "../tokens/space.stylex";
import { leading, text } from "../tokens/typography.stylex";

const styles = stylex.create({
  /** The trailing offset label on a row, and the check that follows it. */
  meta: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s2,
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: ink.muted,
  },
  /** The UTC offset beside the zone name. Real data, so it must be readable. */
  offset: { marginInlineStart: space.s2, color: ink.muted },
});

interface ZoneEntry {
  /** IANA identifier — the stored value. */
  value: string;
  /** Display form; `{ value, label }` is the shape Combobox labels items by. */
  label: string;
  offsetLabel: string;
  offsetMinutes: number;
  searchText: string;
}

function offsetFor(zone: string, at: Date): { label: string; minutes: number } {
  try {
    const label =
      new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
        .formatToParts(at)
        .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
    const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(label);
    const minutes = match
      ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0))
      : 0;
    return { label, minutes };
  } catch {
    return { label: "", minutes: 0 };
  }
}

function normalizeSearch(value: string): string {
  return value.replaceAll("_", " ").replaceAll("/", " ").trim().replace(/\s+/g, " ").toLowerCase();
}

function toEntry(zone: string, at: Date): ZoneEntry {
  const offset = offsetFor(zone, at);
  return {
    value: zone,
    label: zone.replaceAll("_", " "),
    offsetLabel: offset.label,
    offsetMinutes: offset.minutes,
    searchText: normalizeSearch(`${zone} ${offset.label}`),
  };
}

// Offsets shift with DST, but staleness within one page load is harmless —
// these only feed display labels and sort order, never the stored value. One
// shared snapshot keeps the picker's labels and sort order self-consistent.
let pageLoadNow: Date | null = null;

function nowOnce(): Date {
  return (pageLoadNow ??= new Date());
}

let zoneEntriesCache: ZoneEntry[] | null = null;

function buildZoneEntries(): ZoneEntry[] {
  if (zoneEntriesCache) return zoneEntriesCache;
  const now = nowOnce();
  const zones: string[] =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  // Intl enumerates geographic zones, but UTC is also a valid choice.
  zoneEntriesCache = [...new Set(["UTC", ...zones])]
    .map((zone) => toEntry(zone, now))
    .sort((a, b) => a.offsetMinutes - b.offsetMinutes || a.value.localeCompare(b.value));
  return zoneEntriesCache;
}

/**
 * Bring the selected row into view when the list appears.
 *
 * The list is sorted by GMT offset across ~420 zones, so the current one is
 * almost always far outside the 15rem window — opening the picker on the
 * International Date Line told you nothing about what you had set. Base UI has
 * no "reveal the selection" affordance, so this scrolls the container itself:
 * `scrollIntoView` would walk up and move whatever scrollable ancestor the
 * picker happens to sit in, which inside the scheduling dialog is the dialog.
 */
export function revealSelectedItem(list: HTMLElement | null) {
  const item = list?.querySelector<HTMLElement>('[data-selected],[aria-selected="true"]');
  if (!list || !item) return;
  const offsetWithinList =
    item.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
  // Centred rather than flush to the top: the neighbouring offsets are the
  // context that makes a zone list readable. Clamped rather than left to the
  // scroller, so the first few zones resolve to the top of the list here and
  // not only by grace of how the host handles a negative assignment.
  const centred = offsetWithinList - (list.clientHeight - item.offsetHeight) / 2;
  list.scrollTop = Math.max(0, centred);
}

interface TimeZoneSelectProps {
  label: string;
  value: string;
  onChange: (zone: string) => void;
}

/**
 * A searchable picker over every IANA time zone, shown with its current
 * GMT offset. The stored value is always a valid zone identifier.
 *
 * Built on Base UI's Combobox in its "input inside the popup" arrangement: the
 * list is portalled and collision-aware, so it survives being rendered inside a
 * dialog, and the listbox holds nothing but options.
 */
export function TimeZoneSelect({ label, value, onChange }: TimeZoneSelectProps) {
  const [open, setOpen] = React.useState(false);
  const listRef = React.useRef<HTMLDivElement | null>(null);

  // Building every zone means one Intl.DateTimeFormat per zone, so it waits
  // until the list is actually going to be shown.
  const selected = React.useMemo(() => toEntry(value, nowOnce()), [value]);
  const items = React.useMemo(() => {
    if (!open) return [];
    const entries = buildZoneEntries();
    // Saved aliases can be valid without appearing in this browser's list.
    if (!selected.offsetLabel || entries.some((entry) => entry.value === selected.value)) return entries;
    return [...entries, selected].sort((a, b) =>
      a.offsetMinutes - b.offsetMinutes || a.value.localeCompare(b.value)
    );
  }, [open, selected]);

  return (
    <Combobox.Root<ZoneEntry>
      items={items}
      value={selected}
      onValueChange={(entry) => {
        if (entry) onChange(entry.value);
      }}
      open={open}
      onOpenChange={setOpen}
      // After the open animation, so the list has its final height to centre in.
      onOpenChangeComplete={(isOpen) => {
        if (isOpen) revealSelectedItem(listRef.current);
      }}
      isItemEqualToValue={(a, b) => a.value === b.value}
      filter={(entry, query) => {
        const q = normalizeSearch(query);
        return q === "" || entry.searchText.includes(q);
      }}
    >
      <Combobox.Label {...stylex.props(control.label)}>{label}</Combobox.Label>
      <Combobox.Trigger {...stylex.props(control.trigger)}>
        <Combobox.Value>
          {(entry: ZoneEntry | null) => (
            <span {...stylex.props(layout.truncate)}>
              {entry?.label}
              {entry?.offsetLabel && (
                <span {...stylex.props(styles.offset)}>{entry.offsetLabel}</span>
              )}
            </span>
          )}
        </Combobox.Value>
        <Combobox.Icon {...stylex.props(control.triggerIcon, control.triggerIconFlips)}>
          <ChevronDown size={16} />
        </Combobox.Icon>
      </Combobox.Trigger>

      <Combobox.Portal>
        <Combobox.Positioner
          align="start"
          sideOffset={4}
          collisionPadding={12}
          {...stylex.props(listbox.positioner)}
        >
          <Combobox.Popup {...stylex.props(listbox.popup, listbox.matchAnchorWidth)}>
            <div {...stylex.props(listbox.searchRow)}>
              <Search size={14} {...stylex.props(listbox.searchIcon)} />
              <Combobox.Input
                placeholder="Search city or offset…"
                aria-label="Search time zones"
                {...stylex.props(listbox.searchInput)}
              />
            </div>
            <Combobox.Empty {...stylex.props(listbox.empty)}>
              No time zone matches that search.
            </Combobox.Empty>
            <Combobox.List ref={listRef} {...stylex.props(listbox.list, listbox.listCapped)}>
              {(entry: ZoneEntry) => (
                <Combobox.Item
                  key={entry.value}
                  value={entry}
                  {...stylex.props(listbox.itemSplit)}
                >
                  <span {...stylex.props(layout.truncate)}>{entry.label}</span>
                  <span {...stylex.props(styles.meta)}>
                    {entry.offsetLabel}
                    <Combobox.ItemIndicator>
                      <Check size={14} />
                    </Combobox.ItemIndicator>
                  </span>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
