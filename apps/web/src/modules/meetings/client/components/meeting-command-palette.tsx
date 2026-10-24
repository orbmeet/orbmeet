import * as React from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { CornerDownLeft, Search } from "lucide-react";
import { useCommittedRef } from "@orbmeet/ui/react";
import { layout } from "@orbmeet/ui/styles/atoms";
import { accent, danger, ink, neutral, surface, violet } from "@orbmeet/ui/tokens/colors.stylex";
import { zIndex } from "@orbmeet/ui/tokens/layers.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { duration, easing } from "@orbmeet/ui/tokens/motion.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { ORB_NAME } from "@/modules/meetings/client/orb";
import { OrbMark } from "./timeline-orb";
import {
  buildMeetingCommands,
  matchMeetingCommands,
  MEETING_COMMAND_GROUPS,
  type MeetingCommand,
  type MeetingCommandInput,
} from "@/modules/meetings/client/meeting-commands";

const STARTING = ":is([data-starting-style])";
const ENDING = ":is([data-ending-style])";

const styles = stylex.create({
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: zIndex.modal,
    backgroundColor: `color-mix(in oklab, ${neutral.n900} 18%, transparent)`,
    opacity: { default: 1, [STARTING]: 0, [ENDING]: 0 },
    transitionProperty: "opacity",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
  },
  /**
   * High on the screen rather than centred: the palette is read top-down as
   * you type, and anchored high it never jumps as the list under the input
   * grows and shrinks.
   */
  popup: {
    position: "fixed",
    top: "max(12vh, 4.5rem)",
    left: "50%",
    zIndex: zIndex.modal,
    display: "flex",
    width: "min(36rem, calc(100vw - 2rem))",
    maxHeight: "min(30rem, 76vh)",
    flexDirection: "column",
    overflow: "hidden",
    borderRadius: radii.panel,
    backgroundColor: surface.raised,
    boxShadow: `0 0 0 1px ${neutral.n150}, ${shadows.elevated}`,
    outlineStyle: "none",
    translate: "-50% 0",
    opacity: { default: 1, [STARTING]: 0, [ENDING]: 0 },
    scale: { default: 1, [STARTING]: 0.98, [ENDING]: 0.98 },
    transitionProperty: "opacity, scale",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.gentle,
  },
  inputRow: {
    display: "flex",
    flexShrink: 0,
    height: 52,
    alignItems: "center",
    gap: space.s3,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: neutral.n100,
    paddingInline: space.s4,
    color: neutral.n400,
  },
  input: {
    minWidth: 0,
    flexGrow: 1,
    height: "100%",
    borderWidth: 0,
    backgroundColor: "transparent",
    fontFamily: "inherit",
    fontSize: text.base,
    color: ink.strong,
    outlineStyle: "none",
    "::placeholder": { color: neutral.n400 },
  },
  list: {
    minHeight: 0,
    flexGrow: 1,
    overflowY: "auto",
    overscrollBehavior: "contain",
    padding: space.s1_5,
  },
  heading: {
    margin: 0,
    paddingInline: space.s2_5,
    paddingTop: space.s2_5,
    paddingBottom: space.s1,
    fontSize: text.xs2,
    fontWeight: weight.semibold,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    color: neutral.n400,
  },
  option: {
    display: "flex",
    minHeight: 40,
    alignItems: "center",
    gap: space.s3,
    borderRadius: radii.control,
    paddingInline: space.s2_5,
    paddingBlock: space.s1_5,
    fontSize: text.sm,
    color: neutral.n800,
    cursor: "pointer",
    userSelect: "none",
  },
  optionActive: { backgroundColor: neutral.n100 },
  optionDisabled: { cursor: "not-allowed", opacity: 0.45 },
  optionDanger: { color: danger.d600 },
  optionIcon: { flexShrink: 0, color: neutral.n400 },
  optionIconActive: { color: accent.a600 },
  optionIconDanger: { color: danger.d500 },
  optionText: { display: "flex", minWidth: 0, flexGrow: 1, flexDirection: "column" },
  optionHint: { fontSize: text.xs, lineHeight: leading.xs, color: neutral.n500 },
  optionOrb: { color: violet.v800, fontWeight: weight.medium },
  optionGroup: { flexShrink: 0, fontSize: text.xs, color: neutral.n400 },
  kbd: {
    display: "inline-flex",
    height: 20,
    minWidth: 20,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 5,
    paddingInline: 5,
    fontVariantNumeric: "tabular-nums",
    fontSize: text.xs3,
    color: neutral.n500,
    backgroundColor: neutral.n50,
    boxShadow: `inset 0 0 0 1px ${neutral.n200}`,
  },
  empty: {
    margin: 0,
    paddingInline: space.s4,
    paddingBlock: space.s8,
    textAlign: "center",
    fontSize: text.sm,
    color: neutral.n500,
  },
  footer: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s4,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: neutral.n100,
    backgroundColor: neutral.n50,
    paddingInline: space.s4,
    paddingBlock: space.s2,
    fontSize: text.xs,
    color: neutral.n500,
  },
  footerItem: { display: "inline-flex", alignItems: "center", gap: space.s1_5 },
});

/** Every row the list shows: a command, or the free-text question for Orb at the end. */
type PaletteRow =
  | { kind: "command"; command: MeetingCommand }
  | { kind: "ask-orb"; query: string };

/** The first row Enter would actually run — never a disabled one when another will do. */
function firstRunnable(rows: readonly PaletteRow[]): number {
  const index = rows.findIndex((row) => row.kind !== "command" || !row.command.disabled);
  return index === -1 ? 0 : index;
}

function rowId(listId: string, index: number) {
  return `${listId}-option-${index}`;
}

export interface MeetingCommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: MeetingCommandInput;
  /** Asks Orb in the room. Omit while Orb is away. */
  onAskOrb?: (question: string) => void;
}

/**
 * The room's command palette: ⌘K (Ctrl+K) from anywhere in a meeting.
 *
 * Every control in the top bar is a command here, plus the ones that live
 * deeper — following the presenter, locking the meeting, closing the board
 * for everyone. Text that matches nothing can still go to Orb, as a question
 * in the room.
 */
export function MeetingCommandPalette({ open, onOpenChange, commands, onAskOrb }: MeetingCommandPaletteProps) {
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listId = React.useId();

  const allCommands = React.useMemo(() => buildMeetingCommands(commands), [commands]);
  const matched = React.useMemo(() => matchMeetingCommands(allCommands, query), [allCommands, query]);
  const trimmed = query.trim();
  const rows = React.useMemo<PaletteRow[]>(() => {
    const list: PaletteRow[] = matched.map((command) => ({ kind: "command", command }));
    if (onAskOrb && trimmed) list.push({ kind: "ask-orb", query: trimmed });
    return list;
  }, [matched, onAskOrb, trimmed]);
  const grouped = trimmed === "";

  // A fresh palette every time it opens: an old query and a stale highlight
  // are the wrong starting point for whatever you opened it to do now.
  React.useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  // A new query starts on its best runnable match. Keyed on the query, not on
  // the rows: the room re-renders constantly (a clock, someone speaking), and
  // each render rebuilds the commands — the highlight must not jump back to
  // the top while someone is arrowing down the list.
  const rowsRef = useCommittedRef(rows);
  React.useEffect(() => {
    setActiveIndex(firstRunnable(rowsRef.current));
  }, [query, open, rowsRef]);
  // The list can shrink under the highlight (a command disappearing as the
  // room changes); clamp rather than point past the end.
  const active = Math.min(activeIndex, Math.max(0, rows.length - 1));

  React.useEffect(() => {
    const option = listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(rowId(listId, active))}`);
    option?.scrollIntoView({ block: "nearest" });
  }, [active, listId]);

  const runRow = (row: PaletteRow | undefined) => {
    if (!row) return;
    if (row.kind === "command" && row.command.disabled) return;
    // Close first, so focus is handed back before the command runs — a command
    // that opens a popover or a panel then takes focus from a settled page.
    onOpenChange(false);
    if (row.kind === "command") row.command.run();
    else onAskOrb?.(row.query);
  };

  const moveActive = (delta: number) => {
    if (rows.length === 0) return;
    setActiveIndex((index) => (Math.min(index, rows.length - 1) + delta + rows.length) % rows.length);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveActive(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveActive(-1);
        break;
      case "Home":
        if (!query) {
          event.preventDefault();
          setActiveIndex(0);
        }
        break;
      case "End":
        if (!query) {
          event.preventDefault();
          setActiveIndex(Math.max(0, rows.length - 1));
        }
        break;
      case "Enter":
        event.preventDefault();
        runRow(rows[active]);
        break;
    }
  };

  const renderRow = (row: PaletteRow, index: number) => {
    const isActive = index === active;
    const command = row.kind === "command" ? row.command : null;
    const disabled = command?.disabled === true;
    const dangerous = command?.danger === true;
    return (
      // Keyboard is handled on the combobox input, which owns focus and points
      // at this row through aria-activedescendant (the ARIA combobox pattern);
      // a key handler here would never fire.
      // oxlint-disable-next-line jsx-a11y/click-events-have-key-events
      <div
        key={command ? command.id : row.kind}
        id={rowId(listId, index)}
        role="option"
        tabIndex={-1}
        aria-selected={isActive}
        aria-disabled={disabled || undefined}
        onPointerMove={() => {
          if (!isActive) setActiveIndex(index);
        }}
        onClick={() => runRow(row)}
        {...stylex.props(
          styles.option,
          isActive && styles.optionActive,
          dangerous && styles.optionDanger,
          disabled && styles.optionDisabled,
        )}
      >
        {command ? (
          <command.icon
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
            {...stylex.props(
              styles.optionIcon,
              isActive && !dangerous && styles.optionIconActive,
              dangerous && styles.optionIconDanger,
            )}
          />
        ) : (
          <OrbMark sizePx={18} />
        )}
        <span {...stylex.props(styles.optionText)}>
          <span {...stylex.props(layout.truncate, !command && styles.optionOrb)}>
            {row.kind === "command" ? row.command.label : `Ask ${ORB_NAME} “${row.query}”`}
          </span>
          {command?.hint && <span {...stylex.props(styles.optionHint, layout.truncate)}>{command.hint}</span>}
          {!command && <span {...stylex.props(styles.optionHint, layout.truncate)}>In the Room · everyone sees the answer</span>}
        </span>
        {!grouped && command && <span {...stylex.props(styles.optionGroup)}>{command.group}</span>}
        {command?.shortcut && <kbd {...stylex.props(styles.kbd)}>{command.shortcut}</kbd>}
        {isActive && !command?.shortcut && !disabled && (
          <CornerDownLeft size={14} aria-hidden="true" {...stylex.props(styles.optionIcon)} />
        )}
      </div>
    );
  };

  const renderRows = () => {
    if (!grouped) return rows.map(renderRow);
    let index = 0;
    return MEETING_COMMAND_GROUPS.map((group) => {
      const inGroup = rows.filter((row) => row.kind === "command" && row.command.group === group);
      if (inGroup.length === 0) return null;
      const headingId = `${listId}-group-${group}`;
      return (
        <div key={group} role="group" aria-labelledby={headingId}>
          <p id={headingId} {...stylex.props(styles.heading)}>
            {group}
          </p>
          {inGroup.map((row) => renderRow(row, index++))}
        </div>
      );
    });
  };

  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop {...stylex.props(styles.backdrop)} />
        <BaseDialog.Popup initialFocus={inputRef} aria-label="Command palette" {...stylex.props(styles.popup)}>
          <BaseDialog.Title {...stylex.props(layout.srOnly)}>Command palette</BaseDialog.Title>
          <div {...stylex.props(styles.inputRow)}>
            <Search size={18} strokeWidth={1.75} aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={rows.length > 0 ? rowId(listId, active) : undefined}
              aria-label="Type a command or search"
              placeholder={onAskOrb ? `Type a command or ask ${ORB_NAME}…` : "Type a command…"}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleKeyDown}
              autoComplete="off"
              spellCheck={false}
              {...stylex.props(styles.input)}
            />
          </div>
          <div ref={listRef} id={listId} role="listbox" aria-label="Commands" {...stylex.props(styles.list)}>
            {rows.length === 0 ? (
              <p {...stylex.props(styles.empty)}>No commands match “{trimmed}”.</p>
            ) : (
              renderRows()
            )}
          </div>
          <div aria-hidden="true" {...stylex.props(styles.footer)}>
            <span {...stylex.props(styles.footerItem)}>
              <kbd {...stylex.props(styles.kbd)}>↑</kbd>
              <kbd {...stylex.props(styles.kbd)}>↓</kbd>
              move
            </span>
            <span {...stylex.props(styles.footerItem)}>
              <kbd {...stylex.props(styles.kbd)}>↵</kbd>
              run
            </span>
            <span {...stylex.props(styles.footerItem)}>
              <kbd {...stylex.props(styles.kbd)}>esc</kbd>
              close
            </span>
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
