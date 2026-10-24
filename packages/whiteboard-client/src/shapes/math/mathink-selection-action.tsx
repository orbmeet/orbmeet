import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Loader2, Sigma, SquareSigma, Trash2 } from "lucide-react";
import { useEditor, useValue } from "tldraw";
import { danger, neutral, surface, violet, warning } from "@orbmeet/ui/tokens/colors.stylex";
import { boardZIndex } from "@orbmeet/ui/tokens/layers.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { duration, easing } from "@orbmeet/ui/tokens/motion.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, leading, text, tracking, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { progress } from "@orbmeet/ui/styles/animations";
import * as stylex from "@stylexjs/stylex";
import { boardAction, boardActionRow } from "../../styles/board";

import {
  canRecognizeSelectedInk,
  collectSelectedMathInk,
  isMathInkSelectionCurrent,
  mathInkInputFromLatex,
  placeMathInkRecognition,
  recognizeMathInk,
  repairIncompleteMathInkLatex,
  type MathInkRecognition,
  type MathInkSelection,
} from "./mathink";
import { getKatexError, renderKatex } from "./katex-renderer";
import { getPromotableEquation, promoteToMathShape } from "./math-text-shapes";
import { useWhiteboardToast } from "../../chrome/use-whiteboard-toast";
import { WhiteboardModal } from "../../chrome/whiteboard-modal";
import { useWhiteboardToolbarContext } from "../../toolbar/whiteboard-toolbar-context";

const styles = stylex.create({
  /** The action bar anchored to a selection. */
  bar: {
    position: "absolute",
    zIndex: boardZIndex.selection,
    pointerEvents: "auto",
    display: "flex",
    alignItems: "center",
    gap: space.s1,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    backgroundColor: surface.raised,
    padding: space.s1,
    boxShadow: shadows.card,
  },
  barPosition: (left: number, top: number) => ({
    left,
    top,
    transform: "translateY(-100%)",
  }),
  /** MathInk: the AI action, on the violet the AI surfaces own. */
  recognize: {
    display: "flex",
    height: space.s9,
    alignItems: "center",
    gap: space.s1_5,
    borderRadius: radii.pill,
    borderWidth: 0,
    paddingInline: space.s3,
    fontFamily: "inherit",
    fontSize: text.xs,
    lineHeight: leading.xs,
    fontWeight: weight.semibold,
    color: violet.v700,
    backgroundColor: { default: violet.v50, [env.hoverable]: { default: violet.v50, ":hover": violet.v100 } },
    cursor: { default: "pointer", ":disabled": "wait" },
    opacity: { default: 1, ":disabled": 0.7 },
    transitionProperty: "background-color, opacity",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
  /** Promoting a lone equation: a quiet ghost beside the destructive action. */
  promote: {
    display: "flex",
    height: space.s9,
    alignItems: "center",
    gap: space.s1_5,
    borderRadius: radii.pill,
    borderWidth: 0,
    paddingInline: space.s3,
    fontFamily: "inherit",
    fontSize: text.xs,
    lineHeight: leading.xs,
    fontWeight: weight.semibold,
    color: neutral.n700,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
    cursor: "pointer",
    transitionProperty: "background-color",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
  /** Deleting the selection — destructive, so it only ever tints. */
  deleteSelection: {
    display: "flex",
    height: space.s9,
    width: space.s9,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.pill,
    borderWidth: 0,
    padding: 0,
    color: danger.d500,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": danger.d50 } },
    cursor: "pointer",
    transitionProperty: "color, background-color",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },

  /** The dialog is wide: it holds a rendered expression and a LaTeX draft. */
  wide: { width: "100%", maxWidth: "32rem" },
  /** The rendered expression, on the AI's own ground. */
  preview: {
    marginTop: space.s4,
    display: "flex",
    minHeight: "7rem",
    alignItems: "center",
    justifyContent: "center",
    overflowX: "auto",
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: violet.v100,
    backgroundColor: `color-mix(in oklab, ${violet.v50} 60%, transparent)`,
    paddingInline: space.s4,
    paddingBlock: space.s6,
    color: neutral.n900,
  },
  previewError: { fontSize: text.sm, lineHeight: leading.sm, color: danger.d700 },
  fieldLabel: {
    marginTop: space.s4,
    display: "block",
    fontSize: text.xs,
    lineHeight: leading.xs,
    fontWeight: weight.semibold,
    textTransform: "uppercase",
    letterSpacing: tracking.wide,
    color: neutral.n500,
  },
  draft: {
    marginTop: space.s1_5,
    display: "block",
    width: "100%",
    resize: "vertical",
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: neutral.n300, ":focus": violet.v400 },
    backgroundColor: surface.raised,
    paddingInline: space.s3,
    paddingBlock: space.s2,
    fontFamily: fonts.mono,
    // 16px under a finger: iOS zooms the page into a smaller focused field (see styles.css).
    fontSize: { default: text.sm, [env.touch]: text.base },
    lineHeight: leading.sm,
    letterSpacing: tracking.normal,
    color: neutral.n900,
    outlineWidth: 0,
    boxShadow: { default: "none", ":focus": `0 0 0 2px ${violet.v100}` },
  },
  draftError: { marginTop: space.s1, minHeight: "1.25rem", fontSize: text.xs, lineHeight: leading.xs, color: danger.d600 },
  repairNote: { marginBottom: space.s1, fontSize: text.xs, lineHeight: leading.xs, color: warning.w700 },
  meta: { fontSize: text.xs, lineHeight: leading.xs, color: neutral.n400 },
  /** Copy LaTeX: the violet ghost of the action row. */
  copyLatex: {
    color: violet.v700,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": violet.v50 } },
  },
});

const RECOGNITION_TIMEOUT_MS = 35_000;

interface MathInkPreviewState {
  selection: MathInkSelection;
  recognition: MathInkRecognition;
  repairedTrailingGroups: boolean;
}

interface ActiveRecognitionRequest {
  controller: AbortController;
  timeout: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "MathInk could not recognize that selection.";
}

export function WhiteboardSelectionActions() {
  const editor = useEditor();
  const addToast = useWhiteboardToast();
  const { whiteboardToken } = useWhiteboardToolbarContext();
  const selectedShapeIds = useValue(
    "selected shape ids",
    () => editor.getSelectedShapeIds(),
    [editor],
  );
  const canRecognize = useValue(
    "selected ink can be recognized",
    () => canRecognizeSelectedInk(editor),
    [editor],
  );
  const promotableTextId = useValue(
    "selected text is one equation",
    () => {
      const shape = editor.getOnlySelectedShape();
      return shape && !editor.getIsReadonly() && getPromotableEquation(editor, shape) ? shape.id : null;
    },
    [editor],
  );
  const anchor = useValue(
    "selection action anchor",
    () => {
      if (editor.getSelectedShapeIds().length === 0) return null;
      const bounds = editor.getSelectionPageBounds();
      if (!bounds) return null;
      return editor.pageToViewport({ x: bounds.maxX, y: bounds.minY });
    },
    [editor],
  );
  const isIdle = useValue(
    "select tool idle",
    () => editor.isIn("select.idle"),
    [editor],
  );

  const activeRequestRef = useRef<ActiveRecognitionRequest | null>(null);
  const [isRecognizing, setIsRecognizing] = useState(false);
  const [preview, setPreview] = useState<MathInkPreviewState | null>(null);
  const [draftLatex, setDraftLatex] = useState("");

  useEffect(
    () => () => {
      activeRequestRef.current?.controller.abort();
      if (activeRequestRef.current) window.clearTimeout(activeRequestRef.current.timeout);
      activeRequestRef.current = null;
    },
    [],
  );

  const startRecognition = useCallback(async () => {
    const collected = collectSelectedMathInk(editor);
    if (!collected.ok) {
      addToast({
        variant: "warning",
        title: "Select handwriting first",
        description: collected.message,
      });
      return;
    }

    activeRequestRef.current?.controller.abort();
    if (activeRequestRef.current) window.clearTimeout(activeRequestRef.current.timeout);
    const controller = new AbortController();
    setIsRecognizing(true);
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, RECOGNITION_TIMEOUT_MS);
    const activeRequest = { controller, timeout };
    activeRequestRef.current = activeRequest;

    try {
      const recognition = await recognizeMathInk(collected.selection.strokes, {
        token: whiteboardToken,
        signal: controller.signal,
      });
      if (activeRequestRef.current === activeRequest) {
        if (!isMathInkSelectionCurrent(editor, collected.selection, { requireSelected: true })) {
          addToast({
            variant: "warning",
            title: "Handwriting changed",
            description: "Select the expression again and rerun MathInk.",
          });
        } else {
          const repaired = repairIncompleteMathInkLatex(recognition.latex);
          setDraftLatex(repaired.latex);
          setPreview({
            selection: collected.selection,
            recognition,
            repairedTrailingGroups: repaired.repaired,
          });
        }
      }
    } catch (error) {
      if (activeRequestRef.current === activeRequest) {
        addToast({
          variant: "error",
          title: timedOut ? "MathInk timed out" : "Recognition failed",
          description: timedOut
            ? "The recognizer took too long. Try a smaller expression."
            : errorMessage(error),
        });
      }
    }
    window.clearTimeout(timeout);
    if (activeRequestRef.current === activeRequest) {
      activeRequestRef.current = null;
      setIsRecognizing(false);
    }
  }, [addToast, editor, whiteboardToken]);

  const renderedPreview = useMemo(
    () => (draftLatex.trim() ? renderKatex(draftLatex.trim(), true) : null),
    [draftLatex],
  );
  const draftError = useMemo(() => {
    const latex = draftLatex.trim();
    if (!latex) return "Enter a LaTeX expression.";
    try {
      mathInkInputFromLatex(latex);
    } catch (error) {
      return errorMessage(error);
    }
    return getKatexError(latex);
  }, [draftLatex]);

  const applyRecognition = useCallback(
    (placement: "replace" | "beside") => {
      if (!preview || draftError) return;
      try {
        placeMathInkRecognition(editor, preview.selection, draftLatex, placement);
        setPreview(null);
        addToast({
          variant: "success",
          title: placement === "replace" ? "Handwriting converted" : "Math inserted",
          description:
            placement === "replace"
              ? "The selected strokes were replaced with editable math."
              : "Editable math was inserted beside the handwriting.",
        });
      } catch (error) {
        addToast({
          variant: "error",
          title: "Could not place math",
          description: errorMessage(error),
        });
      }
    },
    [addToast, draftError, draftLatex, editor, preview],
  );

  const copyLatex = useCallback(async () => {
    if (!navigator.clipboard?.writeText) {
      addToast({
        variant: "warning",
        title: "Could not copy LaTeX",
        description: "Clipboard access is unavailable.",
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(draftLatex.trim());
      addToast({
        variant: "success",
        title: "LaTeX copied",
        description: "The recognized expression is on your clipboard.",
      });
    } catch (error) {
      addToast({
        variant: "warning",
        title: "Could not copy LaTeX",
        description: errorMessage(error),
      });
    }
  }, [addToast, draftLatex]);

  const showActions = selectedShapeIds.length > 0 && anchor && isIdle && !preview;

  return (
    <>
      {showActions && (
        <div
          {...stylex.props(styles.bar, styles.barPosition(anchor.x + 8, anchor.y - 8))}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {canRecognize && (
            <button
              type="button"
              onClick={() => {
                void startRecognition();
              }}
              disabled={isRecognizing}
              {...stylex.props(styles.recognize)}
              title="Convert selected handwriting to math"
              aria-label="Convert selected handwriting to math with MathInk"
            >
              {isRecognizing ? (
                <Loader2 size={16} {...stylex.props(progress.spin)} />
              ) : (
                <Sigma size={16} />
              )}
              <span>{isRecognizing ? "Reading…" : "MathInk"}</span>
            </button>
          )}
          {promotableTextId && (
            <button
              type="button"
              onClick={() => promoteToMathShape(editor, promotableTextId)}
              {...stylex.props(styles.promote)}
              title="Turn this equation into a math shape"
              aria-label="Turn this equation into a math shape"
            >
              <SquareSigma size={16} />
              <span>Math shape</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => editor.deleteShapes(editor.getSelectedShapeIds())}
            {...stylex.props(styles.deleteSelection)}
            title="Delete selection"
            aria-label="Delete selection"
          >
            <Trash2 size={16} />
          </button>
        </div>
      )}

      {preview && (
        <WhiteboardModal
          title="Convert handwriting to math"
          description="Review the recognition, correct the LaTeX if needed, then place it on the whiteboard."
          onDismiss={() => setPreview(null)}
          sx={styles.wide}
        >
          <div {...stylex.props(styles.preview)}>
            {renderedPreview ? (
              <div dangerouslySetInnerHTML={{ __html: renderedPreview }} />
            ) : (
              <span {...stylex.props(styles.previewError)}>This expression cannot be rendered.</span>
            )}
          </div>

          <label {...stylex.props(styles.fieldLabel)}>
            LaTeX
            <textarea
              value={draftLatex}
              onChange={(event) => setDraftLatex(event.target.value)}
              spellCheck={false}
              rows={3}
              {...stylex.props(styles.draft)}
            />
          </label>
          <div {...stylex.props(styles.draftError)} role="status">
            {draftError}
          </div>
          {preview.repairedTrailingGroups && (
            <div {...stylex.props(styles.repairNote)} role="status">
              MathInk stopped before closing a group. A missing brace was added; review the result.
            </div>
          )}
          <div {...stylex.props(styles.meta)}>
            MathInk step {preview.recognition.modelStep.toLocaleString()} · {Math.round(preview.recognition.latencyMs)} ms
          </div>

          <div {...stylex.props(boardActionRow.base, boardActionRow.wrap, boardActionRow.ruled)}>
            <button
              type="button"
              onClick={() => {
                void copyLatex();
              }}
              disabled={!!draftError}
              {...stylex.props(boardAction.base, boardAction.tight, boardAction.leading, styles.copyLatex)}
            >
              Copy LaTeX
            </button>
            <button
              type="button"
              onClick={() => setPreview(null)}
              {...stylex.props(boardAction.base, boardAction.ghost)}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => applyRecognition("beside")}
              disabled={!!draftError}
              {...stylex.props(boardAction.base, boardAction.tight, boardAction.outline)}
            >
              Insert beside
            </button>
            <button
              type="button"
              onClick={() => applyRecognition("replace")}
              disabled={!!draftError}
              {...stylex.props(boardAction.base, boardAction.tight, boardAction.ai)}
            >
              Replace ink
            </button>
          </div>
        </WhiteboardModal>
      )}
    </>
  );
}
