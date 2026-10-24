import { useEditor, useValue } from "tldraw";
import { X, LayoutGrid } from "lucide-react";
import { accent, border, neutral } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { duration, easing } from "@orbmeet/ui/tokens/motion.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { boardPanel, boardPanelHeader, boardTrigger } from "../styles/board";
import {
  PAGE_BACKGROUND_OPTIONS,
  parsePageBackground,
  type PageBackground,
} from "@orbmeet/whiteboard-core/page-background";
import { getBackgroundStyle } from "../shapes/page/page-background-rendering";
import {
  getPageFrameBackground,
  isPageFrameShape,
} from "@orbmeet/whiteboard-core/page-frame-model";
import { useWhiteboardToolbarContext } from "./whiteboard-toolbar-context";
import {
  TOOL_ICON_SIZE,
  TOOL_ICON_STROKE,
} from "./whiteboard-toolbar-icons";
import { Popover } from "@base-ui/react/popover";
import { WhiteboardToolbarPopover } from "./whiteboard-toolbar-popover";

interface ToolbarPopoverProps {
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
}

const styles = stylex.create({
  headerPad: { paddingInline: space.s3, paddingBlock: space.s2 },
  /** Popover.Close, not a bare button: the escape hatch a touch screen reader
      needs out of the dialog — see the note at its call site. */
  close: {
    display: "flex",
    height: space.s6,
    width: space.s6,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 0,
    borderRadius: radii.field,
    padding: 0,
    color: { default: neutral.n400, [env.hoverable]: { default: neutral.n400, ":hover": neutral.n600 } },
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
    cursor: "pointer",
    transitionProperty: "color, background-color",
    transitionDuration: { default: duration.instant, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
  grid: {
    padding: space.s2_5,
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: space.s1_5,
  },
  /** A background choice: a preview of the page plus its name. */
  option: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.s1,
    padding: space.s1_5,
    borderWidth: 2,
    borderStyle: "solid",
    borderRadius: radii.control,
    cursor: "pointer",
    transitionProperty: "transform, border-color, box-shadow",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
  optionActive: {
    borderColor: accent.a800,
    boxShadow: shadows.hairline,
    transform: "scale(1.05)",
  },
  optionIdle: { borderColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n300 } } },
  thumb: {
    width: "100%",
    aspectRatio: "4 / 3",
    overflow: "hidden",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: `color-mix(in oklab, ${border.base} 60%, transparent)`,
    borderRadius: radii.field,
  },
  optionLabel: {
    width: "100%",
    textAlign: "center",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.xs3,
    lineHeight: leading.xs3,
    fontWeight: weight.medium,
    color: neutral.n600,
  },
});

export function BackgroundPanelToggle({ isOpen, onToggle, onClose }: ToolbarPopoverProps) {
  const editor = useEditor();
  const { pages, currentPage, isCompactChrome } =
    useWhiteboardToolbarContext();
  const compact = !!isCompactChrome;

  const currentBg = useValue(
    "currentPageBg",
    () => {
      const pageData = pages.find((p) => p.number === currentPage);
      if (!pageData) return "white";
      const shape = editor.getShape(pageData.id);
      if (!shape) return "white";
      return isPageFrameShape(shape)
        ? parsePageBackground(getPageFrameBackground(shape))
        : "white";
    },
    [editor, pages, currentPage]
  );

  const setBackground = (bg: PageBackground) => {
    const pageData = pages.find((p) => p.number === currentPage);
    if (!pageData) return;
    const shape = editor.getShape(pageData.id);
    if (!shape || !isPageFrameShape(shape)) return;
    editor.updateShape({
      id: pageData.id,
      type: shape.type,
      props: { background: bg },
    });
  };

  return (
    <WhiteboardToolbarPopover
      label="Page background"
      isOpen={isOpen}
      onToggle={onToggle}
      onClose={onClose}
      width={220}
      sx={boardPanel.surface}
      trigger={
        <button
          type="button"
          {...stylex.props(
            boardTrigger.base,
            compact ? boardTrigger.compact : boardTrigger.regular,
            isOpen ? boardTrigger.open : boardTrigger.idle,
          )}
          title={isOpen ? "Close background picker" : "Page background"}
          aria-label={isOpen ? "Close background picker" : "Page background"}
        >
          {isOpen ? (
            <X size={TOOL_ICON_SIZE} strokeWidth={TOOL_ICON_STROKE} />
          ) : (
            <LayoutGrid size={TOOL_ICON_SIZE} strokeWidth={TOOL_ICON_STROKE} />
          )}
        </button>
      }
    >
      <div {...stylex.props(boardPanelHeader.strip, styles.headerPad)}>
        <span {...stylex.props(boardPanelHeader.title)}>Page Background</span>
        {/* Popover.Close, not a bare button: it is also the escape hatch a
            touch screen reader needs out of a role="dialog". */}
        <Popover.Close
          {...stylex.props(styles.close)}
          aria-label="Close background picker"
        >
          <X size={14} />
        </Popover.Close>
      </div>

      <div {...stylex.props(styles.grid)}>
        {PAGE_BACKGROUND_OPTIONS.map((opt) => {
          const isActive = currentBg === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => setBackground(opt.value)}
              {...stylex.props(
                styles.option,
                isActive ? styles.optionActive : styles.optionIdle,
              )}
              title={opt.label}
            >
              {/* Mini preview thumbnail */}
              <div {...stylex.props(styles.thumb)}>
                <div
                  style={{
                    width: "100%",
                    height: "100%",
                    ...getBackgroundStyle(opt.value, 0.35),
                  }}
                />
              </div>
              <span {...stylex.props(styles.optionLabel)}>
                {opt.label}
              </span>
            </button>
          );
        })}
      </div>
    </WhiteboardToolbarPopover>
  );
}
