import { useEffect, useRef, useState, type FormEvent } from "react";
import { Box, useValue, type Editor } from "tldraw";
import { ArrowUp, Lock, Sparkles, X } from "lucide-react";
import { audienceKey, privateAudience, type AssistantEntry, type AssistantRun } from "@orbmeet/whiteboard-core/assistant";
import { accent, ink, neutral, surface, violet } from "@orbmeet/ui/tokens/colors.stylex";
import { boardZIndex } from "@orbmeet/ui/tokens/layers.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { WHITEBOARD_PAGE_SHAPE_TYPE } from "@orbmeet/whiteboard-core/page-shape-schema";
import type { AssistantPromptOptions } from "./use-assistant";

const CARD_WIDTH = 320;
const GAP = 12;

const styles = stylex.create({
  anchor: { position: "absolute", zIndex: boardZIndex.action, pointerEvents: "auto" },
  at: (left: number, top: number) => ({ left, top }),
  /** The way in: small, beside the selection, never over it. */
  pill: {
    display: "inline-flex",
    height: 32,
    alignItems: "center",
    gap: space.s1_5,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: violet.v200,
    backgroundColor: { default: surface.raised, [env.hoverable]: { default: surface.raised, ":hover": violet.v50 } },
    paddingInline: space.s3,
    fontFamily: "inherit",
    fontSize: text.control,
    fontWeight: weight.semibold,
    color: violet.v700,
    boxShadow: shadows.float,
    cursor: "pointer",
  },
  card: {
    width: CARD_WIDTH,
    borderRadius: radii.card,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: violet.v200,
    backgroundColor: surface.raised,
    padding: space.s1_5,
    boxShadow: `0 0 0 4px color-mix(in oklab, ${violet.v500} 8%, transparent), ${shadows.float}`,
  },
  head: { display: "flex", alignItems: "center", gap: space.s2, paddingInline: space.s1_5, paddingBlock: space.s1_5 },
  title: { flexGrow: 1, fontSize: text.xs, fontWeight: weight.semibold, color: violet.v800 },
  close: {
    display: "grid",
    width: 28,
    height: 28,
    placeItems: "center",
    borderWidth: 0,
    borderRadius: radii.field,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
    color: neutral.n500,
    cursor: "pointer",
  },
  input: {
    width: "100%",
    height: 40,
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: violet.v100, ":focus-visible": violet.v300 },
    backgroundColor: violet.v50,
    paddingInline: space.s3,
    fontFamily: "inherit",
    // 16px under a finger: iOS zooms the page into a smaller focused field (see styles.css).
    fontSize: { default: text.sm, [env.touch]: text.base },
    color: neutral.n900,
    outlineStyle: "none",
  },
  row: { display: "flex", alignItems: "center", gap: space.s1_5, paddingTop: space.s2, paddingInline: 2 },
  chip: {
    height: 32,
    borderWidth: 0,
    borderRadius: radii.field,
    backgroundColor: { default: neutral.n100, [env.hoverable]: { default: neutral.n100, ":hover": neutral.n150 } },
    paddingInline: space.s2_5,
    fontFamily: "inherit",
    fontSize: text.xs,
    fontWeight: weight.semibold,
    color: neutral.n700,
    cursor: "pointer",
  },
  grow: { flexGrow: 1 },
  send: {
    display: "grid",
    width: 40,
    height: 32,
    placeItems: "center",
    borderWidth: 0,
    borderRadius: radii.field,
    backgroundColor: { default: violet.v700, ":disabled": neutral.n200 },
    color: ink.onDark,
    cursor: { default: "pointer", ":disabled": "default" },
  },
  privacy: { display: "flex", alignItems: "center", gap: space.s1, paddingInline: space.s1_5, paddingTop: space.s2, fontSize: text.xs2, color: ink.muted },
  error: { margin: 0, paddingInline: space.s1_5, paddingTop: space.s1_5, fontSize: text.xs, color: accent.a800 },
  /** Orb's answer, beside what it is about, for the asker alone. */
  note: {
    width: 260,
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: violet.v200,
    backgroundColor: violet.v50,
    paddingInline: space.s3,
    paddingBlock: space.s2_5,
    boxShadow: shadows.float,
  },
  noteHead: { display: "flex", alignItems: "center", gap: space.s1_5 },
  noteName: { fontSize: text.xs, fontWeight: weight.semibold, color: violet.v800 },
  noteBadge: {
    marginInlineStart: "auto",
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    height: 18,
    borderRadius: radii.field,
    backgroundColor: surface.raised,
    paddingInline: space.s1_5,
    fontSize: text.xs3,
    fontWeight: weight.semibold,
    color: neutral.n600,
  },
  noteText: { margin: 0, marginTop: space.s1_5, whiteSpace: "pre-wrap", fontSize: text.xs, lineHeight: leading.xs, color: violet.v950 },
  noteActions: { display: "flex", gap: space.s1_5, marginTop: space.s2 },
});

const QUICK_ASKS = [
  { label: "Explain", question: "Explain the selected part of the board." },
  { label: "Check my work", question: "Check the selected work step by step. Is it right? Say briefly where it goes wrong, if it does." },
] as const;

type Rect = { x: number; y: number; w: number; h: number };

/** Where a card of `width` goes beside `rect`, in the board's screen space: to its right, or else its left, or else under it. */
export function placeBeside(rect: Rect, width: number, viewport: { w: number; h: number }): { left: number; top: number } {
  const top = Math.max(GAP, Math.min(rect.y, viewport.h - 200));
  if (rect.x + rect.w + GAP + width <= viewport.w - GAP) return { left: rect.x + rect.w + GAP, top };
  if (rect.x - GAP - width >= GAP) return { left: rect.x - GAP - width, top };
  return { left: Math.max(GAP, Math.min(rect.x, viewport.w - width - GAP)), top: Math.min(rect.y + rect.h + GAP, viewport.h - 200) };
}

/**
 * Asking Orb about what is selected on the board — "Explain", "Check my
 * work", or a question of your own — privately: the question and the answer
 * are yours alone, and the answer appears beside what it is about, as a note
 * nobody else sees. It is in your own thread with Orb too, where it stays.
 *
 * A pencil lassos the working out and asks; a teacher checks a step while the
 * class watches the board, and the class sees none of it.
 */
export function SelectionAsk({
  editor,
  userId,
  live,
  entries,
  runs,
  prompt,
}: {
  editor: Editor;
  userId: string;
  /** Orb can take a question now. */
  live: boolean;
  entries: readonly AssistantEntry[];
  runs: readonly AssistantRun[];
  prompt: (text: string, options?: AssistantPromptOptions) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** The question in flight or answered: what it was about, and after which entry time its answer comes. */
  const [asked, setAsked] = useState<{ bounds: Rect; since: number; shapeIds: string[] } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selection = useValue(
    "selection-ask:selection",
    () => {
      // Asking is something you do to what you picked out. With a pen in
      // hand the selection is only left over from before, and the pill
      // blinked beside it with every stroke.
      if (!editor.isIn("select.idle")) return null;
      if (editor.getInstanceState().isChangingStyle) return null;
      // What is on a page, never the page itself.
      const ids = editor
        .getSelectedShapeIds()
        .filter((id) => editor.getShape(id)?.type !== WHITEBOARD_PAGE_SHAPE_TYPE);
      const all = ids.flatMap((id) => editor.getShapePageBounds(id) ?? []);
      if (all.length === 0) return null;
      const bounds = Box.Common(all);
      return { ids: ids.join(","), bounds: { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h } };
    },
    [editor],
  );
  const toScreen = (page: Rect): Rect => {
    const topLeft = editor.pageToViewport({ x: page.x, y: page.y });
    const bottomRight = editor.pageToViewport({ x: page.x + page.w, y: page.y + page.h });
    return { x: topLeft.x, y: topLeft.y, w: bottomRight.x - topLeft.x, h: bottomRight.y - topLeft.y };
  };
  // Re-placed as the camera moves.
  const viewport = useValue(
    "selection-ask:viewport",
    () => {
      const camera = editor.getCamera();
      const screen = editor.getViewportScreenBounds();
      return { w: screen.w, h: screen.h, camera: `${camera.x},${camera.y},${camera.z}` };
    },
    [editor],
  );

  // A new selection starts over; the answer to the last one stays until dismissed.
  const selectionKey = selection?.ids ?? null;
  useEffect(() => {
    setOpen(false);
    setError(null);
  }, [selectionKey]);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const mine = audienceKey(privateAudience([userId]));
  const working = runs.some((run) => audienceKey(run.audience) === mine);
  const answer = asked
    ? entries.find((entry) => entry.kind === "reply" && audienceKey(entry.audience) === mine && entry.at >= asked.since)
    : undefined;

  const ask = async (question: string) => {
    if (!selection || !question.trim()) return;
    setError(null);
    // The answer is the first of Orb's entries after everything here now: the
    // server stamps them, so this needs no clock of this browser's.
    const since = entries.reduce((newest, entry) => Math.max(newest, entry.at), 0) + 1;
    const result = await prompt(question.trim(), { audience: { kind: "private" } });
    if (result) {
      setError(result);
      return;
    }
    setAsked({ bounds: selection.bounds, since, shapeIds: selection.ids.split(",") });
    setDraft("");
    setOpen(false);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void ask(draft);
  };

  const nodes = [];
  if (selection && live && !(asked && selection.ids === asked.shapeIds.join(","))) {
    const rect = toScreen(selection.bounds);
    const width = open ? CARD_WIDTH : 120;
    const { left, top } = placeBeside(rect, width, viewport);
    nodes.push(
      <div key="ask" {...stylex.props(styles.anchor, styles.at(left, top))}>
        {open ? (
          <form aria-label="Ask Orb about the selection" onSubmit={submit} {...stylex.props(styles.card)}>
            <div {...stylex.props(styles.head)}>
              <Sparkles size={15} color="currentColor" aria-hidden="true" />
              <span {...stylex.props(styles.title)}>Ask about this selection</span>
              <button type="button" aria-label="Close" onClick={() => setOpen(false)} {...stylex.props(styles.close)}>
                <X size={14} />
              </button>
            </div>
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setOpen(false);
                event.stopPropagation();
              }}
              aria-label="Question for Orb"
              placeholder="What do you want to know?"
              maxLength={500}
              {...stylex.props(styles.input)}
            />
            <div {...stylex.props(styles.row)}>
              {QUICK_ASKS.map((quick) => (
                <button key={quick.label} type="button" onClick={() => void ask(quick.question)} disabled={working} {...stylex.props(styles.chip)}>
                  {quick.label}
                </button>
              ))}
              <span {...stylex.props(styles.grow)} />
              <button type="submit" aria-label="Ask" disabled={!draft.trim() || working} {...stylex.props(styles.send)}>
                <ArrowUp size={16} />
              </button>
            </div>
            <p {...stylex.props(styles.privacy)}>
              <Lock size={10} strokeWidth={2.5} aria-hidden="true" />
              Only you see the question and the answer.
            </p>
            {error && <p role="status" {...stylex.props(styles.error)}>{error}</p>}
          </form>
        ) : (
          <button type="button" onClick={() => setOpen(true)} {...stylex.props(styles.pill)}>
            <Sparkles size={14} aria-hidden="true" />
            Ask Orb
          </button>
        )}
      </div>,
    );
  }

  if (asked) {
    const rect = toScreen(asked.bounds);
    const { left, top } = placeBeside(rect, 260, viewport);
    nodes.push(
      <div key="note" {...stylex.props(styles.anchor, styles.at(left, top))}>
        <section aria-label="Orb's note, only you see this" aria-live="polite" {...stylex.props(styles.note)}>
          <div {...stylex.props(styles.noteHead)}>
            <Sparkles size={13} color="currentColor" aria-hidden="true" />
            <span {...stylex.props(styles.noteName)}>Orb</span>
            <span {...stylex.props(styles.noteBadge)}>
              <Lock size={9} strokeWidth={2.6} aria-hidden="true" />
              Only you
            </span>
          </div>
          <p {...stylex.props(styles.noteText)}>
            {answer && answer.kind === "reply" ? answer.text : working ? "Looking…" : "No answer came back. Try again."}
          </p>
          <div {...stylex.props(styles.noteActions)}>
            <button type="button" onClick={() => setAsked(null)} {...stylex.props(styles.chip)}>
              Dismiss
            </button>
          </div>
        </section>
      </div>,
    );
  }

  return <>{nodes}</>;
}
