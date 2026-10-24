import { Check, Square, X } from "lucide-react";
import { BrandMark, Tooltip } from "@orbmeet/ui/react";
import { enter } from "@orbmeet/ui/styles/animations";
import { focus, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { danger, ink, neutral, surface, violet } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import type { AssistantRun } from "@orbmeet/whiteboard-core/assistant";
import { ORB_NAME } from "@/modules/meetings/client/orb";
import type { TimelineItem } from "@/modules/meetings/client/timeline-model";

const styles = stylex.create({
  entry: { display: "grid", gridTemplateColumns: "24px minmax(0, 1fr)", columnGap: space.s2_5 },
  head: { display: "flex", minWidth: 0, alignItems: "baseline", gap: space.s1_5 },
  name: { fontSize: text.xs, fontWeight: weight.semibold, color: violet.v700 },
  time: { flexShrink: 0, fontSize: text.xs3, fontVariantNumeric: "tabular-nums", color: neutral.n400 },
  label: { minWidth: 0, fontSize: text.xs2, color: ink.muted },
  stepActions: { display: "flex", flexBasis: "100%", gap: space.s1_5, marginTop: space.s1 },
  actionQuiet: { borderColor: "transparent", backgroundColor: "transparent", color: neutral.n600 },
  replyText: { margin: 0 },
  actions: { display: "flex", gap: space.s1_5, marginTop: space.s2 },
  action: {
    height: 28,
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n150,
    backgroundColor: { default: surface.raised, [env.hoverable]: { default: surface.raised, ":hover": neutral.n50 } },
    paddingInline: space.s2_5,
    fontFamily: "inherit",
    fontSize: text.xs,
    fontWeight: weight.semibold,
    color: neutral.n800,
    cursor: "pointer",
  },
  reply: {
    margin: 0,
    marginTop: space.s1,
    overflowWrap: "anywhere",
    whiteSpace: "pre-wrap",
    borderRadius: radii.control,
    borderStartStartRadius: 5,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: violet.v100,
    backgroundColor: `color-mix(in oklab, ${violet.v50} 70%, ${surface.raised})`,
    paddingInline: space.s3,
    paddingBlock: space.s2,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: neutral.n900,
  },
  /** What Orb was shown with the question: quiet, under the answer it stood on. */
  lookedAt: {
    margin: 0,
    marginTop: space.s1,
    fontSize: text.xs2,
    lineHeight: leading.xs,
    color: ink.muted,
  },
  /** Words still arriving. */
  caret: {
    display: "inline-block",
    width: 2,
    height: "1em",
    marginInlineStart: 2,
    verticalAlign: "-0.15em",
    borderRadius: 1,
    backgroundColor: violet.v500,
  },

  steps: {
    margin: 0,
    marginTop: space.s0_5,
    padding: 0,
    listStyle: "none",
    display: "flex",
    flexWrap: "wrap",
    gap: space.s1,
  },
  step: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    height: 22,
    borderRadius: radii.pill,
    backgroundColor: neutral.n100,
    paddingInline: space.s2,
    fontSize: text.xs2,
    fontWeight: weight.medium,
    color: ink.muted,
  },
  stepRunning: { backgroundColor: violet.v50, color: violet.v700 },
  stepFailed: { backgroundColor: danger.d50, color: danger.d700 },
  stepDot: { width: 6, height: 6, borderRadius: radii.pill, backgroundColor: violet.v500 },

  notice: {
    margin: 0,
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: ink.muted,
  },

  /** While Orb answers: who asked, and a way to stop it for whoever may. */
  runBar: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: violet.v100,
    backgroundColor: `color-mix(in oklab, ${violet.v50} 60%, ${surface.raised})`,
    paddingInline: space.s4,
    paddingBlock: space.s2,
  },
  runLabel: { minWidth: 0, flexGrow: 1, fontSize: text.xs, fontWeight: weight.medium, color: violet.v800 },
  stop: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    height: 26,
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: violet.v200,
    backgroundColor: { default: surface.raised, [env.hoverable]: { default: surface.raised, ":hover": violet.v50 } },
    paddingInline: space.s2,
    fontSize: text.xs,
    fontWeight: weight.semibold,
    color: violet.v800,
    cursor: "pointer",
  },
});

/**
 * Orb's face is the product's mark: the same two violets as the logo. While
 * Orb works the light circles the sphere; a still mark always means "done".
 */
export function OrbMark({ sizePx = 24, working = false }: { sizePx?: number; working?: boolean }) {
  return <BrandMark size={sizePx} state={working ? "thinking" : "rest"} />;
}

function clockTime(at: number) {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

type OrbItem = Extract<TimelineItem, { kind: "orb-reply" | "orb-steps" | "orb-notice" }>;

/**
 * Orb's side of the conversation: an answer, what it did on the board, or a
 * notice. `label` says whom an answer is for — "replying to Sam", "just you
 * two" — and `onShare` puts an answer seen in private to the room.
 */
export function OrbEntry({
  item,
  working,
  label,
  onShare,
  onShow,
  onUndo,
}: {
  item: OrbItem;
  working: boolean;
  label?: string;
  onShare?: () => void;
  /** Brings what Orb drew into view on the board. */
  onShow?: () => void;
  /** Takes back what Orb drew: for whoever asked, once. */
  onUndo?: () => void;
}) {
  if (item.kind === "orb-notice") {
    return (
      <p {...stylex.props(styles.notice, enter.fade)}>
        {ORB_NAME}: {item.text}
      </p>
    );
  }
  return (
    <article aria-label={`${ORB_NAME} said`} {...stylex.props(styles.entry, enter.fade)}>
      <OrbMark working={working} />
      <div>
        <div {...stylex.props(styles.head)}>
          <span {...stylex.props(styles.name)}>{ORB_NAME}</span>
          {label && <span {...stylex.props(styles.label)}>{label}</span>}
          <time dateTime={new Date(item.at).toISOString()} {...stylex.props(styles.time)}>
            {clockTime(item.at)}
          </time>
        </div>
        {item.kind === "orb-reply" ? (
          <>
            <div {...stylex.props(styles.reply)}>
              <p {...stylex.props(styles.replyText)}>
                {item.text}
                {!item.done && <span aria-hidden="true" {...stylex.props(styles.caret)} />}
              </p>
              {onShare && (
                <div {...stylex.props(styles.actions)}>
                  <button
                    type="button"
                    onClick={onShare}
                    {...stylex.props(pressable.base, motion.tint, focus.ring, styles.action)}
                  >
                    Share with room
                  </button>
                </div>
              )}
            </div>
            {item.done && item.lookedAt && <p {...stylex.props(styles.lookedAt)}>{item.lookedAt}</p>}
          </>
        ) : (
          <ul aria-label="On the board" {...stylex.props(styles.steps)}>
            {item.steps.map((step) => (
              <li
                key={step.id}
                {...stylex.props(
                  styles.step,
                  step.status === "running" && styles.stepRunning,
                  step.status === "failed" && styles.stepFailed,
                )}
              >
                {step.status === "running" ? (
                  <span aria-hidden="true" {...stylex.props(styles.stepDot)} />
                ) : step.status === "done" ? (
                  <Check size={11} strokeWidth={2.5} aria-hidden="true" />
                ) : (
                  <X size={11} strokeWidth={2.5} aria-hidden="true" />
                )}
                {step.label}
              </li>
            ))}
            {(onShow || onUndo) && (
              <li {...stylex.props(styles.stepActions)}>
                {onShow && (
                  <button
                    type="button"
                    onClick={onShow}
                    {...stylex.props(pressable.base, motion.tint, focus.ring, styles.action)}
                  >
                    Show on board
                  </button>
                )}
                {onUndo && (
                  <button
                    type="button"
                    onClick={onUndo}
                    {...stylex.props(pressable.base, motion.tint, focus.ring, styles.action, styles.actionQuiet)}
                  >
                    Undo
                  </button>
                )}
              </li>
            )}
          </ul>
        )}
      </div>
    </article>
  );
}

export function OrbRunBar({
  run,
  currentUserId,
  canCancel,
  onCancel,
}: {
  run: AssistantRun;
  currentUserId: string;
  canCancel: boolean;
  onCancel: () => void;
}) {
  const asker = run.requesterUserId === currentUserId ? "you" : run.requesterName;
  return (
    <div role="status" {...stylex.props(styles.runBar)}>
      <OrbMark sizePx={18} working />
      <span {...stylex.props(styles.runLabel)}>
        {ORB_NAME} is answering {asker}…
      </span>
      {canCancel && (
        <Tooltip content={`Stop ${ORB_NAME}`} side="top">
          <button
            type="button"
            onClick={onCancel}
            {...stylex.props(pressable.base, motion.tint, focus.ring, styles.stop)}
          >
            <Square size={10} strokeWidth={2.5} fill="currentColor" aria-hidden="true" />
            Stop
          </button>
        </Tooltip>
      )}
    </div>
  );
}
