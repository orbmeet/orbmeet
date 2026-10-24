import {
  BaseBoxShapeUtil,
  HTMLContainer,
  RecordProps,
  resizeBox,
  useValue,
  type Editor,
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
  CODE_LANGUAGES,
  CODE_SHAPE_MIGRATIONS,
  CODE_SHAPE_PROPS,
  CODE_SHAPE_TYPE,
  createCodeShapeProps,
  getStarterCode,
  isStarterCode,
  MAX_CODE_CHARS,
  MAX_CODE_HEIGHT,
  MAX_CODE_WIDTH,
  MIN_CODE_HEIGHT,
  MIN_CODE_WIDTH,
  type CodeLanguage,
  type CodeShape,
} from "@orbmeet/whiteboard-core/code-shape-schema";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  Eraser,
  Loader2,
  Play,
  Square,
} from "lucide-react";
import { composeOutput } from "./compose-output";
import { cancelCodeRun, runCode } from "./run-code";
import { useWhiteboardToolbarContext } from "../../toolbar/whiteboard-toolbar-context";
import { codeColors } from "./code-shape-tokens.stylex";
import { CODE_SVG_PALETTE, codeDark, type CodeSvgPalette } from "./code-shape-theme";

/**
 * How long typing settles before the source reaches the synced record. Long
 * enough that a fast typist sends one update per word rather than per key,
 * short enough that a collaborator watching does not feel the lag. Every path
 * that can end an edit flushes early, so this is a batching window and never a
 * window in which work can be lost.
 */
const CODE_COMMIT_DEBOUNCE_MS = 200;

/**
 * The code type scale. 13px/22px rather than the 12px/20px this shipped with:
 * a cell is read across a meeting — shared screen, someone's laptop, a
 * projector — at whatever zoom the page happens to be fitted to, so the
 * baseline has to survive being scaled down, not just look right at 100%.
 */
const CODE_FONT_SIZE_PX = 13;
const LINE_HEIGHT_PX = 22;

/**
 * How long a run may wait before the spinner admits it is waiting on a cold
 * container rather than on the program. Short enough to land before anyone
 * decides the button is broken, long enough that a warm run — the common case —
 * never shows it at all.
 */
const COLD_START_NOTICE_MS = 3_000;

const spin = stylex.keyframes({
  from: { transform: "rotate(0deg)" },
  to: { transform: "rotate(360deg)" },
});

const styles = stylex.create({
  container: {
    // A column flex box: the header and output tray size to their content and
    // the editor takes the rest. `display: block` here strands `editorWrapper`
    // at its auto height, which collapses the textarea to its intrinsic rows.
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    borderRadius: "8px",
    backgroundColor: codeColors.surface,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: codeColors.shapeBorder,
    boxShadow: shadows.elevated,
    overflow: "hidden",
    color: codeColors.text,
    fontFamily: fonts.mono,
  },
  size: (width: number, height: number) => ({ width, height }),
  // The shape's own box never takes pointer events. Its controls opt in one by
  // one (`controlSurface`), and everything that is left — the header's empty
  // space, the gutter, the border — falls through to the canvas beneath, which
  // is what makes a selected cell draggable by its chrome.
  inert: { pointerEvents: "none" },
  controlSurface: { pointerEvents: "all" },

  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    paddingInline: space.s2,
    paddingBlock: space.s1_5,
    backgroundColor: codeColors.chrome,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: codeColors.shapeBorder,
    gap: space.s2,
    flexShrink: 0,
    userSelect: "none",
  },
  headerGroup: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
  },

  languageSelect: {
    backgroundColor: codeColors.controlSurface,
    color: codeColors.text,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: codeColors.controlBorder,
    borderRadius: "4px",
    paddingInline: space.s1_5,
    paddingBlock: "2px",
    fontFamily: fonts.sans,
    fontSize: "11px",
    fontWeight: weight.medium,
    cursor: "pointer",
    outlineWidth: 0,
  },

  runButton: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    paddingInline: space.s2,
    paddingBlock: "3px",
    borderRadius: "4px",
    borderWidth: 0,
    backgroundColor: {
      default: codeColors.runSurface,
      [env.hoverable]: { default: codeColors.runSurface, ":hover": codeColors.runSurfaceHover },
    },
    color: codeColors.runText,
    fontFamily: fonts.sans,
    fontSize: "11px",
    fontWeight: weight.semibold,
    cursor: "pointer",
    lineHeight: 1,
  },
  runButtonDisabled: {
    opacity: 0.5,
    cursor: "not-allowed",
  },
  spinner: {
    animationName: spin,
    animationDuration: "0.9s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },

  clearButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "3px",
    borderRadius: "4px",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: codeColors.controlBorder,
    backgroundColor: {
      default: "transparent",
      [env.hoverable]: { default: "transparent", ":hover": codeColors.quietHover },
    },
    color: codeColors.quietText,
    cursor: "pointer",
  },

  statusPill: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    fontFamily: fonts.sans,
    fontSize: "10px",
    paddingInline: space.s1_5,
    paddingBlock: "2px",
    borderRadius: "4px",
    lineHeight: 1,
  },
  statusIdle: { color: codeColors.statusIdleText },
  statusRunning: { color: codeColors.quietText },
  statusSuccess: {
    color: codeColors.statusSuccessText,
    backgroundColor: codeColors.statusSuccessSurface,
  },
  statusError: {
    color: codeColors.statusErrorText,
    backgroundColor: codeColors.statusErrorSurface,
  },

  editorWrapper: {
    display: "flex",
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "0%",
    minHeight: 0,
    position: "relative",
    overflow: "hidden",
  },
  gutter: {
    // Scrolls in lockstep with the textarea, driven by its scroll handler. The
    // scrollbar itself stays hidden: the gutter is a passenger, not a second
    // scrollable region a user could desynchronise by scrolling it directly.
    overflow: "hidden",
    // The line numbers are one newline-joined text node, so the gutter owns the
    // `pre` that keeps them on separate lines. Inheriting it from the container
    // tied this to the container's own layout, and any flex item between them
    // would collapse the newlines into spaces.
    whiteSpace: "pre",
    paddingInline: space.s1_5,
    paddingBlock: space.s2,
    backgroundColor: codeColors.chrome,
    color: codeColors.lineNumber,
    fontSize: `${CODE_FONT_SIZE_PX}px`,
    lineHeight: `${LINE_HEIGHT_PX}px`,
    textAlign: "right",
    userSelect: "none",
    borderRightWidth: 1,
    borderRightStyle: "solid",
    borderRightColor: codeColors.shapeBorder,
    flexShrink: 0,
  },
  textarea: {
    flexGrow: 1,
    width: "100%",
    height: "100%",
    padding: space.s2,
    margin: 0,
    backgroundColor: "transparent",
    color: codeColors.text,
    fontSize: `${CODE_FONT_SIZE_PX}px`,
    lineHeight: `${LINE_HEIGHT_PX}px`,
    fontFamily: "inherit",
    borderWidth: 0,
    outlineWidth: 0,
    resize: "none",
    overflow: "auto",
    tabSize: 2,
    whiteSpace: "pre",
  },

  outputTray: {
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    backgroundColor: codeColors.outputSurface,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: codeColors.shapeBorder,
    maxHeight: "45%",
    overflow: "hidden",
  },
  outputHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    paddingInline: space.s2,
    paddingBlock: "3px",
    backgroundColor: codeColors.outputChrome,
    borderWidth: 0,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: codeColors.shapeBorder,
    fontFamily: fonts.sans,
    fontSize: "10px",
    fontWeight: weight.semibold,
    color: codeColors.quietText,
    cursor: "pointer",
    userSelect: "none",
  },
  outputBody: {
    padding: space.s2,
    fontSize: "12px",
    lineHeight: 1.45,
    overflow: "auto",
    margin: 0,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    color: codeColors.outputText,
  },
  outputBodyError: { color: codeColors.outputErrorText },
});

interface CodeShapeComponentProps {
  editor: Editor;
  shape: CodeShape;
}

function CodeShapeComponent({ editor, shape }: CodeShapeComponentProps) {
  const isReadonly = useValue("isReadonly", () => editor.getIsReadonly(), [editor]);
  const isDarkMode = useValue("isDarkMode", () => editor.user.getIsDarkMode(), [editor]);
  const isSelected = useValue(
    "isSelected",
    () => editor.getSelectedShapeIds().includes(shape.id),
    [editor, shape.id],
  );
  const isEditing = useValue(
    "isEditing",
    () => editor.getEditingShapeId() === shape.id,
    [editor, shape.id],
  );

  const [localCode, setLocalCode] = useState(shape.props.code);
  const [isOutputOpen, setIsOutputOpen] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  /**
   * Set once a run has been waiting long enough that the container is probably
   * still starting. Cold starts pull a multi-gigabyte toolchain image, so the
   * first run on an idle board legitimately takes several seconds — long enough
   * that an unchanging "Running…" reads as a hang.
   */
  const [isStartingRunner, setIsStartingRunner] = useState(false);

  // Runs happen on the server, so a cell can only run for someone the board has
  // already issued a whiteboard token to. Without one there is nothing to
  // authenticate with and the button says so by being disabled.
  const { whiteboardToken } = useWhiteboardToolbarContext();
  const whiteboardTokenRef = useRef(whiteboardToken);
  useLayoutEffect(() => {
    whiteboardTokenRef.current = whiteboardToken;
  }, [whiteboardToken]);
  const canRun = !isReadonly && Boolean(whiteboardToken);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCodeRef = useRef<string | null>(null);
  /** Set when a keystroke moves the caret itself, applied after React re-renders. */
  const pendingCaretRef = useRef<number | null>(null);
  /**
   * The run in flight, and what it was launched for.
   *
   * A result is only meaningful for the exact source and language that produced
   * it, so the run carries them: anything that changes what the cell *would* run
   * — a keystroke here, a collaborator's edit, a new language — makes the
   * pending result an answer to a question nobody is asking any more, and the
   * controller is how it gets abandoned rather than written to the board.
   */
  const activeRunRef = useRef<{
    controller: AbortController;
    runId: string;
    source: string;
    language: CodeLanguage;
  } | null>(null);

  const updateProps = useCallback(
    (props: Partial<CodeShape["props"]>) => {
      // A flush can land after the shape is gone — deleted here, or by a
      // collaborator mid-edit. Writing to a missing id is not an error worth
      // raising, it is just nothing to do.
      if (isReadonly || !editor.getShape(shape.id)) return;
      editor.updateShape<CodeShape>({ id: shape.id, type: shape.type, props });
    },
    [editor, isReadonly, shape.id, shape.type],
  );

  const flushCode = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const pending = pendingCodeRef.current;
    pendingCodeRef.current = null;
    if (pending !== null) updateProps({ code: pending });
  }, [updateProps]);

  const commitCode = useCallback(
    (value: string) => {
      setLocalCode(value);
      pendingCodeRef.current = value;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        flushCode();
      }, CODE_COMMIT_DEBOUNCE_MS);
    },
    [flushCode],
  );

  // Unmounting must not drop a pending edit. tldraw culls shapes that leave the
  // viewport, so panning away within the debounce window is an ordinary thing
  // to do — and without this flush it would silently discard the last thing
  // typed.
  const flushCodeRef = useRef(flushCode);
  useEffect(() => {
    flushCodeRef.current = flushCode;
  }, [flushCode]);
  useEffect(() => () => flushCodeRef.current(), []);

  // Adopt remote edits only while this client is not the one editing, so a
  // collaborator's keystrokes never yank the caret out from under someone.
  useEffect(() => {
    if (!isEditing) setLocalCode(shape.props.code);
  }, [shape.props.code, isEditing]);

  // The caret is restored after React has re-rendered the controlled textarea;
  // set during the same tick as the keystroke it would be overwritten.
  useLayoutEffect(() => {
    const caret = pendingCaretRef.current;
    if (caret === null) return;
    pendingCaretRef.current = null;
    textareaRef.current?.setSelectionRange(caret, caret);
  }, [localCode]);

  /**
   * Writes exactly `source` to the record now, superseding any debounced write.
   *
   * A run publishes the source it is about to run, which is what makes the
   * result's own check against the record sound: afterwards the record *is* the
   * code that ran, so a later mismatch can only mean someone changed it since.
   * Flushing whatever happened to be pending is not the same thing — while this
   * client is editing, the record can hold a collaborator's newer text and have
   * nothing pending of its own, and the run would then be checked against code
   * it never ran.
   */
  const publishSource = useCallback(
    (source: string) => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      pendingCodeRef.current = null;
      if (editor.getShape<CodeShape>(shape.id)?.props.code !== source) {
        updateProps({ code: source });
      }
    },
    [editor, shape.id, updateProps],
  );

  /** Ends the run in flight, if there is one, without touching what it would have written. */
  const abandonRun = useCallback(() => {
    const active = activeRunRef.current;
    if (!active) return;
    activeRunRef.current = null;
    void cancelCodeRun(active.runId, { token: whiteboardTokenRef.current });
    active.controller.abort();
    setIsRunning(false);
    setIsStartingRunner(false);
  }, []);

  // tldraw may unmount a shape merely because it left the viewport. The HTTP
  // request belongs to the component that started it, so culling must stop the
  // server process as well as prevent a late result from being published.
  useEffect(() => () => abandonRun(), [abandonRun]);

  const handleRun = useCallback(async () => {
    if (!canRun) return;

    // What this run is for. Captured before anything can change it, and the
    // result is checked against it rather than against whatever the cell holds
    // by the time the runner answers.
    const source = localCode;
    const language = shape.props.language;

    // Publish the source before the result, so what the board shows as the
    // output is never attributed to code nobody else has seen yet.
    publishSource(source);
    // Pressing Run again, or Ctrl+Enter, replaces the run rather than racing it.
    abandonRun();

    const controller = new AbortController();
    const runId = crypto.randomUUID();
    activeRunRef.current = { controller, runId, source, language };
    setIsRunning(true);
    const coldStartNotice = setTimeout(() => {
      if (!controller.signal.aborted) setIsStartingRunner(true);
    }, COLD_START_NOTICE_MS);

    try {
      const result = await runCode(source, language, {
        token: whiteboardToken,
        signal: controller.signal,
        runId,
      });
      // Two guards for two different ways a result stops being the answer.
      // Abandoned: someone changed the source, pressed Stop, or started another
      // run — this component knows because it holds the controller. Moved on:
      // the record itself no longer matches, which is the case this component
      // cannot see, because tldraw culls a shape that leaves the viewport and
      // the run outlives the component that started it.
      if (controller.signal.aborted) return;
      const current = editor.getShape<CodeShape>(shape.id);
      if (!current || current.props.code !== source || current.props.language !== language) return;

      updateProps({
        output: composeOutput(result) || "(no output)",
        status: result.status,
        executionTimeMs: result.executionTimeMs,
      });
      setIsOutputOpen(true);
    } finally {
      clearTimeout(coldStartNotice);
      if (activeRunRef.current?.controller === controller) {
        activeRunRef.current = null;
        setIsRunning(false);
        setIsStartingRunner(false);
      }
    }
  }, [
    abandonRun,
    canRun,
    editor,
    localCode,
    publishSource,
    shape.id,
    shape.props.language,
    updateProps,
    whiteboardToken,
  ]);

  // One place to notice that a run has been outlived by its own cell. `localCode`
  // moves for a local keystroke and for a collaborator's edit alike, so watching
  // it here covers both without either handler having to remember to.
  useEffect(() => {
    const active = activeRunRef.current;
    if (!active) return;
    if (active.source !== localCode || active.language !== shape.props.language) abandonRun();
  }, [abandonRun, localCode, shape.props.language]);

  const handleLanguageChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const language = event.target.value as CodeLanguage;
    // Swapping language on a cell nobody has typed into should bring that
    // language's starter snippet with it; anything else would leave JavaScript
    // sitting in a cell now labelled JSON.
    if (isStarterCode(localCode)) {
      const starter = getStarterCode(language);
      setLocalCode(starter);
      pendingCodeRef.current = null;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      updateProps({ language, code: starter, output: "", status: "idle", executionTimeMs: 0 });
      return;
    }
    updateProps({ language });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // The canvas owns single-key shortcuts (delete, space-to-pan, undo); inside
    // a text field they belong to the field.
    event.stopPropagation();

    // Which is why Escape has to be handled here rather than left to the editor.
    // Stopping propagation is what keeps Delete from destroying the cell
    // mid-word, and it equally keeps the editor from seeing the one key that
    // means "I am done with this field" — so without this there is no keyboard
    // route out of a cell, and none to selecting it and deleting it either.
    if (event.key === "Escape") {
      event.preventDefault();
      flushCode();
      editor.setEditingShape(null);
      editor.setCurrentTool("select");
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void handleRun();
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      const textarea = event.currentTarget;
      const { selectionStart, selectionEnd, value } = textarea;
      commitCode(`${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`);
      pendingCaretRef.current = selectionStart + 2;
    }
  };

  const lineCount = Math.max(1, localCode.split("\n").length);
  const lineNumbers = useMemo(
    () => Array.from({ length: lineCount }, (_, index) => index + 1).join("\n"),
    [lineCount],
  );
  // A cell only answers the pointer once it is selected — the first click on
  // an idle cell belongs to the canvas, and selects it.
  const isInteractive = isSelected || isEditing;
  /**
   * What a control needs in order to take a pointer away from the canvas: the
   * surface has to accept events at all (`controlStyle`) and the press has to
   * be marked handled (`markPress`) so the select tool does not start
   * translating the shape out from under the cursor.
   *
   * Applied per control rather than to the whole cell. A cell-wide version of
   * this is what shipped, and it made a selected cell impossible to move:
   * every press anywhere on it, chrome included, was marked handled before
   * tldraw could read it as the start of a drag.
   *
   * The handlers are written inline at each element rather than shared in one
   * spread object, because an annotated event parameter is not portable here:
   * the Worker build merges HTMLRewriter's `Element` into the DOM one, so a
   * handler declared on `Element`/`HTMLElement` fits no real element. Inline,
   * the attribute types each one.
   */
  const controlStyle = isInteractive ? styles.controlSurface : null;
  const markPress = isInteractive
    ? (event: Parameters<typeof editor.markEventAsHandled>[0]) =>
        editor.markEventAsHandled(event)
    : undefined;
  const status = shape.props.status;

  return (
    <HTMLContainer
      id={shape.id}
      {...stylex.props(
        styles.container,
        styles.size(shape.props.w, shape.props.h),
        styles.inert,
        isDarkMode && codeDark,
      )}
    >
      <div {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.headerGroup)}>
          <select
            value={shape.props.language}
            onChange={handleLanguageChange}
            disabled={isReadonly}
            title={LANGUAGE_LABELS[shape.props.language]}
            {...stylex.props(styles.languageSelect, controlStyle)}
            onPointerDown={markPress}
            aria-label="Code language"
          >
            {CODE_LANGUAGES.map((language) => (
              <option key={language} value={language}>
                {LANGUAGE_LABELS[language]}
              </option>
            ))}
          </select>

          {/*
            One control with two jobs, because they are the same job: while a run
            is in flight the only useful thing to do to it is end it, and a
            disabled button with a spinner in it offers nothing. Stopping is also
            the honest answer to a slow run — a cold container start takes
            seconds, and waiting it out is not the only reasonable choice. The
            spinner moves to the status pill, which is where "still working" was
            already being said.
          */}
          <button
            type="button"
            onClick={() => (isRunning ? abandonRun() : void handleRun())}
            disabled={!canRun}
            {...stylex.props(
              styles.runButton,
              !canRun && styles.runButtonDisabled,
              controlStyle,
            )}
            onPointerDown={markPress}
            title={
              !canRun
                ? "You do not have permission to run code on this board"
                : isRunning
                  ? "Stop this run"
                  : "Run code (Ctrl/Cmd + Enter)"
            }
          >
            {isRunning ? <Square size={12} fill="currentColor" /> : <Play size={12} fill="currentColor" />}
            <span>{isRunning ? "Stop" : "Run"}</span>
          </button>
        </div>

        <div {...stylex.props(styles.headerGroup)}>
          <StatusPill
            isRunning={isRunning}
            isStartingRunner={isStartingRunner}
            status={status}
            ms={shape.props.executionTimeMs}
          />

          {shape.props.output && (
            <button
              type="button"
              onClick={() =>
                updateProps({ output: "", status: "idle", executionTimeMs: 0 })
              }
              disabled={isReadonly}
              {...stylex.props(styles.clearButton, controlStyle)}
              onPointerDown={markPress}
              title="Clear output"
              aria-label="Clear output"
            >
              {/*
                An eraser, not a trash can. This clears the output; the cell is
                removed the way every other shape is, by selecting it and
                deleting it. A trash can in a cell's own header reads as "remove
                this cell" — the one thing in the header that it does not do.
              */}
              <Eraser size={12} />
            </button>
          )}
        </div>
      </div>

      <div {...stylex.props(styles.editorWrapper)}>
        <div ref={gutterRef} {...stylex.props(styles.gutter)} aria-hidden="true">
          {lineNumbers}
        </div>
        <textarea
          ref={textareaRef}
          value={localCode}
          onFocus={() => {
            if (!isReadonly && editor.getEditingShapeId() !== shape.id) {
              editor.setEditingShape(shape.id);
            }
          }}
          onBlur={() => {
            flushCode();
            if (editor.getEditingShapeId() === shape.id) editor.setEditingShape(null);
          }}
          onChange={(event) => commitCode(event.target.value.slice(0, MAX_CODE_CHARS))}
          onKeyDown={handleKeyDown}
          onKeyUp={(event) => event.stopPropagation()}
          onScroll={(event) => {
            if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop;
          }}
          readOnly={isReadonly}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="// Enter your code here…"
          aria-label={`${LANGUAGE_LABELS[shape.props.language]} source`}
          {...stylex.props(styles.textarea, controlStyle)}
          onPointerDown={markPress}
          onWheel={isInteractive ? (event) => event.stopPropagation() : undefined}
        />
      </div>

      {shape.props.output && (
        <div {...stylex.props(styles.outputTray)}>
          <button
            type="button"
            {...stylex.props(styles.outputHeader, controlStyle)}
            onPointerDown={markPress}
            onClick={() => setIsOutputOpen((open) => !open)}
            aria-expanded={isOutputOpen}
          >
            <span>Output</span>
            {isOutputOpen ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </button>

          {isOutputOpen && (
            <pre
              {...stylex.props(
                styles.outputBody,
                status === "error" && styles.outputBodyError,
                controlStyle,
              )}
              onPointerDown={markPress}
              onWheel={isInteractive ? (event) => event.stopPropagation() : undefined}
            >
              {shape.props.output}
            </pre>
          )}
        </div>
      )}
    </HTMLContainer>
  );
}

const LANGUAGE_LABELS: Record<CodeLanguage, string> = {
  python: "Python",
  javascript: "JavaScript",
  typescript: "TypeScript",
  java: "Java",
  c: "C",
  cpp: "C++",
  go: "Go",
  rust: "Rust",
};

/**
 * "Running" is local: it describes this client's own in-flight run and is never
 * read from the record, which is why a run abandoned by a closing tab leaves no
 * trace on anyone else's board.
 */
function StatusPill({
  isRunning,
  isStartingRunner,
  status,
  ms,
}: {
  isRunning: boolean;
  isStartingRunner: boolean;
  status: CodeShape["props"]["status"];
  ms: number;
}) {
  if (isRunning) {
    return (
      <span {...stylex.props(styles.statusPill, styles.statusRunning)}>
        <Loader2 size={10} {...stylex.props(styles.spinner)} />
        {isStartingRunner ? "Starting runner…" : "Running…"}
      </span>
    );
  }

  if (status === "success") {
    return (
      <span {...stylex.props(styles.statusPill, styles.statusSuccess)}>
        <Check size={10} />
        {ms}ms
      </span>
    );
  }

  if (status === "error") {
    return (
      <span {...stylex.props(styles.statusPill, styles.statusError)}>
        <AlertCircle size={10} />
        Error
      </span>
    );
  }

  return <span {...stylex.props(styles.statusPill, styles.statusIdle)}>Ready</span>;
}

const SVG_HEADER_HEIGHT = 28;
const SVG_LINE_HEIGHT = 16;
const SVG_PADDING = 12;
const SVG_MAX_CHARS_PER_LINE = 72;

/**
 * The export view of a cell: source, and the output it produced.
 *
 * Exports are read away from the board — in a PDF, in a thumbnail — where a
 * code block without its result is only half the record of what happened in
 * the meeting. Both are clipped to what the shape's own box can hold rather
 * than scaled down, so an export stays legible instead of becoming grey texture.
 */
export function renderCodeSvg(shape: CodeShape, isDarkMode: boolean) {
  const { w, h, language, code, output, status } = shape.props;
  const palette: CodeSvgPalette = isDarkMode ? CODE_SVG_PALETTE.dark : CODE_SVG_PALETTE.light;

  const outputLines = output ? clip(output, 4) : [];
  const outputHeight = outputLines.length
    ? outputLines.length * SVG_LINE_HEIGHT + SVG_PADDING
    : 0;
  const codeAreaHeight = h - SVG_HEADER_HEIGHT - outputHeight;
  const codeLines = clip(code, Math.max(0, Math.floor((codeAreaHeight - SVG_PADDING) / SVG_LINE_HEIGHT)));

  return (
    <g>
      <rect width={w} height={h} rx={8} fill={palette.surface} stroke={palette.border} strokeWidth={1} />
      <rect width={w} height={SVG_HEADER_HEIGHT} fill={palette.chrome} />
      <text x={SVG_PADDING} y={18} fill={palette.muted} fontSize={10} fontFamily="monospace">
        {LANGUAGE_LABELS[language].toUpperCase()}
      </text>

      {codeLines.map((line, index) => (
        <text
          key={index}
          x={SVG_PADDING}
          y={SVG_HEADER_HEIGHT + SVG_PADDING + index * SVG_LINE_HEIGHT}
          fill={palette.text}
          fontSize={11}
          fontFamily="monospace"
        >
          {line}
        </text>
      ))}

      {outputLines.length > 0 && (
        <>
          <rect y={h - outputHeight} width={w} height={outputHeight} fill={palette.outputSurface} />
          {outputLines.map((line, index) => (
            <text
              key={index}
              x={SVG_PADDING}
              y={h - outputHeight + SVG_PADDING + index * SVG_LINE_HEIGHT}
              fill={status === "error" ? palette.errorText : palette.muted}
              fontSize={10}
              fontFamily="monospace"
            >
              {line}
            </text>
          ))}
        </>
      )}
    </g>
  );
}

/** First `maxLines` lines, each clipped to the width the box can show. */
function clip(text: string, maxLines: number): string[] {
  if (maxLines <= 0) return [];
  return text
    .split("\n")
    .slice(0, maxLines)
    .map((line) => (line.length > SVG_MAX_CHARS_PER_LINE ? `${line.slice(0, SVG_MAX_CHARS_PER_LINE - 1)}…` : line));
}

export class CodeShapeUtil extends BaseBoxShapeUtil<CodeShape> {
  static override type = CODE_SHAPE_TYPE;
  static override props: RecordProps<CodeShape> = CODE_SHAPE_PROPS;
  static override migrations = CODE_SHAPE_MIGRATIONS;

  override canEdit(): boolean {
    return true;
  }

  override canResize(): boolean {
    return true;
  }

  getDefaultProps(): CodeShape["props"] {
    return createCodeShapeProps();
  }

  component(shape: CodeShape) {
    return <CodeShapeComponent editor={this.editor} shape={shape} />;
  }

  override getIndicatorPath(shape: CodeShape) {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }

  override getAriaDescriptor(shape: CodeShape): string {
    return `${LANGUAGE_LABELS[shape.props.language]} code block`;
  }

  override toSvg(shape: CodeShape, context: SvgExportContext) {
    return renderCodeSvg(shape, context.isDarkMode);
  }

  override onResize(shape: CodeShape, info: TLResizeInfo<CodeShape>) {
    return resizeBox(shape, info, {
      minWidth: MIN_CODE_WIDTH,
      maxWidth: MAX_CODE_WIDTH,
      minHeight: MIN_CODE_HEIGHT,
      maxHeight: MAX_CODE_HEIGHT,
    });
  }
}
