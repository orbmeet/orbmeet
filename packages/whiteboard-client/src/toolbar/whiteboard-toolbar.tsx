import {
  useRef,
  useState,
  useEffect,
  useCallback,
  createContext,
} from "react";
import {
  GeoShapeGeoStyle,
  useEditor,
  useActions,
  useValue,
  useCanUndo,
  useCanRedo,
  track,
} from "tldraw";
import type { TLDefaultColorStyle, TLGeoShapeGeoStyle } from "tldraw";
import {
  DefaultColorStyle,
} from "tldraw";
import {
  BotMessageSquare,
  ClipboardPaste,
  Copy,
  FileText,
  Image,
  MoreHorizontal,
  PencilOff,
  Plus,
  Redo2,
  Shapes,
  Trash2,
  Undo2,
} from "lucide-react";
import { layout as layoutStyles } from "@orbmeet/ui/styles/atoms";
import { accent, danger, ink, neutral, surface, violet } from "@orbmeet/ui/tokens/colors.stylex";
import { boardZIndex } from "@orbmeet/ui/tokens/layers.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { duration, easing } from "@orbmeet/ui/tokens/motion.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { boardDivider, boardPanel, boardTrigger } from "../styles/board";
import { useScrollOverflow } from "../chrome/use-scroll-overflow";
import {
  DEFAULT_TABLE_COLS,
  DEFAULT_TABLE_HEIGHT,
  DEFAULT_TABLE_ROWS,
  DEFAULT_TABLE_WIDTH,
  TABLE_SHAPE_TYPE,
} from "@orbmeet/whiteboard-core/table-shape-schema";
import {
  CODE_SHAPE_TYPE,
  createCodeShapeProps,
  DEFAULT_CODE_HEIGHT,
  DEFAULT_CODE_WIDTH,
} from "@orbmeet/whiteboard-core/code-shape-schema";
import { createShapeId, type TLParentId } from "tldraw";
import {
  GeoToolIcon,
  ToolIcon,
  TOOL_ICON_SIZE,
  TOOL_ICON_STROKE,
} from "./whiteboard-toolbar-icons";
import {
  getEditorActions,
  useWhiteboardToolbarContext,
} from "./whiteboard-toolbar-context";
import { PropertiesPanelToggle } from "./whiteboard-toolbar-properties";
import { BackgroundPanelToggle } from "./whiteboard-toolbar-background";
import { isPageFrameShape } from "@orbmeet/whiteboard-core/page-frame-model";
import { WhiteboardToolbarPopover, WhiteboardToolbarPopoverSide } from "./whiteboard-toolbar-popover";
import { useWhiteboardToast } from "../chrome/use-whiteboard-toast";

type ToolbarPanel = "insert" | "background" | "properties" | "shapes";

const STYLEABLE_TOOL_IDS = new Set(["draw", "highlight", "text", "arrow", "geo"]);
const DEFAULT_HIGHLIGHT_COLOR: TLDefaultColorStyle = "yellow";

export function shouldShowInlineWhiteboardAiButton(
  compact: boolean,
  aiEnabled: boolean,
  hasToggle: boolean,
) {
  return !compact && aiEnabled && hasToggle;
}

export type WhiteboardToolbarVariant = "regular" | "compact" | "minimal";

const styles = stylex.create({
  /** The strip itself. Its height is published by the document wrapper from
      the same constant the camera-inset calculation uses. */
  toolbar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: boardZIndex.chrome,
    height: "var(--whiteboard-toolbar-height, 52px)",
    overflowX: "auto",
    scrollbarWidth: "none",
    "::-webkit-scrollbar": { display: "none" },
    // The board's own ground, with no rule under it: the page's outline already
    // marks where the page starts, and a line between two areas of the same
    // colour made the strip a band standing across the room.
    backgroundColor: `var(--wb-document-bg, ${surface.board})`,
    pointerEvents: "auto",
  },
  /**
   * The scrollbar is hidden on purpose, so a strip that overflows has to say so
   * some other way: the edge hiding content fades out. Without this the missing
   * control is indistinguishable from a control that does not exist.
   */
  toolbarFade: (start: boolean, end: boolean) => ({
    // `black` is an alpha stencil here, not a colour — the same convention the
    // page rail and the `atoms` fade use. Only the edges that are actually
    // hiding something fade, so a toolbar that fits stays crisp on both sides.
    maskImage:
      start || end
        ? `linear-gradient(to right, transparent 0, black ${start ? "32px" : "0px"}, black calc(100% - ${end ? "32px" : "0px"}), transparent 100%)`
        : null,
  }),
  content: {
    display: "flex",
    width: "max-content",
    height: "100%",
    alignItems: "center",
    marginInline: "auto",
  },
  contentCompact: { gap: space.s0_5, paddingInline: space.s2 },
  /**
   * The regular board's tools: a column floating at the board's left edge,
   * between the board's top and bottom bands, centred in what is left.
   * Vertical because a strip across the top cost the drawing surface a band
   * of its own on every board, and on an iPad it sat at the far end of the
   * screen from the hand not holding the pencil.
   */
  paletteLane: {
    position: "absolute",
    // Clear of the page controls, which stand in the board's top-left
    // corner over the palette (`WHITEBOARD_CONTROLS_BAND_PX`, 52), and of the
    // status row under them — following, presenting — 6px below and 36px
    // tall. Cleared whether or not a status shows, so the palette does not
    // jump when one comes and goes; on a short board, an upright iPad's
    // beside the Conversation, it used to slide under the status instead.
    top: 94,
    bottom: space.s2,
    left: space.s2,
    zIndex: boardZIndex.chrome,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    pointerEvents: "none",
  },
  palette: {
    display: "flex",
    maxHeight: "100%",
    flexDirection: "column",
    alignItems: "center",
    gap: 2,
    overflowY: "auto",
    borderRadius: radii.card,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n150,
    backgroundColor: surface.raised,
    padding: space.s1,
    boxShadow: `0 1px 2px color-mix(in oklab, ${ink.strong} 6%, transparent), 0 12px 32px -10px color-mix(in oklab, ${ink.strong} 18%, transparent)`,
    pointerEvents: "auto",
  },
  /** Pencil only: on, but a mode rather than a tool, so a tint and not the tool fill. */
  penModeOn: {
    color: accent.a700,
    backgroundColor: { default: accent.a50, [env.hoverable]: { default: accent.a50, ":hover": accent.a100 } },
  },
  paletteRule: { height: 1, width: 24, flexShrink: 0, marginBlock: space.s1, backgroundColor: neutral.n150 },
  aiPalette: { borderWidth: 1, borderStyle: "solid" },
  shapesGrid: { display: "grid", gridTemplateColumns: "repeat(3, 40px)", gap: space.s1 },
  /** A run of related controls. */
  group: { display: "flex", alignItems: "center", flexShrink: 0 },
  /** The tight runs: tools, and actions. */
  coreGroup: { gap: space.s0_5 },

  /** Undo/redo: quieter than a tool — never filled, never scaled. */
  actionButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    borderWidth: 0,
    borderRadius: radii.pill,
    padding: 0,
    cursor: "pointer",
    opacity: { default: 1, ":disabled": 0.3 },
    pointerEvents: { default: "auto", ":disabled": "none" },
    transitionProperty: "color, background-color",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
  actionCompact: { height: 44, width: 44 },
  actionRegular: { height: space.s8, width: space.s8 },
  actionDanger: {
    color: danger.d500,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": danger.d50 } },
  },
  actionIdle: {
    color: neutral.n500,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
  },

  /** The inline AI launcher. `purple-*` was never in the theme; both gradient
      stops are violet now, as they always rendered as. */
  /** Open: pressed in, on the violet the AI surfaces own. */
  aiOpen: {
    backgroundColor: violet.v100,
    color: violet.v700,
    borderColor: violet.v300,
    boxShadow: `inset 0 2px 4px color-mix(in oklab, ${ink.strong} 5%, transparent)`,
  },
  aiIdle: {
    backgroundImage: {
      default: `linear-gradient(to top right, ${violet.v50}, ${violet.v100})`,
      [env.hoverable]: { default: `linear-gradient(to top right, ${violet.v50}, ${violet.v100})`, ":hover": `linear-gradient(to top right, ${violet.v100}, ${violet.v200})` },
    },
    color: violet.v600,
    borderColor: violet.v200,
  },

  /** The insert trigger's `+`, which becomes an `×` while the menu is open. */
  plusIcon: {
    transitionProperty: "transform",
    transitionDuration: { default: "300ms", [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
  plusOpen: { transform: "rotate(45deg)" },
  plusIdle: { transform: "none" },

  /** Menu rules; geometry only, the rule is `boardDivider.horizontal`. */
  insertRule: { marginBlock: space.s1, marginInline: space.s2 },
  moreRule: { marginBlock: space.s2 },

  tileGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: space.s1,
  },
  /** A tool as a labelled tile, in the phone More menu. */
  compactTile: {
    display: "flex",
    minHeight: space.s16,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s1,
    paddingInline: space.s1,
    borderRadius: radii.control,
    borderWidth: 0,
    fontFamily: "inherit",
    fontSize: "11px",
    fontWeight: weight.medium,
    cursor: "pointer",
    opacity: { default: 1, ":disabled": 0.3 },
    pointerEvents: { default: "auto", ":disabled": "none" },
    transitionProperty: "color, background-color",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
  compactTileActive: { backgroundColor: accent.a800, color: ink.onDark },
  compactTileIdle: {
    color: neutral.n600,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
  },

  menuList: { display: "flex", flexDirection: "column", gap: space.s1 },
  /** A row of the insert menu. */
  dropdownItem: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: space.s3,
    paddingInline: space.s3,
    paddingBlock: space.s2,
    borderRadius: radii.control,
    borderWidth: 0,
    fontFamily: "inherit",
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    textAlign: "left",
    cursor: "pointer",
    color: { default: neutral.n700 },
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
    transitionProperty: "color, background-color",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
  dropdownItemDanger: {
    color: danger.d600,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": danger.d50 } },
  },
  dropdownIconWell: {
    display: "flex",
    height: space.s8,
    width: space.s8,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    borderRadius: radii.control,
    backgroundColor: neutral.n50,
  },
  dropdownIconWellDanger: { backgroundColor: danger.d50 },
  truncate: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },

  /** The AI tile inside the phone More menu. */
  aiTile: {
    display: "flex",
    height: 44,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "0%",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s2,
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    fontFamily: "inherit",
    fontSize: text.xs,
    lineHeight: leading.xs,
    fontWeight: weight.medium,
    cursor: "pointer",
  },
  aiTileOpen: { borderColor: violet.v300, backgroundColor: violet.v100, color: violet.v700 },
  aiTileIdle: { borderColor: violet.v200, backgroundColor: violet.v50, color: violet.v600 },
  tileRow: { display: "flex", alignItems: "center", gap: space.s1 },
});

/**
 * Phones get an annotate-only kit (pen, highlighter, eraser, undo, color);
 * the full shape/text/table tools need a tablet or desktop to be usable.
 */
export function getWhiteboardToolbarVariant(
  compact: boolean,
  phonePortrait: boolean,
): WhiteboardToolbarVariant {
  if (compact && phonePortrait) return "minimal";
  return compact ? "compact" : "regular";
}

function getNextShapeColor(editor: ReturnType<typeof useEditor>) {
  return editor.getInstanceState().stylesForNextShape[
    DefaultColorStyle.id
  ] as TLDefaultColorStyle | undefined;
}

interface ToolColorContextValue {
  currentToolId: string;
  highlightColor: TLDefaultColorStyle | null;
  setToolColor: (value: TLDefaultColorStyle) => void;
}

const ToolColorContext = createContext<ToolColorContextValue | null>(null);

// ─── Unified compact toolbar ─────────────────────────────────────────────────

/** Stable top-edge toolbar. Narrow viewports can scroll it horizontally. */
export const WhiteboardToolbar = track(function WhiteboardToolbar() {
  const editor = useEditor();
  const currentToolId = useValue(
    "current tool",
    () => editor.getCurrentToolId(),
    [editor]
  );
  const {
    pages,
    canEditWhiteboard,
    canManagePages,
    isCompactChrome,
    isPhonePortrait,
    aiEnabled,
    onToggleAi,
    isAiPanelOpen,
    getVisibleViewportCenter,
    uploadFile,
  } = useWhiteboardToolbarContext();

  const variant = getWhiteboardToolbarVariant(
    !!isCompactChrome,
    !!isPhonePortrait,
  );
  const { ref: overflowRef, overflow: toolbarOverflow } =
    useScrollOverflow<HTMLDivElement>();
  const compact = variant !== "regular";
  const minimal = variant === "minimal";
  const [highlightColor, setHighlightColor] =
    useState<TLDefaultColorStyle | null>(DEFAULT_HIGHLIGHT_COLOR);
  const [nonHighlightColor, setNonHighlightColor] =
    useState<TLDefaultColorStyle>("black");
  const [openPanel, setOpenPanel] = useState<ToolbarPanel | null>(null);

  // The text tool is the only way to author math, and `$…$` has no affordance
  // of its own — nothing on the canvas suggests the syntax exists. Say it once,
  // the first time the tool is picked. Repeating it on every switch back to
  // text would be noise for anyone who already knows.
  const showToast = useWhiteboardToast();
  const hasShownMathHint = useRef(false);
  useEffect(() => {
    if (currentToolId !== "text" || hasShownMathHint.current) return;
    hasShownMathHint.current = true;
    showToast({
      variant: "info",
      title: "Type math with $",
      description:
        "Wrap an expression in $…$ for inline math, or $$…$$ for its own line. It renders as soon as you close it.",
    });
  }, [currentToolId, showToast]);

  const nextShapeColor = useValue(
    "next shape color",
    () => getNextShapeColor(editor),
    [editor]
  );

  // A color that changes while the tool stays the same was chosen by the user
  // (under Select too, from the style panel), so it is the one to restore.
  // One that changes with the tool is just the previous tool's leftover.
  const lastColorToolRef = useRef(currentToolId);
  useEffect(() => {
    const toolChanged = lastColorToolRef.current !== currentToolId;
    lastColorToolRef.current = currentToolId;
    if (!nextShapeColor) return;

    if (currentToolId === "highlight") {
      setHighlightColor(nextShapeColor);
      return;
    }

    if (STYLEABLE_TOOL_IDS.has(currentToolId) || !toolChanged) {
      setNonHighlightColor(nextShapeColor);
    }
  }, [currentToolId, nextShapeColor]);

  const setToolColor = useCallback(
    (value: TLDefaultColorStyle) => {
      if (currentToolId === "highlight") {
        setHighlightColor(value);
      } else {
        setNonHighlightColor(value);
      }

      editor.setStyleForNextShapes(DefaultColorStyle, value);
      editor.setStyleForSelectedShapes(DefaultColorStyle, value);
    },
    [currentToolId, editor]
  );

  const handleToolSelect = useCallback(
    (toolId: string) => {
      if (toolId === "eraser") {
        // The only eraser is the ink-only stroke eraser; the destructive
        // native eraser is intentionally not reachable.
        editor.setCurrentTool("stroke-eraser");
        setOpenPanel(null);
        return;
      }

      if (toolId === "table") {
        setOpenPanel(null);
        createTableAtViewportCenter(editor, getVisibleViewportCenter);
        return;
      }

      if (toolId === "code") {
        setOpenPanel(null);
        createCodeShapeAtViewportCenter(editor, getVisibleViewportCenter);
        return;
      }

      const currentColor = getNextShapeColor(editor);

      if (currentToolId === "highlight" && toolId !== "highlight") {
        if (currentColor) {
          setHighlightColor(currentColor);
        }
      }

      if (currentToolId !== "highlight" && toolId === "highlight") {
        if (currentColor) {
          setNonHighlightColor(currentColor);
        }
      }

      if (toolId === "highlight") {
        const nextHighlightColor = highlightColor ?? DEFAULT_HIGHLIGHT_COLOR;
        setHighlightColor(nextHighlightColor);
        editor.setStyleForNextShapes(DefaultColorStyle, nextHighlightColor);
      } else if (STYLEABLE_TOOL_IDS.has(toolId)) {
        editor.setStyleForNextShapes(DefaultColorStyle, nonHighlightColor);
      }

      editor.setCurrentTool(toolId);
      setOpenPanel(null);
    },
    [currentToolId, editor, getVisibleViewportCenter, highlightColor, nonHighlightColor]
  );

  const handlePanelToggle = useCallback(
    (panel: ToolbarPanel) => {
      const willOpen = openPanel !== panel;
      setOpenPanel(willOpen ? panel : null);
      if (willOpen && isAiPanelOpen && onToggleAi) {
        onToggleAi();
      }
    },
    [openPanel, isAiPanelOpen, onToggleAi]
  );

  const closePanels = useCallback(() => {
    setOpenPanel(null);
  }, []);

  const currentGeoType = useValue(
    "current geo type",
    () =>
      (editor.getInstanceState().stylesForNextShape[GeoShapeGeoStyle.id] as
        | TLGeoShapeGeoStyle
        | undefined) ?? "rectangle",
    [editor]
  );

  const handleGeoToolSelect = useCallback(
    (geoType: TLGeoShapeGeoStyle) => {
      if (currentToolId === "highlight") {
        editor.setStyleForNextShapes(DefaultColorStyle, nonHighlightColor);
      }
      editor.setStyleForNextShapes(GeoShapeGeoStyle, geoType);
      editor.setCurrentTool("geo");
      setOpenPanel(null);
    },
    [currentToolId, editor, nonHighlightColor]
  );

  const actions = useActions();
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();

  if (!compact) {
    return (
      <ToolColorContext.Provider value={{ currentToolId, highlightColor, setToolColor }}>
        <WhiteboardToolbarPopoverSide.Provider value="right">
          {/* The lane spans the board's left edge but takes no pointers, so
              the canvas beside the palette still takes the pen. */}
          <div {...stylex.props(styles.paletteLane)}>
            <div
              role="toolbar"
              aria-label="Whiteboard tools"
              aria-orientation="vertical"
              {...stylex.props(styles.palette, layoutStyles.hideScrollbar)}
            >
              {canEditWhiteboard && (
                <>
                  <ToolbarActionButton onClick={() => { void actions["undo"]?.onSelect("toolbar"); }} disabled={!canUndo} label="Undo">
                    <Undo2 size={TOOL_ICON_SIZE} strokeWidth={TOOL_ICON_STROKE} />
                  </ToolbarActionButton>
                  <ToolbarActionButton onClick={() => { void actions["redo"]?.onSelect("toolbar"); }} disabled={!canRedo} label="Redo">
                    <Redo2 size={TOOL_ICON_SIZE} strokeWidth={TOOL_ICON_STROKE} />
                  </ToolbarActionButton>
                  <PaletteRule />
                </>
              )}
              <ToolButton id="select" current={currentToolId} onSelect={handleToolSelect} label="Select" />
              <ToolButton id="draw" current={currentToolId} onSelect={handleToolSelect} label="Draw" />
              <ToolButton id="highlight" current={currentToolId} onSelect={handleToolSelect} label="Highlighter" />
              <ToolButton id="eraser" current={currentToolId} onSelect={handleToolSelect} label="Eraser" />
              <ToolButton id="text" current={currentToolId} onSelect={handleToolSelect} label="Text" />
              <ShapesMenu
                currentToolId={currentToolId}
                currentGeoType={currentGeoType}
                isOpen={openPanel === "shapes"}
                onToggle={() => handlePanelToggle("shapes")}
                onClose={closePanels}
                onGeoSelect={handleGeoToolSelect}
                onToolSelect={handleToolSelect}
              />
              {/* Its own button, not a tile in Shapes: nobody looks for a code
                  runner among rectangles and arrows. */}
              <ToolButton id="code" current={currentToolId} onSelect={handleToolSelect} label="Run code" />
              <ToolButton id="laser" current={currentToolId} onSelect={handleToolSelect} label="Laser pointer" />
              {uploadFile && (
                <ToolButton id="screenshot" current={currentToolId} onSelect={handleToolSelect} label="Snip to image" />
              )}
              <PaletteRule />
              <InsertMenuDropdown
                isOpen={openPanel === "insert"}
                onToggle={() => handlePanelToggle("insert")}
                onClose={closePanels}
              />
              <PropertiesPanelToggle
                isOpen={openPanel === "properties"}
                onToggle={() => handlePanelToggle("properties")}
                onClose={closePanels}
              />
              {canManagePages && pages.length > 0 && (
                <BackgroundPanelToggle
                  isOpen={openPanel === "background"}
                  onToggle={() => handlePanelToggle("background")}
                  onClose={closePanels}
                />
              )}
              {shouldShowInlineWhiteboardAiButton(false, !!aiEnabled, !!onToggleAi) && onToggleAi && (
                <>
                  <PaletteRule />
                  <button
                    type="button"
                    aria-label="Ask Orb"
                    aria-pressed={isAiPanelOpen}
                    title="Ask Orb"
                    onClick={() => {
                      closePanels();
                      onToggleAi();
                    }}
                    {...stylex.props(
                      boardTrigger.base,
                      boardTrigger.regular,
                      styles.aiPalette,
                      isAiPanelOpen ? styles.aiOpen : styles.aiIdle,
                    )}
                  >
                    <BotMessageSquare size={TOOL_ICON_SIZE} strokeWidth={TOOL_ICON_STROKE} />
                  </button>
                </>
              )}
              <PenModeToggle />
            </div>
          </div>
        </WhiteboardToolbarPopoverSide.Provider>
      </ToolColorContext.Provider>
    );
  }

  // Phones: a strip along the top, thumb-sized, with everything past the pen
  // and eraser folded into More — except undo, which a finger reaches for
  // after nearly every stroke. Redo joins it where there is
  // a More menu (the minimal phone kit has neither the room nor the menu).
  return (
    <ToolColorContext.Provider value={{ currentToolId, highlightColor, setToolColor }}>
      <div
        ref={overflowRef}
        {...stylex.props(
          styles.toolbar,
          styles.toolbarFade(toolbarOverflow.start, toolbarOverflow.end),
        )}
        role="toolbar"
        aria-label="Whiteboard tools"
      >
        <div {...stylex.props(styles.content, styles.contentCompact)}>
          {canEditWhiteboard && (
            <div {...stylex.props(styles.group)}>
              <ToolbarActionButton onClick={() => { void actions["undo"]?.onSelect("toolbar"); }} disabled={!canUndo} label="Undo" compact>
                <Undo2 size={TOOL_ICON_SIZE} strokeWidth={TOOL_ICON_STROKE} />
              </ToolbarActionButton>
              {!minimal && (
                <ToolbarActionButton onClick={() => { void actions["redo"]?.onSelect("toolbar"); }} disabled={!canRedo} label="Redo" compact>
                  <Redo2 size={TOOL_ICON_SIZE} strokeWidth={TOOL_ICON_STROKE} />
                </ToolbarActionButton>
              )}
            </div>
          )}

          <div {...stylex.props(styles.group, styles.coreGroup)}>
            {!minimal && <ToolButton id="select" current={currentToolId} onSelect={handleToolSelect} label="Select" compact />}
            <ToolButton id="draw" current={currentToolId} onSelect={handleToolSelect} label="Draw" compact />
            <ToolButton id="highlight" current={currentToolId} onSelect={handleToolSelect} label="Highlighter" compact />
            <ToolButton id="eraser" current={currentToolId} onSelect={handleToolSelect} label="Eraser" compact />
            {!minimal && <ToolButton id="text" current={currentToolId} onSelect={handleToolSelect} label="Text" compact />}
          </div>

          <div {...stylex.props(styles.group, styles.coreGroup)}>
            {!minimal && (
              <CompactMoreMenu
                canEditWhiteboard={canEditWhiteboard}
                canManagePages={!!canManagePages}
                currentGeoType={currentGeoType}
                currentToolId={currentToolId}
                isOpen={openPanel === "insert"}
                onClose={closePanels}
                onGeoSelect={handleGeoToolSelect}
                onToggle={() => handlePanelToggle("insert")}
                onToolSelect={handleToolSelect}
                pages={pages}
              />
            )}
            <PropertiesPanelToggle
              isOpen={openPanel === "properties"}
              onToggle={() => handlePanelToggle("properties")}
              onClose={closePanels}
            />
          </div>
        </div>
      </div>
    </ToolColorContext.Provider>
  );
});

// ─── Table creation helper ───────────────────────────────────────────────────

function createTableAtViewportCenter(
  editor: ReturnType<typeof useEditor>,
  getVisibleViewportCenter?: () => { x: number; y: number } | null,
) {
  const w = DEFAULT_TABLE_WIDTH;
  const h = DEFAULT_TABLE_HEIGHT;
  const center =
    getVisibleViewportCenter?.() ?? editor.getViewportPageBounds().center;

  // Parent the table to whichever page frame contains the viewport center.
  let parentId: TLParentId = editor.getCurrentPageId();
  for (const shape of editor.getCurrentPageShapes()) {
    if (!isPageFrameShape(shape)) continue;
    const frameBounds = editor.getShapePageBounds(shape);
    if (frameBounds?.containsPoint(center)) {
      parentId = shape.id;
      break;
    }
  }

  let x = center.x - w / 2;
  let y = center.y - h / 2;
  if (parentId !== editor.getCurrentPageId()) {
    const parentShape = editor.getShape(parentId);
    if (parentShape) {
      x -= parentShape.x;
      y -= parentShape.y;
    }
  }

  const id = createShapeId();
  editor.createShape({
    id,
    type: TABLE_SHAPE_TYPE,
    parentId,
    x,
    y,
    props: {
      w,
      h,
      headerRow: true,
      cells: Array.from({ length: DEFAULT_TABLE_ROWS }, () =>
        Array.from({ length: DEFAULT_TABLE_COLS }, () => "")
      ),
    },
  });

  editor.setCurrentTool("select");
  editor.setSelectedShapes([id]);
  // Defer entering edit mode until after the shape mounts so the cell
  // input can receive focus reliably.
  queueMicrotask(() => {
    if (editor.getShape(id)) editor.setEditingShape(id);
  });
}

function createCodeShapeAtViewportCenter(
  editor: ReturnType<typeof useEditor>,
  getVisibleViewportCenter?: () => { x: number; y: number } | null,
) {
  const w = DEFAULT_CODE_WIDTH;
  const h = DEFAULT_CODE_HEIGHT;
  const center =
    getVisibleViewportCenter?.() ?? editor.getViewportPageBounds().center;

  let parentId: TLParentId = editor.getCurrentPageId();
  for (const shape of editor.getCurrentPageShapes()) {
    if (!isPageFrameShape(shape)) continue;
    const frameBounds = editor.getShapePageBounds(shape);
    if (frameBounds?.containsPoint(center)) {
      parentId = shape.id;
      break;
    }
  }

  let x = center.x - w / 2;
  let y = center.y - h / 2;
  if (parentId !== editor.getCurrentPageId()) {
    const parentShape = editor.getShape(parentId);
    if (parentShape) {
      x -= parentShape.x;
      y -= parentShape.y;
    }
  }

  const id = createShapeId();
  editor.createShape({
    id,
    type: CODE_SHAPE_TYPE,
    parentId,
    x,
    y,
    props: createCodeShapeProps(),
  });

  editor.setCurrentTool("select");
  editor.setSelectedShapes([id]);
  queueMicrotask(() => {
    if (editor.getShape(id)) editor.setEditingShape(id);
  });
}


// ─── Tool button ─────────────────────────────────────────────────────────────

function ToolButton({
  id,
  current,
  onSelect,
  label,
  compact,
}: {
  id: string;
  current: string;
  onSelect: (id: string) => void;
  label: string;
  compact?: boolean;
}) {
  // The eraser button drives the stroke-eraser tool, so it stays active when
  // that tool is current even though the button's own id is "eraser".
  const isActive =
    current === id || (id === "eraser" && current === "stroke-eraser");
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      {...stylex.props(
        boardTrigger.base,
        compact ? boardTrigger.compact : boardTrigger.regular,
        isActive ? boardTrigger.active : boardTrigger.idle,
      )}
      title={label}
      aria-label={label}
      aria-pressed={isActive}
    >
      <ToolIcon toolId={id} />
    </button>
  );
}

// ─── Geo Tool Button ─────────────────────────────────────────────────────────

function GeoToolButton({
  geoType,
  currentToolId,
  currentGeoType,
  onSelect,
  label,
  compact,
}: {
  geoType: TLGeoShapeGeoStyle;
  currentToolId: string;
  currentGeoType: TLGeoShapeGeoStyle;
  onSelect: (geoType: TLGeoShapeGeoStyle) => void;
  label: string;
  compact?: boolean;
}) {
  const isActive = currentToolId === "geo" && currentGeoType === geoType;
  return (
    <button
      type="button"
      onClick={() => onSelect(geoType)}
      {...stylex.props(
        boardTrigger.base,
        compact ? boardTrigger.compact : boardTrigger.regular,
        isActive ? boardTrigger.active : boardTrigger.idle,
      )}
      title={label}
      aria-label={label}
      aria-pressed={isActive}
    >
      <GeoToolIcon geoType={geoType} />
    </button>
  );
}

function ToolbarActionButton({
  onClick,
  disabled,
  label,
  children,
  variant = "default",
  compact,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  children: React.ReactNode;
  variant?: "default" | "danger";
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      {...stylex.props(
        styles.actionButton,
        compact ? styles.actionCompact : styles.actionRegular,
        variant === "danger" ? styles.actionDanger : styles.actionIdle,
      )}
      title={label}
    >
      {children}
    </button>
  );
}

/**
 * Pencil only, shown where the tools are: tldraw turns it on by itself the
 * moment it sees a stylus, and from then on a finger scrolls instead of
 * drawing. On a regular board that state lives at the foot of the palette,
 * pressed, rather than as a warning pill over the top of the page; pressing
 * it lets fingers draw again.
 */
function PenModeToggle() {
  const editor = useEditor();
  const isPenMode = useValue("isPenMode", () => editor.getInstanceState().isPenMode, [editor]);
  if (!isPenMode) return null;
  return (
    <>
      <PaletteRule />
      <button
        type="button"
        onClick={() => editor.updateInstanceState({ isPenMode: false })}
        aria-pressed
        aria-label="Pencil only: fingers scroll. Let fingers draw"
        title="Pencil only — fingers scroll. Tap to let fingers draw"
        {...stylex.props(boardTrigger.base, boardTrigger.regular, styles.penModeOn)}
      >
        <PencilOff size={TOOL_ICON_SIZE} strokeWidth={TOOL_ICON_STROKE} />
      </button>
    </>
  );
}

function PaletteRule() {
  return <div aria-hidden="true" {...stylex.props(styles.paletteRule)} />;
}

/**
 * Shapes, arrows, tables and code: the tools reached for less often than a
 * pen, behind one trigger that shows whichever of them is in hand.
 */
function ShapesMenu({
  currentToolId,
  currentGeoType,
  isOpen,
  onToggle,
  onClose,
  onGeoSelect,
  onToolSelect,
}: {
  currentToolId: string;
  currentGeoType: TLGeoShapeGeoStyle;
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  onGeoSelect: (geoType: TLGeoShapeGeoStyle) => void;
  onToolSelect: (toolId: string) => void;
}) {
  const inHand = currentToolId === "geo" || currentToolId === "arrow";
  return (
    <WhiteboardToolbarPopover
      label="Shapes"
      isOpen={isOpen}
      onToggle={onToggle}
      onClose={onClose}
      width={152}
      sx={[boardPanel.surface, boardPanel.padSm]}
      trigger={
        <button
          type="button"
          title="Shapes, arrows, tables and code"
          aria-label="Shapes"
          {...stylex.props(
            boardTrigger.base,
            boardTrigger.regular,
            inHand ? boardTrigger.active : isOpen ? boardTrigger.open : boardTrigger.idle,
          )}
        >
          {currentToolId === "geo" ? (
            <GeoToolIcon geoType={currentGeoType} />
          ) : currentToolId === "arrow" ? (
            <ToolIcon toolId="arrow" />
          ) : (
            <Shapes size={TOOL_ICON_SIZE} strokeWidth={TOOL_ICON_STROKE} />
          )}
        </button>
      }
    >
      <div {...stylex.props(styles.shapesGrid)}>
        <GeoToolButton geoType="rectangle" currentToolId={currentToolId} currentGeoType={currentGeoType} onSelect={(geo) => { onGeoSelect(geo); onClose(); }} label="Rectangle" />
        <GeoToolButton geoType="ellipse" currentToolId={currentToolId} currentGeoType={currentGeoType} onSelect={(geo) => { onGeoSelect(geo); onClose(); }} label="Ellipse" />
        <GeoToolButton geoType="diamond" currentToolId={currentToolId} currentGeoType={currentGeoType} onSelect={(geo) => { onGeoSelect(geo); onClose(); }} label="Diamond" />
        <ToolButton id="arrow" current={currentToolId} onSelect={(id) => { onToolSelect(id); onClose(); }} label="Arrow" />
        <ToolButton id="table" current={currentToolId} onSelect={(id) => { onToolSelect(id); onClose(); }} label="Table" />
      </div>
    </WhiteboardToolbarPopover>
  );
}


// ─── Insert menu ─────────────────────────────────────────────────────────────

interface ToolbarPopoverProps {
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
}

function InsertMenuDropdown({ isOpen, onToggle, onClose }: ToolbarPopoverProps) {
  const { pageManager, uploadFile, isCompactChrome, canEditWhiteboard } =
    useWhiteboardToolbarContext();
  const compact = !!isCompactChrome;
  const editor = useEditor();
  const actions = useActions();
  // use per-editor registry instead of module-level globals
  const editorActions = getEditorActions(editor);

  if (!pageManager) return null;

  return (
    <WhiteboardToolbarPopover
      label="Insert"
      isOpen={isOpen}
      onToggle={onToggle}
      onClose={onClose}
      // Wide enough for its longest row, "Paste from clipboard", whole.
      width={256}
      sx={[boardPanel.surface, boardPanel.padSm]}
      trigger={
        <button
          type="button"
          {...stylex.props(
            boardTrigger.base,
            compact ? boardTrigger.compact : boardTrigger.regular,
            isOpen ? boardTrigger.open : boardTrigger.idle,
          )}
          title="Add objects"
          aria-label="Insert"
        >
          <Plus
            size={TOOL_ICON_SIZE}
            strokeWidth={TOOL_ICON_STROKE}
            {...stylex.props(styles.plusIcon, isOpen ? styles.plusOpen : styles.plusIdle)}
          />
        </button>
      }
    >
      {uploadFile && (
        <>
          <DropdownItem icon={<ClipboardPaste size={16} />} label="Paste from clipboard" onClick={() => { editorActions.pasteHandler?.(); onClose(); }} />
          <DropdownItem icon={<Image size={16} />} label="Insert Image" onClick={() => { editorActions.imageInputRef.current?.click(); onClose(); }} />
          {canEditWhiteboard && (
            <DropdownItem icon={<FileText size={16} />} label="Insert PDF" onClick={() => { (editorActions.pdfSourceOpener ?? (() => editorActions.pdfInputRef.current?.click()))(); onClose(); }} />
          )}
        </>
      )}
      {/* Its result — an article or a picture — lands on the page, so it is
          looked up from here rather than from a search box of its own. */}
      <div {...stylex.props(boardDivider.horizontal, styles.insertRule)} />
      <DropdownItem icon={<Copy size={16} />} label="Duplicate Selection" onClick={() => { void actions["duplicate"]?.onSelect("toolbar"); onClose(); }} />
      <DropdownItem icon={<Trash2 size={16} />} label="Delete Selection" onClick={() => { void actions["delete"]?.onSelect("toolbar"); onClose(); }} variant="danger" />
    </WhiteboardToolbarPopover>
  );
}

function CompactMoreMenu({
  canEditWhiteboard,
  canManagePages,
  currentGeoType,
  currentToolId,
  isOpen,
  onClose,
  onGeoSelect,
  onToggle,
  onToolSelect,
  pages,
}: {
  canEditWhiteboard: boolean;
  canManagePages: boolean;
  currentGeoType: TLGeoShapeGeoStyle;
  currentToolId: string;
  isOpen: boolean;
  onClose: () => void;
  onGeoSelect: (geoType: TLGeoShapeGeoStyle) => void;
  onToggle: () => void;
  onToolSelect: (toolId: string) => void;
  pages: Array<unknown>;
}) {
  const editor = useEditor();
  const {
    aiEnabled,
    isAiPanelOpen,
    onToggleAi,
    uploadFile,
  } = useWhiteboardToolbarContext();
  const editorActions = getEditorActions(editor);
  const [backgroundOpen, setBackgroundOpen] = useState(false);

  const run = (action: () => void) => {
    action();
    onClose();
  };

  return (
    <WhiteboardToolbarPopover
      label="More whiteboard tools"
      isOpen={isOpen}
      onToggle={onToggle}
      onClose={() => {
        setBackgroundOpen(false);
        onClose();
      }}
      width={280}
      sx={[boardPanel.surface, boardPanel.padMd]}
      trigger={
        <button
          type="button"
          {...stylex.props(
            boardTrigger.base,
            boardTrigger.compact,
            isOpen ? boardTrigger.open : boardTrigger.idle,
          )}
          // aria-expanded is Base UI's job now, via Popover.Trigger.
          aria-label="More whiteboard tools"
          title="More tools"
        >
          <MoreHorizontal size={TOOL_ICON_SIZE} strokeWidth={TOOL_ICON_STROKE} />
        </button>
      }
    >
      <div {...stylex.props(styles.tileGrid)}>
        <CompactMenuItem
          active={currentToolId === "code"}
          icon={<ToolIcon toolId="code" />}
          label="Run code"
          onClick={() => run(() => onToolSelect("code"))}
        />
        <CompactMenuItem
          active={currentToolId === "arrow"}
          icon={<ToolIcon toolId="arrow" />}
          label="Arrow"
          onClick={() => run(() => onToolSelect("arrow"))}
        />
        <CompactMenuItem
          active={
            currentToolId === "geo" && currentGeoType === "rectangle"
          }
          icon={<GeoToolIcon geoType="rectangle" />}
          label="Rectangle"
          onClick={() => run(() => onGeoSelect("rectangle"))}
        />
        <CompactMenuItem
          active={currentToolId === "table"}
          icon={<ToolIcon toolId="table" />}
          label="Table"
          onClick={() => run(() => onToolSelect("table"))}
        />
        <CompactMenuItem
          active={currentToolId === "laser"}
          icon={<ToolIcon toolId="laser" />}
          label="Laser"
          onClick={() => run(() => onToolSelect("laser"))}
        />
      </div>

      <div {...stylex.props(boardDivider.horizontal, styles.moreRule)} />

      <div {...stylex.props(styles.menuList)}>
        {uploadFile && (
          <>
            <DropdownItem
              icon={<ClipboardPaste size={16} />}
              label="Paste from clipboard"
              onClick={() =>
                run(() => {
                  editorActions.pasteHandler?.();
                })
              }
            />
            <DropdownItem
              icon={<Image size={16} />}
              label="Insert image"
              onClick={() =>
                run(() => {
                  editorActions.imageInputRef.current?.click();
                })
              }
            />
          </>
        )}
        {uploadFile && canEditWhiteboard && (
          <DropdownItem
            icon={<FileText size={16} />}
            label="Insert PDF"
            onClick={() =>
              run(() => {
                (editorActions.pdfSourceOpener
                  ?? (() => editorActions.pdfInputRef.current?.click()))();
              })
            }
          />
        )}
      </div>

      {(canManagePages && pages.length > 0) ||
      (aiEnabled && onToggleAi) ? (
        <>
          <div {...stylex.props(boardDivider.horizontal, styles.moreRule)} />
          <div {...stylex.props(styles.tileRow)}>
            {canManagePages && pages.length > 0 && (
              <BackgroundPanelToggle
                isOpen={backgroundOpen}
                onToggle={() => setBackgroundOpen((value) => !value)}
                onClose={() => setBackgroundOpen(false)}
              />
            )}
            {aiEnabled && onToggleAi && (
              <button
                type="button"
                onClick={() =>
                  run(() => {
                    onToggleAi();
                  })
                }
                {...stylex.props(
                  styles.aiTile,
                  isAiPanelOpen ? styles.aiTileOpen : styles.aiTileIdle,
                )}
                aria-pressed={isAiPanelOpen}
              >
                <BotMessageSquare size={16} />
                Ask Orb
              </button>
            )}
          </div>
        </>
      ) : null}
    </WhiteboardToolbarPopover>
  );
}

function CompactMenuItem({
  active = false,
  disabled = false,
  icon,
  label,
  onClick,
}: {
  active?: boolean;
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      {...stylex.props(
        styles.compactTile,
        active ? styles.compactTileActive : styles.compactTileIdle,
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function DropdownItem({ icon, label, onClick, variant = "default" }: { icon: React.ReactNode, label: string, onClick: () => void, variant?: "default" | "danger" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      {...stylex.props(
        styles.dropdownItem,
        variant === "danger" && styles.dropdownItemDanger,
      )}
    >
      <div
        {...stylex.props(
          styles.dropdownIconWell,
          variant === "danger" && styles.dropdownIconWellDanger,
        )}
      >
        {icon}
      </div>
      <span {...stylex.props(styles.truncate)}>{label}</span>
    </button>
  );
}
