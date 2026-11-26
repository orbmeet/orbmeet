import type {
  Editor,
  StyleProp,
  TLDefaultColorStyle,
  TLDefaultFillStyle,
  TLDefaultDashStyle,
  TLDefaultSizeStyle,
} from "tldraw";
import {
  DEFAULT_THEME,
  DefaultColorStyle,
  DefaultFillStyle,
  DefaultDashStyle,
  DefaultSizeStyle,
  getColorValue,
  useEditor,
  useValue,
  useActions,
  track,
} from "tldraw";
import { accent, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { duration, easing } from "@orbmeet/ui/tokens/motion.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, tracking, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { boardDivider, boardPanel, boardPanelHeader, boardTrigger } from "../styles/board";
import { useWhiteboardToolbarContext } from "./whiteboard-toolbar-context";
import { StyleToolIcon } from "./whiteboard-toolbar-icons";
import { WhiteboardToolbarPopover } from "./whiteboard-toolbar-popover";

interface ToolbarPopoverProps {
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
}

const LIGHT_COLOR_THEME = DEFAULT_THEME.colors.light;

function swatchColor(value: TLDefaultColorStyle): string {
  return getColorValue(LIGHT_COLOR_THEME, value, "solid");
}

function useSharedStyle<T>(editor: Editor, style: StyleProp<T>): T | undefined {
  return useValue(
    `sharedStyle:${style.id}`,
    () => {
      const shared = editor.getSharedStyles().get(style);
      if (shared?.type === "shared") return shared.value;
      return editor.getInstanceState().stylesForNextShape[style.id] as T | undefined;
    },
    [editor, style],
  );
}

const SWATCH_COLORS: readonly TLDefaultColorStyle[] = [
  "black",
  "red",
  "blue",
  "green",
  "yellow",
  "orange",
  "violet",
  "grey",
  "light-blue",
  "light-green",
];

const styles = stylex.create({
  headerPad: { paddingInline: space.s3, paddingBlock: space.s2 },
  body: {
    padding: space.s3,
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
  },

  /**
   * One choice among a small set — fill, dash, size, opacity, layer order.
   * Every one of these was a separate class string that had drifted between
   * two radii; they are one control with one shape now.
   */
  option: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderStyle: "solid",
    borderRadius: radii.control,
    fontFamily: "inherit",
    cursor: "pointer",
    transitionProperty: "background-color, color, border-color",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
  /** A labelled row button ("None / Semi / Solid"). */
  optionFill: { height: space.s8, flexGrow: 1, flexShrink: 1, flexBasis: "0%", gap: space.s1_5 },
  /** A plain tile (dash, size, opacity, layer order). */
  optionTile: { height: space.s7, flexGrow: 1, flexShrink: 1, flexBasis: "0%" },
  optionActive: {
    backgroundColor: accent.a800,
    borderColor: accent.a800,
    color: ink.onDark,
    boxShadow: shadows.hairline,
  },
  optionIdle: {
    backgroundColor: { default: neutral.n100, [env.hoverable]: { default: neutral.n100, ":hover": neutral.n200 } },
    borderColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n300 } },
    color: neutral.n700,
  },
  optionLabel: {
    fontSize: text.xs2,
    lineHeight: leading.xs2,
    fontWeight: weight.medium,
  },

  swatchRow: { display: "flex", flexWrap: "wrap", gap: space.s1_5 },
  fillRow: { display: "flex", gap: space.s1 },
  opacityRow: { display: "flex", gap: space.s1_5 },
  twoCol: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.s3,
  },

  sectionLabel: {
    marginBottom: space.s1_5,
    paddingInline: space.s0_5,
    fontSize: text.xs2,
    lineHeight: leading.xs2,
    fontWeight: weight.semibold,
    textTransform: "uppercase",
    letterSpacing: tracking.wider,
    color: neutral.n400,
  },

  /** The stroke-colour dot itself. The colour is tldraw's, so it stays dynamic. */
  swatch: (color: string) => ({
    width: 16,
    height: 16,
    flexShrink: 0,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderStyle: "solid",
    backgroundColor: color,
    cursor: "pointer",
    transitionProperty: "transform, box-shadow",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  }),
  swatchActive: {
    transform: "scale(1.25)",
    // A hairline lift plus the old `ring-1 ring-offset-1 ring-accent-800/40`,
    // flattened into one shadow: 1px of white, then the accent ring.
    boxShadow: `${shadows.hairline}, 0 0 0 1px ${surface.raised}, 0 0 0 2px color-mix(in oklab, ${accent.a800} 40%, transparent)`,
  },
  swatchIdle: {
    transform: { default: "none", [env.hoverable]: { default: "none", ":hover": "scale(1.1)" } },
    boxShadow: shadows.hairline,
  },
  /** White needs an edge to be visible on the panel; the rest do not. */
  swatchWhite: { borderColor: neutral.n300 },
  swatchClear: { borderColor: "transparent" },

  sizeDot: (px: number) => ({
    width: px,
    height: px,
    borderRadius: radii.pill,
    backgroundColor: "currentColor",
  }),
});

export const PropertiesPanelToggle = track(function PropertiesPanelToggle({
  isOpen,
  onToggle,
  onClose,
}: ToolbarPopoverProps) {
  const editor = useEditor();
  const { isCompactChrome } = useWhiteboardToolbarContext();
  const compact = !!isCompactChrome;

  const currentColor = useSharedStyle(editor, DefaultColorStyle);
  const currentFill = useSharedStyle(editor, DefaultFillStyle);
  const currentDash = useSharedStyle(editor, DefaultDashStyle);
  const currentSize = useSharedStyle(editor, DefaultSizeStyle);

  const hasSelected = useValue("hasSelected", () => editor.getSelectedShapes().length > 0, [editor]);
  const actions = useActions();

  const applyStyle = <T,>(style: StyleProp<T>, value: T) => {
    editor.setStyleForNextShapes(style, value);
    editor.setStyleForSelectedShapes(style, value);
  };

  const dotColor = swatchColor(currentColor ?? "black");

  return (
    <WhiteboardToolbarPopover
      label="Shape properties"
      isOpen={isOpen}
      onToggle={onToggle}
      onClose={onClose}
      width={compact ? 260 : 240}
      sx={boardPanel.surface}
      trigger={
        <button
          type="button"
          {...stylex.props(
            boardTrigger.base,
            compact ? boardTrigger.compact : boardTrigger.regular,
            isOpen ? boardTrigger.open : boardTrigger.idle,
          )}
          title="Style"
          aria-label="Style"
        >
          <StyleToolIcon color={dotColor} />
        </button>
      }
    >
      <div {...stylex.props(boardPanelHeader.strip, styles.headerPad)}>
        <span {...stylex.props(boardPanelHeader.title)}>Properties</span>
      </div>
      <div {...stylex.props(styles.body)}>
        {/* Stroke color */}
        <PropertiesSection label="Stroke">
          <div {...stylex.props(styles.swatchRow)}>
            {SWATCH_COLORS.map((c) => (
              <PanelColorSwatch
                key={c}
                value={c}
                active={currentColor === c}
                onSelect={() => applyStyle(DefaultColorStyle, c)}
              />
            ))}
          </div>
        </PropertiesSection>

        <div {...stylex.props(boardDivider.horizontal)} />

        {/* Fill */}
        <PropertiesSection label="Fill">
          <div {...stylex.props(styles.fillRow)}>
            <FillOption value="none" label="None" active={currentFill === "none"} onSelect={() => applyStyle(DefaultFillStyle, "none")} />
            <FillOption value="semi" label="Semi" active={currentFill === "semi"} onSelect={() => applyStyle(DefaultFillStyle, "semi")} />
            <FillOption value="solid" label="Solid" active={currentFill === "solid"} onSelect={() => applyStyle(DefaultFillStyle, "solid")} />
          </div>
        </PropertiesSection>

        <div {...stylex.props(boardDivider.horizontal)} />

        <div {...stylex.props(styles.twoCol)}>
          {/* Stroke style */}
          <PropertiesSection label="Style">
            <div {...stylex.props(styles.fillRow)}>
              <DashOption value="draw" active={currentDash === "draw"} onSelect={() => applyStyle(DefaultDashStyle, "draw")} />
              <DashOption value="dashed" active={currentDash === "dashed"} onSelect={() => applyStyle(DefaultDashStyle, "dashed")} />
              <DashOption value="dotted" active={currentDash === "dotted"} onSelect={() => applyStyle(DefaultDashStyle, "dotted")} />
            </div>
          </PropertiesSection>

          {/* Stroke width */}
          <PropertiesSection label="Width">
            <div {...stylex.props(styles.fillRow)}>
              <SizeOption value="s" active={currentSize === "s"} onSelect={() => applyStyle(DefaultSizeStyle, "s")} />
              <SizeOption value="m" active={currentSize === "m"} onSelect={() => applyStyle(DefaultSizeStyle, "m")} />
              <SizeOption value="l" active={currentSize === "l"} onSelect={() => applyStyle(DefaultSizeStyle, "l")} />
              <SizeOption value="xl" active={currentSize === "xl"} onSelect={() => applyStyle(DefaultSizeStyle, "xl")} />
            </div>
          </PropertiesSection>
        </div>

        <div {...stylex.props(boardDivider.horizontal)} />

        {/* Opacity */}
        <PropertiesSection label="Opacity">
          <OpacitySlider />
        </PropertiesSection>

        {/* Layers — only when shapes selected */}
        {hasSelected && (
          <>
            <div {...stylex.props(boardDivider.horizontal)} />
            <PropertiesSection label="Layers">
              <div {...stylex.props(styles.fillRow)}>
                {[
                  { id: "send-to-back", title: "Send to back", icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 11 12 6 7 11" /><polyline points="17 18 12 13 7 18" /></svg> },
                  { id: "send-backward", title: "Send backward", icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 15 12 10 7 15" /></svg> },
                  { id: "bring-forward", title: "Bring forward", icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 9 12 14 7 9" /></svg> },
                  { id: "bring-to-front", title: "Bring to front", icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 6 12 11 7 6" /><polyline points="17 13 12 18 7 13" /></svg> },
                ].map(({ id, title, icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      void actions[id]?.onSelect("toolbar");
                    }}
                    {...stylex.props(styles.option, styles.optionTile, styles.optionIdle)}
                    title={title}
                  >
                    {icon}
                  </button>
                ))}
              </div>
            </PropertiesSection>
          </>
        )}
      </div>
    </WhiteboardToolbarPopover>
  );
});

function OpacitySlider() {
  const editor = useEditor();
  const opacity = useValue("opacity", () => {
    const shared = editor.getSharedOpacity();
    if (shared.type === "shared") return shared.value;
    return editor.getInstanceState().opacityForNextShape;
  }, [editor]);

  const opacities = [
    { value: 0.1, label: "10%" },
    { value: 0.25, label: "25%" },
    { value: 0.5, label: "50%" },
    { value: 0.75, label: "75%" },
    { value: 1, label: "100%" },
  ];

  return (
    <div {...stylex.props(styles.opacityRow)}>
      {opacities.map((op) => (
        <button
          key={op.value}
          type="button"
          onClick={() => {
            editor.setOpacityForNextShapes(op.value);
            editor.setOpacityForSelectedShapes(op.value);
          }}
          {...stylex.props(
            styles.option,
            styles.optionTile,
            styles.optionLabel,
            Math.abs(opacity - op.value) < 0.01 ? styles.optionActive : styles.optionIdle,
          )}
          title={op.label}
        >
          {op.value * 100}%
        </button>
      ))}
    </div>
  );
}

const FILL_ICONS: Partial<Record<TLDefaultFillStyle, React.ReactNode>> = {
  none: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2" width="12" height="12" rx="2" strokeDasharray="2 2" />
    </svg>
  ),
  semi: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2" width="12" height="12" rx="2" fill="currentColor" fillOpacity="0.3" />
    </svg>
  ),
  solid: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  ),
};

function FillOption({
  value,
  label,
  active,
  onSelect,
}: {
  value: TLDefaultFillStyle;
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      {...stylex.props(
        styles.option,
        styles.optionFill,
        styles.optionLabel,
        active ? styles.optionActive : styles.optionIdle,
      )}
      title={label}
    >
      {FILL_ICONS[value]}
      <span {...stylex.props(styles.optionLabel)}>{label}</span>
    </button>
  );
}

const DASH_ICONS: Partial<Record<TLDefaultDashStyle, React.ReactNode>> = {
  draw: (
    <svg width="24" height="8" viewBox="0 0 24 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="0" y1="4" x2="24" y2="4" />
    </svg>
  ),
  dashed: (
    <svg width="24" height="8" viewBox="0 0 24 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="0" y1="4" x2="8" y2="4" />
      <line x1="16" y1="4" x2="24" y2="4" />
    </svg>
  ),
  dotted: (
    <svg width="24" height="8" viewBox="0 0 24 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="4" cy="4" r="1.5" fill="currentColor" />
      <circle cx="12" cy="4" r="1.5" fill="currentColor" />
      <circle cx="20" cy="4" r="1.5" fill="currentColor" />
    </svg>
  ),
};

function DashOption({
  value,
  active,
  onSelect,
}: {
  value: TLDefaultDashStyle;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      {...stylex.props(
        styles.option,
        styles.optionFill,
        active ? styles.optionActive : styles.optionIdle,
      )}
      title={value}
      aria-label={`Set line style to ${value}`}
    >
      {DASH_ICONS[value]}
    </button>
  );
}

const SIZE_DOTS: Record<TLDefaultSizeStyle, number> = {
  s: 3,
  m: 5,
  l: 7,
  xl: 9,
};

function SizeOption({
  value,
  active,
  onSelect,
}: {
  value: TLDefaultSizeStyle;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      {...stylex.props(
        styles.option,
        styles.optionFill,
        active ? styles.optionActive : styles.optionIdle,
      )}
      title={value}
      aria-label={`Set drawing size to ${value}`}
    >
      <div {...stylex.props(styles.sizeDot(SIZE_DOTS[value] || 5))} />
    </button>
  );
}

function PropertiesSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div {...stylex.props(styles.sectionLabel)}>{label}</div>
      {children}
    </div>
  );
}

function PanelColorSwatch({
  value,
  active,
  onSelect,
}: {
  value: TLDefaultColorStyle;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      {...stylex.props(
        styles.swatch(swatchColor(value)),
        active ? styles.swatchActive : styles.swatchIdle,
        value === "white" ? styles.swatchWhite : styles.swatchClear,
      )}
      title={value}
      aria-label={`Color: ${value}`}
    />
  );
}
