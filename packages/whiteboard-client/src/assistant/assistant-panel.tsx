import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";
import { GripHorizontal, Send, Sparkles, Square, Trash2, X } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { danger, ink, neutral, surface, violet } from "@orbmeet/ui/tokens/colors.stylex";
import { boardZIndex } from "@orbmeet/ui/tokens/layers.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text } from "@orbmeet/ui/tokens/typography.stylex";
import { progress } from "@orbmeet/ui/styles/animations";
import type { AssistantEntry, AssistantRun } from "@orbmeet/whiteboard-core/assistant";

const styles = stylex.create({
  panel: {
    position: "absolute",
    zIndex: boardZIndex.panel,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    backgroundColor: surface.raised,
    color: neutral.n900,
    boxShadow: shadows.popover,
  },
  panelPhone: { left: 4, right: 4, top: 60, bottom: "calc(env(safe-area-inset-bottom, 0px) + 10rem)" },
  panelDesktop: { width: 400, height: 520, maxWidth: "calc(100% - 8px)", maxHeight: "calc(100% - 8px)" },
  panelDefaultPosition: { right: 16, top: 72 },
  panelPosition: (left: number, top: number) => ({ left, top }),

  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexShrink: 0,
    paddingInline: space.s3,
    paddingBlock: space.s2_5,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: neutral.n100,
  },
  headerDraggable: { cursor: { default: "grab", ":active": "grabbing" }, userSelect: "none" },
  headerRow: { display: "flex", alignItems: "center", gap: space.s1_5, minWidth: 0 },
  grip: { color: neutral.n400 },
  spark: { color: violet.v500, flexShrink: 0 },
  title: { fontSize: text.xs, lineHeight: leading.xs, fontWeight: 500 },
  working: {
    fontSize: text.xs2,
    lineHeight: leading.xs2,
    color: violet.v500,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  icon: {
    padding: space.s1,
    borderWidth: 0,
    borderRadius: radii.field,
    cursor: "pointer",
    color: { default: neutral.n400, [env.hoverable]: { default: neutral.n400, ":hover": neutral.n600 } },
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
  },

  log: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "0%",
    minHeight: 0,
    overflowX: "hidden",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
    paddingInline: space.s2_5,
    paddingBlock: space.s2,
  },
  empty: {
    margin: "auto",
    maxWidth: 240,
    textAlign: "center",
    fontSize: text.xs,
    lineHeight: leading.relaxed,
    color: neutral.n400,
  },

  promptRow: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: space.s0_5, paddingLeft: space.s6 },
  author: { fontSize: "11px", color: neutral.n400, paddingInline: space.s1 },
  replyRow: { display: "flex", paddingRight: space.s6 },
  bubble: {
    minWidth: 0,
    margin: 0,
    paddingInline: space.s3,
    paddingBlock: space.s1_5,
    borderRadius: radii.control,
    fontSize: "13px",
    lineHeight: leading.relaxed,
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    boxShadow: shadows.hairline,
  },
  prompt: { borderTopRightRadius: 2, backgroundColor: violet.v600, color: ink.onDark },
  reply: {
    borderTopLeftRadius: 2,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n100,
    backgroundColor: surface.raised,
    color: neutral.n800,
  },
  step: { display: "flex", alignItems: "center", gap: space.s1_5, fontSize: "11px", color: neutral.n400, paddingInline: space.s1_5 },
  stepDot: { width: 5, height: 5, borderRadius: radii.pill, flexShrink: 0, backgroundColor: violet.v400 },
  stepFailed: { backgroundColor: danger.d500 },
  notice: { fontSize: "11px", color: neutral.n500, paddingInline: space.s1_5, fontStyle: "italic" },

  composer: {
    flexShrink: 0,
    paddingInline: space.s2,
    paddingBlock: space.s1_5,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: neutral.n100,
  },
  composerRow: { display: "flex", alignItems: "flex-end", gap: space.s1_5 },
  draft: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "0%",
    resize: "none",
    maxHeight: 80,
    paddingInline: space.s2,
    paddingBlock: space.s1_5,
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: neutral.n200, ":focus": "transparent" },
    outlineStyle: "none",
    boxShadow: { default: "none", ":focus": `0 0 0 1px ${violet.v500}` },
    backgroundColor: surface.raised,
    color: neutral.n900,
    fontFamily: "inherit",
    // 16px under a finger: iOS zooms the page into a smaller focused field (see styles.css).
    fontSize: { default: text.xs, [env.touch]: text.base },
    lineHeight: leading.xs,
    "::placeholder": { color: neutral.n400 },
  },
  action: { flexShrink: 0, padding: space.s1_5, borderWidth: 0, borderRadius: radii.field, cursor: "pointer" },
  send: { backgroundColor: { default: violet.v600, [env.hoverable]: { default: violet.v600, ":hover": violet.v700 } }, color: ink.onDark },
  sendIdle: { backgroundColor: neutral.n100, color: neutral.n300, cursor: "default" },
  stop: { backgroundColor: "transparent", color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, ":hover": danger.d500 } } },
  error: { margin: 0, paddingTop: space.s1, fontSize: "11px", color: danger.d500 },
  footer: {
    flexShrink: 0,
    paddingInline: space.s3,
    paddingBlock: space.s2,
    textAlign: "center",
    fontSize: "11px",
    color: neutral.n400,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: neutral.n100,
  },
});

export interface AssistantPanelProps {
  entries: AssistantEntry[];
  run: AssistantRun | null;
  available: boolean;
  canPrompt: boolean;
  canCancel: boolean;
  canClear: boolean;
  /** Resolves to an error to show, or null once the request is accepted. */
  onPrompt(text: string): Promise<string | null>;
  onCancel(): void;
  onClear(): void;
  onClose(): void;
  isPhone?: boolean;
}

export function AssistantPanel({
  entries,
  run,
  available,
  canPrompt,
  canCancel,
  canClear,
  onPrompt,
  onCancel,
  onClear,
  onClose,
  isPhone = false,
}: AssistantPanelProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const { panelRef, position, handleHandlers, panelHandlers } = usePanelDrag(isPhone);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "end" });
  }, [entries]);

  useEffect(() => {
    const textarea = draftRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.max(32, Math.min(textarea.scrollHeight, 80))}px`;
  }, [draft]);

  const submit = useCallback(
    (event?: FormEvent) => {
      event?.preventDefault();
      const text = draft.trim();
      if (!text || !canPrompt || sending) return;
      setSending(true);
      setError(null);
      void onPrompt(text).then((failure) => {
        setSending(false);
        if (failure) setError(failure);
        // Clear only what was sent, never text typed while it was sending.
        else setDraft((current) => (current === draft ? "" : current));
      });
    },
    [canPrompt, draft, onPrompt, sending],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      submit();
    },
    [submit],
  );

  const ready = draft.trim().length > 0 && canPrompt && !sending;

  return (
    <div
      ref={panelRef}
      role="region"
      aria-label="Orb, the board assistant"
      {...stylex.props(
        styles.panel,
        isPhone ? styles.panelPhone : styles.panelDesktop,
        !isPhone && (position ? styles.panelPosition(position.x, position.y) : styles.panelDefaultPosition),
      )}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      {...panelHandlers}
    >
      <div {...stylex.props(styles.header, !isPhone && styles.headerDraggable)} {...handleHandlers}>
        <div {...stylex.props(styles.headerRow)}>
          {!isPhone && <GripHorizontal size={12} {...stylex.props(styles.grip)} />}
          <Sparkles size={12} {...stylex.props(styles.spark, run && progress.pulse)} />
          <span {...stylex.props(styles.title)}>Orb</span>
          {run && <span {...stylex.props(styles.working)}>working for {run.requesterName}…</span>}
        </div>
        <div {...stylex.props(styles.headerRow)} onPointerDown={(event) => event.stopPropagation()}>
          {canClear && (
            <button type="button" onClick={onClear} {...stylex.props(styles.icon)} aria-label="Clear conversation" title="Clear conversation">
              <Trash2 size={12} />
            </button>
          )}
          <button type="button" onClick={onClose} {...stylex.props(styles.icon)} aria-label="Close Orb">
            <X size={12} />
          </button>
        </div>
      </div>

      <div {...stylex.props(styles.log)} aria-live="polite">
        {entries.length === 0 && (
          <p {...stylex.props(styles.empty)}>
            Ask about this page, or ask me to draw on it. Everyone in the room sees the conversation.
          </p>
        )}
        {entries.map((entry) => (
          <EntryView key={entry.id} entry={entry} />
        ))}
        <div ref={logEndRef} />
      </div>

      {available ? (
        <form onSubmit={submit} {...stylex.props(styles.composer)}>
          <div {...stylex.props(styles.composerRow)}>
            <textarea
              ref={draftRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={run ? "Waiting for Orb…" : "Ask or ask it to draw…"}
              aria-label="Message to Orb"
              {...stylex.props(styles.draft)}
            />
            {run && canCancel ? (
              <button type="button" onClick={() => onCancel()} {...stylex.props(styles.action, styles.stop)} aria-label="Stop Orb" title="Stop">
                <Square size={12} />
              </button>
            ) : (
              <button type="submit" disabled={!ready} {...stylex.props(styles.action, ready ? styles.send : styles.sendIdle)} aria-label="Send">
                <Send size={12} />
              </button>
            )}
          </div>
          {error && <p {...stylex.props(styles.error)}>{error}</p>}
        </form>
      ) : (
        <div {...stylex.props(styles.footer)}>Orb is not set up on this server.</div>
      )}
    </div>
  );
}

function EntryView({ entry }: { entry: AssistantEntry }) {
  switch (entry.kind) {
    case "prompt":
      return (
        <div {...stylex.props(styles.promptRow)}>
          <span {...stylex.props(styles.author)}>{entry.author}</span>
          <p {...stylex.props(styles.bubble, styles.prompt)}>{entry.text}</p>
        </div>
      );
    case "reply":
      return (
        <div {...stylex.props(styles.replyRow)}>
          <p {...stylex.props(styles.bubble, styles.reply)}>{entry.text}</p>
        </div>
      );
    case "tool":
      return (
        <div {...stylex.props(styles.step)}>
          <span {...stylex.props(styles.stepDot, entry.status === "running" && progress.pulse, entry.status === "failed" && styles.stepFailed)} />
          <span>
            {entry.label}
            {entry.status === "failed" ? " — failed" : ""}
          </span>
        </div>
      );
    case "notice":
      return <div {...stylex.props(styles.notice)}>{entry.text}</div>;
  }
}

interface Point {
  x: number;
  y: number;
}

/** Keep `position` (the panel's top-left) inside its container. */
function clampPanelPosition(position: Point, panel: { width: number; height: number }, container: { width: number; height: number }, margin = 4): Point {
  return {
    x: Math.min(Math.max(position.x, margin), Math.max(margin, container.width - panel.width - margin)),
    y: Math.min(Math.max(position.y, margin), Math.max(margin, container.height - panel.height - margin)),
  };
}

/** Drag the panel by its header on desktop, and keep it on screen when the board resizes. */
function usePanelDrag(disabled: boolean) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Point | null>(null);
  const start = useRef<{ pointer: Point; panel: Point } | null>(null);

  const measure = useCallback(() => {
    const panel = panelRef.current;
    const container = panel?.parentElement;
    if (!panel || !container) return null;
    const panelRect = panel.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    return {
      at: { x: panelRect.left - containerRect.left, y: panelRect.top - containerRect.top },
      panel: { width: panelRect.width, height: panelRect.height },
      container: { width: containerRect.width, height: containerRect.height },
    };
  }, []);

  useEffect(() => {
    const container = panelRef.current?.parentElement;
    if (disabled || !container) return;
    const keepVisible = () =>
      setPosition((current) => {
        const box = measure();
        if (!current || !box) return current;
        const next = clampPanelPosition(current, box.panel, box.container);
        return next.x === current.x && next.y === current.y ? current : next;
      });
    const observer = new ResizeObserver(keepVisible);
    observer.observe(container);
    return () => observer.disconnect();
  }, [disabled, measure]);

  const end = useCallback(() => {
    start.current = null;
  }, []);

  return {
    panelRef,
    position,
    handleHandlers: disabled
      ? {}
      : {
          onPointerDown: (event: PointerEvent) => {
            const box = measure();
            if (!box) return;
            event.preventDefault();
            start.current = { pointer: { x: event.clientX, y: event.clientY }, panel: position ?? box.at };
            panelRef.current?.setPointerCapture(event.pointerId);
          },
        },
    panelHandlers: disabled
      ? {}
      : {
          onPointerMove: (event: PointerEvent) => {
            const box = measure();
            if (!start.current || !box) return;
            setPosition(
              clampPanelPosition(
                {
                  x: start.current.panel.x + event.clientX - start.current.pointer.x,
                  y: start.current.panel.y + event.clientY - start.current.pointer.y,
                },
                box.panel,
                box.container,
              ),
            );
          },
          onPointerUp: end,
          onPointerCancel: end,
          onLostPointerCapture: end,
        },
  };
}
