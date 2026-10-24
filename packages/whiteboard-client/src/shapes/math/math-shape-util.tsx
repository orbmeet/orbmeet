import {
  BaseBoxShapeUtil,
  HTMLContainer,
  RecordProps,
  useValue,
  type SvgExportContext,
  type TLResizeInfo,
} from "tldraw";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  clampMathScale,
  createMathShapeProps,
  getMathShapeSize,
  MATH_BASE_FONT_SIZE,
  MATH_PADDING,
  MATH_SHAPE_MIGRATIONS,
  MATH_SHAPE_PROPS,
  MATH_SHAPE_TYPE,
  MAX_MATH_INPUT_LENGTH,
  type MathShape,
} from "@orbmeet/whiteboard-core/math-shape-schema";
import { danger, neutral, violet } from "@orbmeet/ui/tokens/colors.stylex";
import { fonts, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { mathColors } from "./math-shape-tokens.stylex";
import { mathDark } from "./math-shape-theme";
import {
  compileMathInput,
  resolveMathLatex,
} from "./math-input";
import { getKatexError, renderKatex } from "./katex-renderer";
import { env } from "@orbmeet/ui/tokens/media.stylex";

/** The face KaTeX's fallback text and the measured box are set in. */
const MATH_FONT_FAMILY = "ui-serif, Georgia, Cambria, 'Times New Roman', serif";

const EDITOR_PLACEHOLDER = "Try a/b, x^2, A vv B, [[a,b],[c,d]], vec(x)";
// Operators are lowercase because the uppercase doubles already mean the
// blackboard-bold sets — NN is ℕ, RR is ℝ, ZZ is ℤ — and AA/EE are ∀/∃.
const EDITOR_HINT =
  "vv ∨  ^^ ∧  uu ∪  nn ∩  AA ∀  EE ∃ · \\ for LaTeX · Ctrl/⌘ Enter to finish";

const styles = stylex.create({
  katex: { flex: "none" },
  loading: { color: mathColors.mutedText },
  shape: {
    overflow: "hidden",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: mathColors.shapeBorder,
    borderRadius: "12px",
    backgroundColor: mathColors.surface,
    boxShadow: mathColors.shapeShadow,
    color: mathColors.text,
  },
  size: (width: number, height: number) => ({ width, height }),
  interactive: { pointerEvents: "all" },
  inert: { pointerEvents: "none" },
  preview: {
    display: "flex",
    minHeight: "100%",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    fontFamily: MATH_FONT_FAMILY,
  },
  previewMetrics: (fontSize: number) => ({ padding: `${MATH_PADDING}px`, fontSize }),
  editor: {
    position: "absolute",
    right: 8,
    bottom: 8,
    left: 8,
    display: "flex",
    flexDirection: "column",
    gap: 4,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: mathColors.editorBorder,
    borderRadius: "9px",
    backgroundColor: mathColors.surface,
    padding: 7,
    boxShadow: `0 8px 24px color-mix(in oklab, ${violet.v900} 14%, transparent)`,
  },
  input: {
    width: "100%",
    minHeight: 38,
    resize: "none",
    borderWidth: 0,
    outlineWidth: 0,
    backgroundColor: "transparent",
    color: mathColors.text,
    fontFamily: fonts.mono,
    fontSize: "13px",
    lineHeight: 1.4,
  },
  footer: {
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    gap: 6,
  },
  mode: {
    flex: "none",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: mathColors.modeBorder,
    borderRadius: "5px",
    backgroundColor: {
      default: mathColors.modeSurface,
      [env.hoverable]: { default: mathColors.modeSurface, ":hover": mathColors.modeSurfaceHover },
    },
    paddingInline: 6,
    paddingBlock: 2,
    color: mathColors.modeText,
    fontFamily: "Figtree, system-ui, sans-serif",
    fontSize: "9px",
    fontWeight: weight.normal,
    cursor: "pointer",
  },
  feedback: {
    overflow: "hidden",
    fontFamily: "Figtree, system-ui, sans-serif",
    fontSize: "9px",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  hint: { color: neutral.n500 },
  error: { color: danger.d700 },
});

function MathPreview({
  latex,
  input,
  scale,
  displayMode,
  onMeasure,
}: {
  latex: string;
  input: string;
  scale: number;
  displayMode: boolean;
  onMeasure?: (size: { width: number; height: number }) => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);

  // KaTeX rendering is not cheap and `latex` changes on every keystroke while
  // editing, so memoise rather than re-render the whole expression per frame.
  const html = useMemo(
    () => (latex ? renderKatex(latex, displayMode) : null),
    [latex, displayMode],
  );

  // Measure after paint. KaTeX metrics depend on its webfonts, so re-measure
  // once those settle or the first reading is taken against a fallback face.
  //
  // `scale` is a dependency even though nothing here reads it: the font size it
  // drives lives on an ancestor, so a resize changes the rendered size without
  // changing `html`, and the box has to follow or the equation is clipped.
  // Only the rendered equation is measured — sizing the box to the placeholder
  // would make an empty shape jump the moment the first character lands.
  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element || !html || !onMeasure) return;

    const measure = () => {
      // Layout dimensions exclude both camera zoom and ancestor rotation.
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      if (width > 0 && height > 0) onMeasure({ width, height });
    };

    measure();
    const fonts = element.ownerDocument.fonts;
    if (!fonts) return;
    let active = true;
    void fonts.ready.then(() => {
      if (active) measure();
    });
    return () => {
      active = false;
    };
  }, [html, scale, onMeasure]);

  // KaTeX emits MathML alongside the visual markup, so the expression is
  // already readable; an aria-label here would replace it with worse.
  if (html) {
    return (
      <div
        ref={contentRef}
        {...stylex.props(styles.katex)}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <span {...stylex.props(styles.loading)}>
      {input || "Type a math expression"}
    </span>
  );
}

function MathShapeComponent({
  shape,
  util,
}: {
  shape: MathShape;
  util: MathShapeUtil;
}) {
  const editor = util.editor;

  // These read editor *instance* state, not the shape record. tldraw's
  // InnerShape only re-renders when the record's props/meta change, and its
  // useStateTracking scope ends when `component()` returns — it never covers a
  // child component's render. Without useValue these would be read once and
  // then go stale, so the editor would not open or close.
  const isReadonly = useValue(
    "math shape readonly",
    () => editor.getIsReadonly(),
    [editor],
  );
  const isEditing = useValue(
    "math shape editing",
    () => editor.getEditingShapeId() === shape.id,
    [editor, shape.id],
  );
  const isSelected = useValue(
    "math shape selected",
    () => editor.getSelectedShapeIds().includes(shape.id),
    [editor, shape.id],
  );

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(shape.props.input);
  const [modeError, setModeError] = useState<string | null>(null);

  useEffect(() => {
    if (!isEditing) setDraft(shape.props.input);
  }, [isEditing, shape.props.input]);

  useEffect(() => {
    if (!isEditing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isEditing]);

  const compiled = useMemo(
    () => isEditing ? compileMathInput(draft, undefined, shape.props.displayMode) : null,
    [draft, isEditing, shape.props.displayMode],
  );
  const storedLatex = useMemo(
    () => resolveMathLatex(shape.props.input, shape.props.latex, shape.props.displayMode) ?? "",
    [shape.props.input, shape.props.latex, shape.props.displayMode],
  );
  const previewLatex = isEditing
    ? (compiled?.latex ?? storedLatex)
    : storedLatex;
  const previewInput = isEditing ? draft : shape.props.input;

  const updateShapeProps = useCallback(
    (props: Partial<MathShape["props"]>) => {
      if (isReadonly) return;
      editor.updateShape<MathShape>({ id: shape.id, type: shape.type, props });
    },
    [editor, isReadonly, shape.id, shape.type],
  );

  const updateInput = (next: string) => {
    setModeError(null);
    const input = next.slice(0, MAX_MATH_INPUT_LENGTH);
    setDraft(input);
    const result = compileMathInput(input, undefined, shape.props.displayMode);
    // The synced pair moves atomically. Invalid draft text stays local, so
    // finishing an edit can never leave source and rendered output disagreeing.
    if (!input.trim()) {
      updateShapeProps({ input: "", latex: "" });
    } else if (result.latex !== null) {
      updateShapeProps({ input, latex: result.latex });
    }
  };

  // The equation dictates the box, not the other way round. Measurements are
  // history-ignored so they never appear as a user edit in the undo stack, and
  // idempotent so peers converge instead of fighting over a pixel.
  const handleMeasure = useCallback(
    (size: { width: number; height: number }) => {
      if (isReadonly) return;
      const { w, h } = getMathShapeSize(size.width, size.height);
      const current = editor.getShape<MathShape>(shape.id);
      if (!current) return;
      if (Math.abs(current.props.w - w) < 1 && Math.abs(current.props.h - h) < 1) {
        return;
      }
      editor.run(
        () =>
          editor.updateShape<MathShape>({
            id: shape.id,
            type: shape.type,
            props: { w, h },
          }),
        { history: "ignore" },
      );
    },
    [editor, isReadonly, shape.id, shape.type],
  );

  const isInteractive = !isReadonly && (isEditing || isSelected);
  // tldraw owns the canvas' colour mode, and it signs it on an element we do
  // not render — so the shape reads the mode and themes itself instead of
  // trying to select on tldraw's class.
  const isDarkMode = useValue(
    "math shape dark mode",
    () => editor.user.getIsDarkMode(),
    [editor],
  );

  return (
    <HTMLContainer
      id={shape.id}
      data-testid="math-shape"
      {...stylex.props(
        styles.shape,
        styles.size(shape.props.w, shape.props.h),
        isInteractive ? styles.interactive : styles.inert,
        isDarkMode && mathDark,
      )}
      onPointerDown={
        isEditing ? (event) => editor.markEventAsHandled(event) : undefined
      }
    >
      <div
        data-testid="math-preview"
        {...stylex.props(
          styles.preview,
          styles.previewMetrics(MATH_BASE_FONT_SIZE * shape.props.scale),
        )}
      >
        <MathPreview
          latex={previewLatex}
          input={previewInput}
          scale={shape.props.scale}
          displayMode={shape.props.displayMode}
          onMeasure={handleMeasure}
        />
      </div>

      {isEditing && (
        <div {...stylex.props(styles.editor)}>
          <textarea
            ref={inputRef}
            {...stylex.props(styles.input)}
            aria-label="Math expression"
            value={draft}
            maxLength={MAX_MATH_INPUT_LENGTH}
            spellCheck={false}
            onChange={(event) => updateInput(event.target.value)}
            onBlur={() => setDraft(shape.props.input)}
            onKeyDown={(event) => {
              if (
                event.key === "Escape" ||
                (event.key === "Enter" && (event.metaKey || event.ctrlKey))
              ) {
                event.preventDefault();
                setDraft(shape.props.input);
                editor.setEditingShape(null);
                editor.setCurrentTool("select");
              }
            }}
            placeholder={EDITOR_PLACEHOLDER}
          />
          <div {...stylex.props(styles.footer)}>
            <button
              type="button"
              {...stylex.props(styles.mode)}
              aria-pressed={shape.props.displayMode}
              title="Display math is centred on its own line; inline math sits at text size."
              // Keep focus in the textarea, or the pointer-down would take it
              // and tldraw would close the editor before the click lands.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                const displayMode = !shape.props.displayMode;
                const next = draft !== shape.props.input
                  ? compileMathInput(draft, undefined, displayMode)
                  : null;
                const latex = next?.latex ?? previewLatex;
                const error = next?.error ?? (latex ? getKatexError(latex, displayMode) : null);
                setModeError(error);
                if (!error) {
                  // A mode change can make an unpublished draft valid. Save it
                  // with the mode so finishing the edit cannot discard it.
                  updateShapeProps(next?.latex
                    ? { displayMode, input: draft, latex: next.latex }
                    : { displayMode });
                }
              }}
            >
              {shape.props.displayMode ? "Display" : "Inline"}
            </button>
            {modeError || compiled?.error || compiled?.hint ? (
              <div {...stylex.props(styles.feedback, styles.error)} role="status">
                {modeError ?? compiled?.error ?? compiled?.hint}
              </div>
            ) : (
              <div {...stylex.props(styles.feedback, styles.hint)}>{EDITOR_HINT}</div>
            )}
          </div>
        </div>
      )}
    </HTMLContainer>
  );
}

export function renderMathSvg(shape: MathShape, isDarkMode: boolean) {
  const latex = resolveMathLatex(shape.props.input, shape.props.latex, shape.props.displayMode);
  const html = latex
    ? renderKatex(latex, shape.props.displayMode)
    : null;

  return (
    <foreignObject
      width={shape.props.w}
      height={shape.props.h}
      // tldraw's export pass selects on this class to inline computed styles
      // and @font-face rules into the SVG, which is what makes KaTeX's markup
      // survive as a standalone file.
      className="tl-export-embed-styles"
    >
      <div
        style={{
          width: `${shape.props.w}px`,
          height: `${shape.props.h}px`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: `${MATH_PADDING}px`,
          boxSizing: "border-box",
          overflow: "hidden",
          color: isDarkMode ? "#f4f4f5" : "#18181b",
          fontFamily: MATH_FONT_FAMILY,
          fontSize: `${MATH_BASE_FONT_SIZE * shape.props.scale}px`,
        }}
      >
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <span>{shape.props.input}</span>
        )}
      </div>
    </foreignObject>
  );
}

/**
 * The box a math shape settles on for this equation, measured off-screen with
 * the same markup and metrics the shape renders with — so a shape created at
 * this size is not resized once it mounts. Null when the equation does not
 * render or the document has no layout to measure with.
 */
export function measureMathShape(
  latex: string,
  displayMode: boolean,
  scale: number,
  ownerDocument: Document = document,
): { w: number; h: number } | null {
  const html = renderKatex(latex, displayMode);
  if (!html) return null;

  const host = ownerDocument.createElement("div");
  Object.assign(host.style, {
    position: "absolute",
    top: "0",
    left: "-100000px",
    visibility: "hidden",
    pointerEvents: "none",
    display: "flex",
    fontFamily: MATH_FONT_FAMILY,
    fontSize: `${MATH_BASE_FONT_SIZE * scale}px`,
  });
  const content = ownerDocument.createElement("div");
  content.style.flex = "none";
  content.innerHTML = html;
  host.appendChild(content);
  ownerDocument.body.appendChild(host);
  try {
    const width = content.offsetWidth;
    const height = content.offsetHeight;
    return width > 0 && height > 0 ? getMathShapeSize(width, height) : null;
  } finally {
    host.remove();
  }
}

export class MathShapeUtil extends BaseBoxShapeUtil<MathShape> {
  static override type = MATH_SHAPE_TYPE;
  static override props: RecordProps<MathShape> = MATH_SHAPE_PROPS;
  static override migrations = MATH_SHAPE_MIGRATIONS;

  getDefaultProps(): MathShape["props"] {
    return createMathShapeProps();
  }

  override canEdit(): boolean {
    return true;
  }

  override canResize(): boolean {
    return true;
  }

  override getText(shape: MathShape): string {
    return shape.props.input;
  }

  override getAriaDescriptor(shape: MathShape): string {
    return `Math expression: ${shape.props.input}`;
  }

  component(shape: MathShape) {
    return <MathShapeComponent shape={shape} util={this} />;
  }

  override getIndicatorPath(shape: MathShape) {
    const path = new Path2D();
    path.roundRect(0, 0, shape.props.w, shape.props.h, 10);
    return path;
  }

  override toSvg(shape: MathShape, context: SvgExportContext) {
    return renderMathSvg(shape, context.isDarkMode);
  }

  /** An abandoned empty equation is noise on the board, not content. */
  override onEditEnd(shape: MathShape) {
    if (shape.props.input.trim()) return;
    this.editor.deleteShape(shape.id);
  }

  /**
   * Dragging a handle scales the equation rather than stretching a box around
   * it. The box itself is remeasured from the rendered output, so we only need
   * to carry the scale and the anchor position here.
   */
  override onResize(_shape: MathShape, info: TLResizeInfo<MathShape>) {
    const factor = Math.max(Math.abs(info.scaleX), Math.abs(info.scaleY));
    const scale = clampMathScale(info.initialShape.props.scale * factor);

    return {
      props: { scale },
    };
  }
}
